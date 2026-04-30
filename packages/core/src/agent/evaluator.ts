import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import type {
  TestCase,
  ExecutionResult,
  Evaluation,
  Issue,
} from "../types.js";

const EVALUATOR_SYSTEM_PROMPT = `You are a QA evaluator reviewing screenshots from automated browser testing.

Your job is to compare what is visible in the provided screenshots against the expected test results and determine whether the test passed, failed, or partially passed.

## Evaluation Guidelines

- **pass**: All expected results are clearly visible and correct in the screenshots.
- **fail**: One or more expected results are clearly NOT met. Something is wrong, missing, or broken.
- **partial**: Some expected results are met but others are not, or the evidence is ambiguous.
- **blocked**: The test could not be completed — e.g. error page, login redirect, or the page failed to load.

## What to look for

- Focus on **functional correctness**, not pixel-perfect styling.
- Check that expected UI elements are present (buttons, tabs, sections, text content).
- Verify data correctness where visible (names, dates, statuses, counts).
- Note any error messages, broken layouts, missing content, or unexpected states.
- If console errors were captured during execution, factor those into your assessment.

## Confidence Rating

Rate your confidence from 0 to 1:
- 1.0: The screenshots clearly and unambiguously show the outcome.
- 0.7-0.9: Most evidence is clear but some aspects are hard to verify from screenshots alone.
- 0.5-0.7: The evidence is ambiguous or the screenshots don't fully capture the expected state.
- Below 0.5: Very uncertain — the screenshots may not show the relevant parts of the page.`;

const EVALUATE_TOOL: Anthropic.Tool = {
  name: "evaluate_test_result",
  description:
    "Evaluate whether a QA test case passed or failed based on screenshots.",
  input_schema: {
    type: "object" as const,
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "fail", "partial", "blocked"],
        description: "The overall test verdict.",
      },
      confidence: {
        type: "number",
        description: "Confidence in the verdict from 0 to 1.",
      },
      reasoning: {
        type: "string",
        description:
          "Detailed explanation of why you reached this verdict. Reference specific things you see in the screenshots.",
      },
      issues: {
        type: "array",
        description: "List of specific issues found, if any.",
        items: {
          type: "object",
          properties: {
            severity: {
              type: "string",
              enum: ["critical", "major", "minor", "cosmetic"],
            },
            description: {
              type: "string",
              description: "What the issue is and where it appears.",
            },
          },
          required: ["severity", "description"],
        },
      },
    },
    required: ["verdict", "confidence", "reasoning", "issues"],
  },
};

export class TestEvaluator {
  private anthropic: Anthropic;
  private model: string;

  constructor(anthropic: Anthropic, model: string) {
    this.anthropic = anthropic;
    this.model = model;
  }

  async evaluate(
    testCase: TestCase,
    execution: ExecutionResult
  ): Promise<Evaluation> {
    if (execution.screenshots.length === 0) {
      return {
        testCaseId: testCase.id,
        verdict: "blocked",
        confidence: 1.0,
        reasoning:
          "No screenshots were captured during execution. Cannot evaluate.",
        issues: [
          {
            severity: "critical",
            description: "Test execution produced no screenshots.",
          },
        ],
        screenshotsUsed: [],
      };
    }

    const content: Anthropic.MessageCreateParams["messages"][0]["content"] = [];

    // Pick the most relevant screenshots: first, last, and any error screenshots.
    // Limit to 5 to control token usage.
    const screenshotsToSend = this.selectScreenshots(execution);

    for (const sc of screenshotsToSend) {
      let imageData: Buffer;
      if (sc.buffer) {
        imageData = sc.buffer;
      } else {
        imageData = await readFile(sc.path);
      }

      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: imageData.toString("base64"),
        },
      });
      content.push({
        type: "text",
        text: `Screenshot after step ${sc.afterAction}: ${sc.description}`,
      });
    }

    let contextText = `## Test Case: ${testCase.id} — ${testCase.description}

## Steps Executed:
${testCase.steps.map((s) => `${s.order}. ${s.instruction}`).join("\n")}

## Expected Result:
${testCase.expectedResult}

## Execution Summary:
- Duration: ${execution.durationMs}ms
- Actions completed: ${execution.actionResults.filter((a) => a.success).length}/${execution.actionResults.length}
- Screenshots captured: ${execution.screenshots.length}`;

    if (execution.error) {
      contextText += `\n- Execution error: ${execution.error}`;
    }

    if (execution.consoleErrors.length > 0) {
      contextText += `\n\n## Console Errors:\n${execution.consoleErrors.slice(0, 10).join("\n")}`;
    }

    contextText +=
      "\n\nEvaluate whether the test case passed or failed based on the screenshots and execution data above.";

    content.push({ type: "text", text: contextText });

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: EVALUATOR_SYSTEM_PROMPT,
      tools: [EVALUATE_TOOL],
      tool_choice: { type: "tool", name: "evaluate_test_result" },
      messages: [{ role: "user", content }],
    });

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (!toolBlock) {
      return {
        testCaseId: testCase.id,
        verdict: "blocked",
        confidence: 0.5,
        reasoning: "Evaluator did not return structured output.",
        issues: [],
        screenshotsUsed: screenshotsToSend.map((s) => s.path),
      };
    }

    const input = toolBlock.input as {
      verdict: string;
      confidence: number;
      reasoning: string;
      issues: Array<{ severity: string; description: string }>;
    };

    return {
      testCaseId: testCase.id,
      verdict: input.verdict as Evaluation["verdict"],
      confidence: Math.min(1, Math.max(0, input.confidence)),
      reasoning: input.reasoning,
      issues: input.issues.map(
        (i): Issue => ({
          severity: i.severity as Issue["severity"],
          description: i.description,
        })
      ),
      screenshotsUsed: screenshotsToSend.map((s) => s.path),
    };
  }

  private selectScreenshots(
    execution: ExecutionResult
  ): ExecutionResult["screenshots"] {
    const all = execution.screenshots;
    if (all.length <= 5) return all;

    const selected = new Set<number>();
    selected.add(0);
    selected.add(all.length - 1);

    // Include any error/diagnostic screenshots
    for (let i = 0; i < all.length; i++) {
      if (all[i].path.includes("error-")) {
        selected.add(i);
      }
    }

    // Fill remaining slots evenly
    const remaining = 5 - selected.size;
    if (remaining > 0) {
      const step = Math.floor(all.length / (remaining + 1));
      for (let i = 1; i <= remaining; i++) {
        selected.add(Math.min(step * i, all.length - 1));
      }
    }

    return [...selected]
      .sort((a, b) => a - b)
      .slice(0, 5)
      .map((i) => all[i]);
  }
}
