#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import {
  parseTestPlan,
  AgentRunner,
  ReportGenerator,
  type QAPartyConfig,
  type TestRunReport,
  type TestCaseResult,
  type TestCase,
} from "@qa-party/core";

function usage(): void {
  console.log(`
Usage: qa-party <command> [options]

Commands:
  run <plan-file>        Execute QA party test plan
  parse <plan-file>      Parse and display test plan structure
  report <results-json>  Regenerate HTML report from JSON results

Run options:
  --base-url <url>         Staging base URL (default: https://app.joinhandshake-staging.com)
  --output-dir <dir>       Output directory (default: ./qa-party-results/<timestamp>)
  --filter-priority <p>    Only run must_have or nice_to_have
  --filter-category <cat>  Only run tests in this category
  --filter-cases <ids>     Comma-separated test case IDs
  --headless               Run headlessly (default)
  --no-headless            Show the browser
  --model <model>          Claude model (default: claude-sonnet-4-20250514)
  --max-retries <n>        Per-test retries (default: 2)
`);
}

function parseArgs(argv: string[]): {
  command: string;
  file: string;
  options: Record<string, string>;
  flags: Set<string>;
} {
  const command = argv[0] ?? "";
  const file = argv[1] ?? "";
  const options: Record<string, string> = {};
  const flags = new Set<string>();

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--no-")) {
      flags.add(arg);
    } else if (arg.startsWith("--")) {
      const key = arg;
      const val = argv[++i] ?? "";
      options[key] = val;
    }
  }

  return { command, file, options, flags };
}

function printResult(r: TestCaseResult): void {
  const v = r.evaluation.verdict.toUpperCase().padEnd(7);
  const conf = `${Math.round(r.evaluation.confidence * 100)}%`.padStart(4);
  const time = `${(r.execution.durationMs / 1000).toFixed(1)}s`.padStart(6);
  const icon =
    r.evaluation.verdict === "pass"
      ? "\x1b[32m+\x1b[0m"
      : r.evaluation.verdict === "fail"
        ? "\x1b[31mx\x1b[0m"
        : "\x1b[33m~\x1b[0m";
  console.log(
    `  ${icon} ${r.testCase.id.padEnd(8)} ${v} ${conf} ${time}  ${r.testCase.description}`
  );
}

function printSummary(report: TestRunReport): void {
  const s = report.summary;
  const duration =
    (new Date(report.endTime).getTime() -
      new Date(report.startTime).getTime()) /
    1000;

  console.log("\n" + "=".repeat(70));
  console.log(`  QA Party Results: ${report.testPlanName}`);
  console.log("=".repeat(70));
  console.log(
    `  Total: ${s.total}  |  \x1b[32mPass: ${s.passed}\x1b[0m  |  \x1b[31mFail: ${s.failed}\x1b[0m  |  \x1b[33mPartial: ${s.partial}\x1b[0m  |  Blocked: ${s.blocked}  |  Skipped: ${s.skipped}`
  );
  console.log(
    `  Pass rate: ${Math.round(s.passRate * 100)}%  |  Duration: ${duration.toFixed(0)}s`
  );
  console.log("=".repeat(70));
}

async function runCommand(
  file: string,
  options: Record<string, string>,
  flags: Set<string>
): Promise<void> {
  const planPath = resolve(file);
  const planContent = await readFile(planPath, "utf-8");

  const baseUrl =
    options["--base-url"] ?? "https://app.joinhandshake-staging.com";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir =
    options["--output-dir"] ?? resolve("qa-party-results", timestamp);
  const model = options["--model"] ?? "claude-sonnet-4-20250514";
  const maxRetries = parseInt(options["--max-retries"] ?? "2", 10);
  const headless = !flags.has("--no-headless");

  const config: QAPartyConfig = {
    baseUrl,
    outputDir,
    model,
    maxRetries,
    headless,
    screenshotOnEveryStep: true,
    priorityFilter: options["--filter-priority"] as
      | "must_have"
      | "nice_to_have"
      | undefined,
    categoryFilter: options["--filter-category"],
    testCaseFilter: options["--filter-cases"]?.split(","),
  };

  console.log(`\n  Parsing test plan: ${basename(planPath)}`);
  const plan = parseTestPlan(planContent, planPath, baseUrl);

  let totalCases = 0;
  for (const area of plan.testAreas) {
    for (const cat of area.categories) {
      totalCases += cat.testCases.length;
    }
  }

  console.log(`  Found ${totalCases} test cases`);
  console.log(`  Output: ${outputDir}`);
  console.log(`  Model: ${model}`);
  console.log("");

  const runner = new AgentRunner(config);

  const report = await runner.runTestPlan(plan, {
    onProgress: (result) => printResult(result),
  });

  await runner.close();

  printSummary(report);

  const reporter = new ReportGenerator();
  const jsonPath = await reporter.generateJSON(
    report,
    resolve(outputDir, "results.json")
  );
  const htmlPath = await reporter.generateHTML(
    report,
    resolve(outputDir, "report.html")
  );
  console.log(`\n  JSON: ${jsonPath}`);
  console.log(`  HTML: ${htmlPath}\n`);

  const mustHaveFails = report.results.filter(
    (r) =>
      r.testCase.priority === "must_have" && r.evaluation.verdict === "fail"
  );
  if (mustHaveFails.length > 0) {
    console.log(
      `  \x1b[31m${mustHaveFails.length} must-have test(s) failed -- exiting with code 1\x1b[0m\n`
    );
    process.exit(1);
  }
}

async function parseCommand(file: string): Promise<void> {
  const planPath = resolve(file);
  const planContent = await readFile(planPath, "utf-8");
  const plan = parseTestPlan(planContent, planPath, "https://staging.example.com");

  console.log(`\nTest Plan: ${plan.name}`);
  if (plan.description) console.log(`Description: ${plan.description}`);
  console.log(`Base URL: ${plan.baseUrl}`);
  console.log(`Credentials: ${plan.credentials.length}`);

  let totalCases = 0;
  for (const area of plan.testAreas) {
    console.log(`\n  ${area.name}`);
    for (const cat of area.categories) {
      console.log(`    ${cat.name} (${cat.testCases.length} cases)`);
      for (const tc of cat.testCases) {
        console.log(
          `      ${tc.id} [${tc.priority}] ${tc.description}`
        );
        totalCases++;
      }
    }
  }
  console.log(`\nTotal: ${totalCases} test cases\n`);
}

async function reportCommand(file: string): Promise<void> {
  const jsonPath = resolve(file);
  const raw = await readFile(jsonPath, "utf-8");
  const report: TestRunReport = JSON.parse(raw);

  const reporter = new ReportGenerator();
  const htmlPath = jsonPath.replace(/\.json$/, ".html");
  await reporter.generateHTML(report, htmlPath);
  console.log(`\n  HTML report generated: ${htmlPath}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
    process.exit(0);
  }

  const { command, file, options, flags } = parseArgs(args);

  if (!file) {
    console.error(`Error: missing file argument for '${command}'`);
    usage();
    process.exit(1);
  }

  switch (command) {
    case "run":
      await runCommand(file, options, flags);
      break;
    case "parse":
      await parseCommand(file);
      break;
    case "report":
      await reportCommand(file);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
