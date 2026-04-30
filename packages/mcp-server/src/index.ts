#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BrowserManager } from "@boatman/core";
import {
  parseTestPlan,
  AgentRunner,
  TestEvaluator,
  ReportGenerator,
  type QAPartyConfig,
  type TestCase,
  type TestCaseResult,
  type TestRunReport,
} from "@qa-party/core";

const server = new McpServer({
  name: "boatman-qa-party",
  version: "1.0.0",
});

const browserManager = new BrowserManager();

server.tool(
  "authenticate",
  "One-time login: opens a visible Chromium browser at the given URL. Log in manually to save cookies for headless test runs.",
  {
    loginUrl: z.string().describe("Login page URL for the staging environment"),
  },
  async ({ loginUrl }) => {
    const statePath = await browserManager.authenticate(loginUrl);
    return {
      content: [
        {
          type: "text" as const,
          text: `Authentication saved to ${statePath}. All future test runs will use this session.`,
        },
      ],
    };
  }
);

server.tool(
  "parse_test_plan",
  "Load and parse a QA party test plan document (markdown or CSV) into structured test cases.",
  {
    filePath: z.string().describe("Path to the test plan file (markdown or CSV)"),
    baseUrl: z
      .string()
      .default("https://app.joinhandshake-staging.com")
      .describe("Base URL of the staging environment"),
  },
  async ({ filePath, baseUrl }) => {
    const absPath = resolve(filePath);
    const content = await readFile(absPath, "utf-8");
    const plan = parseTestPlan(content, absPath, baseUrl);

    let totalCases = 0;
    const areas: string[] = [];
    for (const area of plan.testAreas) {
      let areaCases = 0;
      for (const cat of area.categories) {
        areaCases += cat.testCases.length;
      }
      totalCases += areaCases;
      areas.push(`  ${area.name}: ${areaCases} cases`);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Parsed test plan: ${plan.name}\n\n${plan.description ?? ""}\n\nTest Areas:\n${areas.join("\n")}\n\nTotal: ${totalCases} test cases\nCredentials: ${plan.credentials.length}\n\nFull structure:\n${JSON.stringify(plan, null, 2)}`,
        },
      ],
    };
  }
);

server.tool(
  "run_test_case",
  "Execute a single test case from a QA party plan. The AI agent plans browser actions, executes them via Playwright, takes screenshots, and evaluates pass/fail.",
  {
    testCaseId: z.string().describe("Test case ID to run (e.g. '1.1')"),
    planFilePath: z.string().describe("Path to the test plan file"),
    baseUrl: z
      .string()
      .default("https://app.joinhandshake-staging.com")
      .describe("Base URL of the staging environment"),
    model: z
      .string()
      .default("claude-sonnet-4-20250514")
      .describe("Claude model to use for planning and evaluation"),
  },
  async ({ testCaseId, planFilePath, baseUrl, model }) => {
    const absPath = resolve(planFilePath);
    const planContent = await readFile(absPath, "utf-8");
    const plan = parseTestPlan(planContent, absPath, baseUrl);

    let targetCase: TestCase | undefined;
    for (const area of plan.testAreas) {
      for (const cat of area.categories) {
        targetCase = cat.testCases.find((tc) => tc.id === testCaseId);
        if (targetCase) break;
      }
      if (targetCase) break;
    }

    if (!targetCase) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Test case '${testCaseId}' not found in plan.`,
          },
        ],
      };
    }

    const config: QAPartyConfig = {
      baseUrl,
      model,
      outputDir: resolve("qa-party-results", `single-${testCaseId}-${Date.now()}`),
      maxRetries: 2,
      headless: true,
      screenshotOnEveryStep: true,
    };

    const runner = new AgentRunner(config);
    const result = await runner.runTestCase(targetCase, baseUrl);
    await runner.close();

    const reporter = new ReportGenerator();
    const outputDir = config.outputDir!;
    const report: TestRunReport = {
      runId: `single-${testCaseId}`,
      testPlanName: plan.name,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      baseUrl,
      summary: {
        total: 1,
        passed: result.evaluation.verdict === "pass" ? 1 : 0,
        failed: result.evaluation.verdict === "fail" ? 1 : 0,
        partial: result.evaluation.verdict === "partial" ? 1 : 0,
        blocked: result.evaluation.verdict === "blocked" ? 1 : 0,
        skipped: result.evaluation.verdict === "skipped" ? 1 : 0,
        passRate: result.evaluation.verdict === "pass" ? 100 : 0,
      },
      results: [result],
    };

    await reporter.generateJSON(report, resolve(outputDir, "results.json"));

    return {
      content: [
        {
          type: "text" as const,
          text: formatSingleResult(result),
        },
      ],
    };
  }
);

server.tool(
  "run_test_suite",
  "Execute all (or filtered) test cases from a QA party plan.",
  {
    planFilePath: z.string().describe("Path to the test plan file"),
    baseUrl: z
      .string()
      .default("https://app.joinhandshake-staging.com")
      .describe("Base URL of the staging environment"),
    priorityFilter: z
      .enum(["must_have", "nice_to_have"])
      .optional()
      .describe("Only run cases of this priority"),
    categoryFilter: z
      .string()
      .optional()
      .describe("Only run cases in categories matching this string"),
    model: z
      .string()
      .default("claude-sonnet-4-20250514")
      .describe("Claude model to use"),
  },
  async ({ planFilePath, baseUrl, priorityFilter, categoryFilter, model }) => {
    const absPath = resolve(planFilePath);
    const planContent = await readFile(absPath, "utf-8");
    const plan = parseTestPlan(planContent, absPath, baseUrl);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDir = resolve("qa-party-results", timestamp);

    const config: QAPartyConfig = {
      baseUrl,
      model,
      outputDir,
      maxRetries: 2,
      headless: true,
      screenshotOnEveryStep: true,
      priorityFilter,
      categoryFilter,
    };

    const runner = new AgentRunner(config);
    const report = await runner.runTestPlan(plan);
    await runner.close();

    const reporter = new ReportGenerator();
    const jsonPath = await reporter.generateJSON(
      report,
      resolve(outputDir, "results.json")
    );
    const htmlPath = await reporter.generateHTML(
      report,
      resolve(outputDir, "report.html")
    );

    const s = report.summary;
    const lines = report.results.map((r) => {
      const v = r.evaluation.verdict.toUpperCase().padEnd(7);
      return `  ${r.testCase.id.padEnd(8)} ${v} ${r.testCase.description}`;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `QA Party Complete: ${plan.name}\n\nTotal: ${s.total} | Pass: ${s.passed} | Fail: ${s.failed} | Partial: ${s.partial} | Blocked: ${s.blocked} | Skipped: ${s.skipped}\nPass rate: ${Math.round(s.passRate * 100)}%\n\nResults:\n${lines.join("\n")}\n\nJSON: ${jsonPath}\nHTML: ${htmlPath}`,
        },
      ],
    };
  }
);

server.tool(
  "evaluate_screenshot",
  "Send a screenshot to Claude for AI evaluation against expected test results.",
  {
    screenshotPath: z.string().describe("Path to the screenshot PNG file"),
    expectedResult: z
      .string()
      .describe("Expected result text to evaluate the screenshot against"),
    model: z
      .string()
      .default("claude-sonnet-4-20250514")
      .describe("Claude model to use for evaluation"),
  },
  async ({ screenshotPath, expectedResult, model }) => {
    const anthropic = new Anthropic();
    const evaluator = new TestEvaluator(anthropic, model);
    const screenshotBuffer = await readFile(resolve(screenshotPath));

    const testCase: TestCase = {
      id: "manual",
      description: "Manual screenshot evaluation",
      priority: "must_have",
      steps: [],
      expectedResult,
    };

    const evaluation = await evaluator.evaluate(testCase, {
      testCaseId: "manual",
      actionResults: [],
      screenshots: [
        {
          path: screenshotPath,
          buffer: screenshotBuffer,
          afterAction: 0,
          timestamp: Date.now(),
          description: "Manual screenshot",
        },
      ],
      consoleErrors: [],
      durationMs: 0,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Verdict: ${evaluation.verdict.toUpperCase()} (${Math.round(evaluation.confidence * 100)}% confidence)\n\nReasoning: ${evaluation.reasoning}${evaluation.issues.length > 0 ? `\n\nIssues:\n${evaluation.issues.map((i) => `  [${i.severity}] ${i.description}`).join("\n")}` : ""}`,
        },
      ],
    };
  }
);

function formatSingleResult(result: TestCaseResult): string {
  const tc = result.testCase;
  const ev = result.evaluation;
  const exec = result.execution;

  let text = `Test Case: ${tc.id} — ${tc.description}\n`;
  text += `Verdict: ${ev.verdict.toUpperCase()} (${Math.round(ev.confidence * 100)}% confidence)\n`;
  text += `Duration: ${(exec.durationMs / 1000).toFixed(1)}s\n\n`;
  text += `Reasoning: ${ev.reasoning}\n`;

  if (ev.issues.length > 0) {
    text += `\nIssues:\n`;
    for (const i of ev.issues) {
      text += `  [${i.severity}] ${i.description}\n`;
    }
  }

  if (exec.actionResults.length > 0) {
    text += `\nAction Log:\n`;
    for (const ar of exec.actionResults) {
      const icon = ar.success ? "+" : "x";
      text += `  ${icon} [${ar.action.type}] ${ar.action.description}${ar.error ? ` -- ${ar.error}` : ""}\n`;
    }
  }

  if (exec.screenshots.length > 0) {
    text += `\nScreenshots: ${exec.screenshots.length} captured`;
  }

  return text;
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Boatman QA Party MCP server running on stdio");
  if (browserManager.hasStorageState) {
    console.error(`Auth state loaded from ${browserManager.storageStatePath}`);
  } else {
    console.error(
      "No auth state found. Run the authenticate tool if pages require login."
    );
  }
}

process.on("SIGINT", async () => {
  await browserManager.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await browserManager.close();
  process.exit(0);
});

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
