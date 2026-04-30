import Anthropic from "@anthropic-ai/sdk";
import type { TestCase, ActionPlan, ActionResult } from "../types.js";

const PLANNER_SYSTEM_PROMPT = `You are an expert QA tester driving a Playwright browser to execute test cases on a web application.

Your job is to translate human-readable test steps into a precise sequence of browser actions.

## Available Actions

- **navigate**: Go to a URL. Target is the full URL.
- **click**: Click an element. Target is a CSS selector or Playwright locator string.
- **type**: Type text into an input. Target is the selector, value is the text.
- **scroll**: Scroll the page. Value is pixels to scroll (positive = down).
- **hover**: Hover over an element. Target is the selector.
- **wait**: Wait for a duration. Value is milliseconds (default 2000).
- **screenshot**: Take a screenshot of the current page state.
- **select**: Select an option from a dropdown. Target is the dropdown selector, value is the option text.
- **press_key**: Press a keyboard key. Value is the key name (e.g. "Enter", "Escape", "Tab").

## Selector Strategy

Prefer robust selectors in this order:
1. \`[data-testid="..."]\` — most stable
2. \`[aria-label="..."]\` or \`role=button[name="..."]\`
3. \`text=Visible Text\` — Playwright text selector
4. \`placeholder=...\` — for inputs
5. Semantic HTML selectors (\`button\`, \`a[href="..."]\`, \`input[type="..."]\`)
6. Class-based selectors as last resort

Avoid fragile selectors like nth-child or deeply nested class chains.

## Important Notes

- The application is a React SPA. After navigation or clicks that trigger route changes, include a \`wait\` action (1000-2000ms) to let the page render.
- Always include a \`screenshot\` action at the end to capture the final state.
- Include \`screenshot\` actions at meaningful intermediate checkpoints too.
- Set \`screenshotAfter: true\` on actions where you want automatic post-action screenshots.
- If test steps reference URL patterns like \`/recruit/users/:userId\`, use the provided base URL and any context to construct real URLs.
- For actions that open modals or dropdowns, add a short \`wait\` (500-1000ms) after the click.`;

const PLAN_TOOL: Anthropic.Tool = {
  name: "plan_browser_actions",
  description:
    "Plan a sequence of browser actions to execute a QA test case.",
  input_schema: {
    type: "object" as const,
    properties: {
      reasoning: {
        type: "string",
        description:
          "Explain your strategy: how you will navigate, what selectors you expect, and why.",
      },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            order: { type: "number", description: "Sequential step number starting at 1" },
            type: {
              type: "string",
              enum: [
                "navigate",
                "click",
                "type",
                "scroll",
                "hover",
                "wait",
                "screenshot",
                "select",
                "press_key",
              ],
            },
            target: {
              type: "string",
              description:
                "CSS selector, Playwright locator, or URL depending on action type.",
            },
            value: {
              type: "string",
              description:
                "Text to type, scroll amount, wait duration, key name, or option text.",
            },
            description: {
              type: "string",
              description: "Human-readable description of what this action does.",
            },
            screenshotAfter: {
              type: "boolean",
              description: "Whether to capture a screenshot after this action.",
            },
          },
          required: ["order", "type", "description", "screenshotAfter"],
        },
      },
    },
    required: ["reasoning", "actions"],
  },
};

export class ActionPlanner {
  private anthropic: Anthropic;
  private model: string;
  private baseUrl: string;

  constructor(anthropic: Anthropic, model: string, baseUrl: string) {
    this.anthropic = anthropic;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async planActions(
    testCase: TestCase,
    currentUrl?: string,
    currentScreenshot?: Buffer
  ): Promise<ActionPlan> {
    const content: Anthropic.MessageCreateParams["messages"][0]["content"] = [];

    let userText = `## Test Case: ${testCase.id} — ${testCase.description}

## Steps to Test:
${testCase.steps.map((s) => `${s.order}. ${s.instruction}`).join("\n")}

## Expected Result:
${testCase.expectedResult}

## Environment:
- Base URL: ${this.baseUrl}
${currentUrl ? `- Current page: ${currentUrl}` : "- Browser is at a blank page"}

Plan the browser actions needed to execute this test case. Make sure the final action is a screenshot.`;

    if (currentScreenshot) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: currentScreenshot.toString("base64"),
        },
      });
      userText =
        "Here is a screenshot of the current browser state.\n\n" + userText;
    }

    content.push({ type: "text", text: userText });

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: PLANNER_SYSTEM_PROMPT,
      tools: [PLAN_TOOL],
      tool_choice: { type: "tool", name: "plan_browser_actions" },
      messages: [{ role: "user", content }],
    });

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (!toolBlock) {
      throw new Error("Planner did not return a tool use block");
    }

    const input = toolBlock.input as {
      reasoning: string;
      actions: Array<{
        order: number;
        type: string;
        target?: string;
        value?: string;
        description: string;
        screenshotAfter: boolean;
      }>;
    };

    return {
      testCaseId: testCase.id,
      reasoning: input.reasoning,
      actions: input.actions.map((a) => ({
        order: a.order,
        type: a.type as ActionPlan["actions"][0]["type"],
        target: a.target,
        value: a.value,
        description: a.description,
        screenshotAfter: a.screenshotAfter ?? false,
      })),
    };
  }

  async replanAfterFailure(
    testCase: TestCase,
    completedActions: ActionResult[],
    error: string,
    screenshot?: Buffer
  ): Promise<ActionPlan> {
    const content: Anthropic.MessageCreateParams["messages"][0]["content"] = [];

    if (screenshot) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: screenshot.toString("base64"),
        },
      });
    }

    const completedSummary = completedActions
      .map(
        (r) =>
          `Step ${r.action.order}: ${r.action.description} — ${r.success ? "OK" : "FAILED: " + r.error}`
      )
      .join("\n");

    content.push({
      type: "text",
      text: `## Test Case: ${testCase.id} — ${testCase.description}

## Original Steps:
${testCase.steps.map((s) => `${s.order}. ${s.instruction}`).join("\n")}

## Expected Result:
${testCase.expectedResult}

## What happened so far:
${completedSummary}

## Error encountered:
${error}

## Environment:
- Base URL: ${this.baseUrl}

The previous action plan failed. Please create a corrective plan to recover and continue testing.
Consider that:
- The failed action's selector may need to change (the element might have a different structure than expected)
- A modal, popup, or loading state might be blocking interaction
- The page might have navigated to an unexpected URL

Plan the remaining browser actions needed to complete this test case. Start from the current page state shown in the screenshot.`,
    });

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: PLANNER_SYSTEM_PROMPT,
      tools: [PLAN_TOOL],
      tool_choice: { type: "tool", name: "plan_browser_actions" },
      messages: [{ role: "user", content }],
    });

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (!toolBlock) {
      throw new Error("Planner did not return a tool use block during replan");
    }

    const input = toolBlock.input as {
      reasoning: string;
      actions: Array<{
        order: number;
        type: string;
        target?: string;
        value?: string;
        description: string;
        screenshotAfter: boolean;
      }>;
    };

    const lastOrder =
      completedActions.length > 0
        ? completedActions[completedActions.length - 1].action.order
        : 0;

    return {
      testCaseId: testCase.id,
      reasoning: input.reasoning,
      actions: input.actions.map((a, i) => ({
        order: lastOrder + i + 1,
        type: a.type as ActionPlan["actions"][0]["type"],
        target: a.target,
        value: a.value,
        description: a.description,
        screenshotAfter: a.screenshotAfter ?? false,
      })),
    };
  }
}
