import Anthropic from "@anthropic-ai/sdk";
import { BrowserManager } from "@boatman/core";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { ActionPlanner } from "./planner.js";
import { ActionExecutor } from "./executor.js";
import { TestEvaluator } from "./evaluator.js";
import type {
  TestPlan,
  TestCase,
  TestCaseResult,
  TestRunReport,
  RunSummary,
  QAPartyConfig,
  ExecutionResult,
} from "../types.js";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_OUTPUT_DIR = "./qa-party-results";
const DEFAULT_MAX_RETRIES = 2;

export class AgentRunner {
  private config: QAPartyConfig;
  private browser: BrowserManager;
  private anthropic: Anthropic;
  private planner: ActionPlanner;
  private evaluator: TestEvaluator;
  private runId: string;

  constructor(config: QAPartyConfig) {
    this.config = config;
    this.runId = `run-${Date.now()}`;

    this.browser = new BrowserManager({
      headless: config.headless !== false,
    });

    this.anthropic = new Anthropic({
      apiKey: config.anthropicApiKey,
    });

    const model = config.model ?? DEFAULT_MODEL;

    this.planner = new ActionPlanner(
      this.anthropic,
      model,
      config.baseUrl
    );

    this.evaluator = new TestEvaluator(this.anthropic, model);
  }

  async runTestPlan(
    plan: TestPlan,
    options?: { onProgress?: (result: TestCaseResult) => void }
  ): Promise<TestRunReport> {
    const startTime = new Date().toISOString();
    const results: TestCaseResult[] = [];

    const allCases = this.collectTestCases(plan);
    const filtered = this.filterTestCases(allCases);

    console.error(
      `[qa-party] Starting run ${this.runId}: ${filtered.length} test cases (of ${allCases.length} total)`
    );

    for (const testCase of filtered) {
      console.error(
        `[qa-party] Running ${testCase.id}: ${testCase.description}`
      );

      const result = await this.runTestCase(testCase, plan.baseUrl);
      results.push(result);

      console.error(
        `[qa-party] ${testCase.id}: ${result.evaluation.verdict} (confidence: ${result.evaluation.confidence})`
      );

      options?.onProgress?.(result);
    }

    const summary = this.computeSummary(results);

    return {
      runId: this.runId,
      testPlanName: plan.name,
      startTime,
      endTime: new Date().toISOString(),
      baseUrl: plan.baseUrl,
      summary,
      results,
    };
  }

  async runTestCase(
    testCase: TestCase,
    baseUrl: string
  ): Promise<TestCaseResult> {
    const outputDir = join(
      this.config.outputDir ?? DEFAULT_OUTPUT_DIR,
      this.runId
    );
    await mkdir(outputDir, { recursive: true });

    const executor = new ActionExecutor(this.browser, outputDir);
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;

    let page;
    try {
      page = await this.browser.ensureBrowser();
    } catch (err) {
      return this.blockedResult(testCase, `Browser failed to start: ${err}`);
    }

    const currentUrl = page.url();
    let currentScreenshot: Buffer | undefined;
    try {
      currentScreenshot = await this.browser.screenshot();
    } catch {
      // ignore — might be about:blank
    }

    let plan;
    try {
      plan = await this.planner.planActions(
        testCase,
        currentUrl === "about:blank" ? undefined : currentUrl,
        currentScreenshot
      );
    } catch (err) {
      return this.blockedResult(
        testCase,
        `Planner failed: ${err instanceof Error ? err.message : err}`
      );
    }

    let execution: ExecutionResult = await executor.execute(
      plan,
      this.config.screenshotOnEveryStep ?? true
    );

    let retries = 0;
    while (execution.error && retries < maxRetries) {
      retries++;
      console.error(
        `[qa-party] ${testCase.id}: Retry ${retries}/${maxRetries} after error: ${execution.error}`
      );

      let diagnosticScreenshot: Buffer | undefined;
      if (execution.screenshots.length > 0) {
        const last = execution.screenshots[execution.screenshots.length - 1];
        diagnosticScreenshot = last.buffer;
      }

      try {
        const replan = await this.planner.replanAfterFailure(
          testCase,
          execution.actionResults,
          execution.error,
          diagnosticScreenshot
        );

        const retryExecution = await executor.execute(
          replan,
          this.config.screenshotOnEveryStep ?? true
        );

        execution = {
          testCaseId: testCase.id,
          actionResults: [
            ...execution.actionResults,
            ...retryExecution.actionResults,
          ],
          screenshots: [
            ...execution.screenshots,
            ...retryExecution.screenshots,
          ],
          consoleErrors: [
            ...execution.consoleErrors,
            ...retryExecution.consoleErrors,
          ],
          error: retryExecution.error,
          durationMs: execution.durationMs + retryExecution.durationMs,
        };
      } catch (err) {
        console.error(
          `[qa-party] ${testCase.id}: Replan failed: ${err}`
        );
        break;
      }
    }

    let evaluation;
    try {
      evaluation = await this.evaluator.evaluate(testCase, execution);
    } catch (err) {
      evaluation = {
        testCaseId: testCase.id,
        verdict: "blocked" as const,
        confidence: 0.5,
        reasoning: `Evaluator failed: ${err instanceof Error ? err.message : err}`,
        issues: [],
        screenshotsUsed: [],
      };
    }

    return { testCase, execution, evaluation };
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  private collectTestCases(plan: TestPlan): TestCase[] {
    const cases: TestCase[] = [];
    for (const area of plan.testAreas) {
      for (const category of area.categories) {
        for (const tc of category.testCases) {
          cases.push(tc);
        }
      }
    }
    return cases;
  }

  private filterTestCases(cases: TestCase[]): TestCase[] {
    let filtered = cases;

    if (this.config.priorityFilter) {
      filtered = filtered.filter(
        (tc) => tc.priority === this.config.priorityFilter
      );
    }

    if (this.config.categoryFilter) {
      const f = this.config.categoryFilter.toLowerCase();
      filtered = filtered.filter(
        (tc) =>
          tc.tags?.some((t) => t.toLowerCase().includes(f)) ||
          tc.id.toLowerCase().includes(f)
      );
    }

    if (this.config.testCaseFilter && this.config.testCaseFilter.length > 0) {
      const ids = new Set(this.config.testCaseFilter);
      filtered = filtered.filter((tc) => ids.has(tc.id));
    }

    return filtered;
  }

  private computeSummary(results: TestCaseResult[]): RunSummary {
    const total = results.length;
    const passed = results.filter(
      (r) => r.evaluation.verdict === "pass"
    ).length;
    const failed = results.filter(
      (r) => r.evaluation.verdict === "fail"
    ).length;
    const partial = results.filter(
      (r) => r.evaluation.verdict === "partial"
    ).length;
    const blocked = results.filter(
      (r) => r.evaluation.verdict === "blocked"
    ).length;
    const skipped = results.filter(
      (r) => r.evaluation.verdict === "skipped"
    ).length;

    return {
      total,
      passed,
      failed,
      partial,
      blocked,
      skipped,
      passRate: total > 0 ? passed / total : 0,
    };
  }

  private blockedResult(testCase: TestCase, reason: string): TestCaseResult {
    return {
      testCase,
      execution: {
        testCaseId: testCase.id,
        actionResults: [],
        screenshots: [],
        consoleErrors: [],
        error: reason,
        durationMs: 0,
      },
      evaluation: {
        testCaseId: testCase.id,
        verdict: "blocked",
        confidence: 1.0,
        reasoning: reason,
        issues: [{ severity: "critical", description: reason }],
        screenshotsUsed: [],
      },
    };
  }
}

export { ActionPlanner } from "./planner.js";
export { ActionExecutor } from "./executor.js";
export { TestEvaluator } from "./evaluator.js";
