# Boatman QA Party

AI-powered QA party automation. Parses test plan documents, drives a real browser through each test case, takes screenshots, and uses Claude's vision to evaluate pass/fail.

Built on top of [boatman-ui-builder](../boatmanuibuilder) for Playwright browser management.

## How it works

```
Test Plan Document              AI Agent Loop (per test case)           Report
  (markdown/CSV)
                                +---------+
  +----------------+     1. Parse test    |     2. Plan       3. Execute       4. Evaluate
  | # Test Area    |     steps into    ---+-->  Claude reads   Playwright      Claude vision
  | | Test Case    |     structured        |    steps and      runs the        compares
  | | Steps        | --> test cases        |    produces a     planned         screenshots vs
  | | Expected     |                       |    browser        actions,        expected results
  | | Priority     |                       |    action plan    screenshots     --> pass/fail
  +----------------+                       +---------+         each step
                                                                                  |
                                                                                  v
                                                                          HTML/JSON Report
                                                                          with screenshots,
                                                                          verdicts, issues
```

## Quick start

```bash
# Prerequisites: Node.js 20+, boatmanuibuilder built at ../boatmanuibuilder

npm install
npx playwright install chromium   # first time only
npm run build

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# Parse a test plan to see what it found
node packages/cli/build/index.js parse my-qa-plan.md

# Run the full test suite against staging
node packages/cli/build/index.js run my-qa-plan.md \
  --base-url https://app.joinhandshake-staging.com

# Run with the browser visible (useful for debugging)
node packages/cli/build/index.js run my-qa-plan.md \
  --base-url https://app.joinhandshake-staging.com \
  --no-headless
```

## Project structure

```
packages/
  core/           Shared library: parser, AI agent, reporter, auth
    src/
      parser/       Markdown + CSV test plan parsing
      agent/        AI planner, Playwright executor, vision evaluator
      auth/         Programmatic staging login with per-credential state
      report/       HTML and JSON report generation
  mcp-server/     MCP server for interactive use from Claude Code
  cli/            Standalone CLI for batch execution
```

## CLI

### `qa-party run <plan-file>`

Execute a QA test plan. Each test case goes through the AI agent loop: plan actions, execute in browser, screenshot, evaluate.

```
Options:
  --base-url <url>         Staging URL (default: https://app.joinhandshake-staging.com)
  --output-dir <dir>       Results directory (default: ./qa-party-results/<timestamp>)
  --filter-priority <p>    Only run "must_have" or "nice_to_have"
  --filter-category <cat>  Only run tests matching this category name
  --filter-cases <ids>     Comma-separated test case IDs (e.g. "1.1,1.2,2.3")
  --model <model>          Claude model (default: claude-sonnet-4-20250514)
  --max-retries <n>        Retry failed actions with AI re-planning (default: 2)
  --no-headless            Show the browser window
```

Output: prints each test result as it completes, then a summary table. Generates `results.json` and `report.html` in the output directory. Exits with code 1 if any must-have tests fail.

### `qa-party parse <plan-file>`

Parse and display the test plan structure without running anything. Useful for validating that the parser correctly extracted test areas, categories, cases, and credentials.

### `qa-party report <results.json>`

Regenerate an HTML report from a previous run's JSON results.

## MCP server

Add to your `.mcp.json` (or `~/.claude/claude_mcp_config.json` for global):

```json
{
  "mcpServers": {
    "qa-party": {
      "command": "node",
      "args": ["/path/to/boatman-qa-party/packages/mcp-server/build/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

### Tools

| Tool | Purpose |
|------|---------|
| `authenticate` | Open a visible browser to log in manually. Saves cookies for future headless runs. |
| `parse_test_plan` | Load a test plan file and return its structured test cases, credentials, and metadata. |
| `run_test_case` | Execute a single test case by ID. Returns the verdict, screenshots, and action log. |
| `run_test_suite` | Execute all (or filtered) test cases. Produces a full report. |
| `evaluate_screenshot` | Standalone AI evaluation: send a screenshot + expected result text, get a verdict. |

### Typical workflow from Claude Code

1. `parse_test_plan` to inspect the test plan
2. `authenticate` if the staging site needs login
3. `run_test_case` for individual cases, or `run_test_suite` for the full run
4. Review the HTML report

## Test plan format

The parser handles both markdown and CSV. Markdown is the primary format, matching the structure used in Handshake QA party documents.

### Markdown example

```markdown
# QA Party Plan: Feature Name

## Test Area 1: Profile Page

### Category: Page Loading

| # | Test Case | Steps to Test | Expected Result | Priority |
|---|-----------|---------------|-----------------|----------|
| 1.1 | Page loads | Navigate to /page | Page renders correctly | Must Have |
| 1.2 | Error state | Navigate to /page/invalid | 404 page shown | Nice to Have |

## Staging Test Users

| Username | Password | User_id | User Role |
|----------|----------|---------|-----------|
| user@example.com | password123 | 42 | Recruiter |
```

The parser extracts:
- **Test areas** from `## Test Area N: Name` headings
- **Categories** from `### Category: Name` headings
- **Test cases** from markdown tables with columns matching "Test Case", "Steps to Test", "Expected Result", "Priority"
- **Credentials** from tables with "Username" and "Password" columns
- **Steps** split on numbered lists (`1.`, `2.`, ...) or bullet points within the steps column

### CSV/TSV

Export from Google Sheets. Column headers are matched flexibly (e.g., "Test Case" or "Scenarios", "Expected Result" or "Expected Result(s)").

## How the AI agent works

### Planning

For each test case, the planner sends the test steps and current browser state to Claude with a `plan_browser_actions` tool. Claude returns a structured action plan:

```json
{
  "reasoning": "Navigate to the profile page, then verify the left rail...",
  "actions": [
    { "order": 1, "type": "navigate", "target": "https://staging.example.com/recruit/users/2722", "description": "Open student profile", "screenshotAfter": false },
    { "order": 2, "type": "wait", "value": "2000", "description": "Wait for React SPA to render", "screenshotAfter": false },
    { "order": 3, "type": "screenshot", "description": "Capture profile page", "screenshotAfter": true }
  ]
}
```

Available action types: `navigate`, `click`, `type`, `scroll`, `hover`, `wait`, `screenshot`, `select`, `press_key`.

The planner prefers robust selectors: `data-testid`, `aria-label`, `role`, `text=Visible Text`, semantic HTML.

### Execution

The executor runs each action against a real Chromium browser via Playwright (through `@boatman/core`'s `BrowserManager`). It captures screenshots at each step and records console errors.

If an action fails (element not found, timeout), the executor captures a diagnostic screenshot and the agent retries with AI re-planning -- Claude sees the error and current page state and generates a corrective action plan. This happens up to `maxRetries` times.

### Evaluation

After execution, all screenshots and the expected result text are sent to Claude's vision API via an `evaluate_test_result` tool. Claude returns:

- **Verdict**: pass, fail, partial, blocked, or skipped
- **Confidence**: 0-1 self-assessed confidence
- **Reasoning**: explanation referencing what's visible in the screenshots
- **Issues**: list with severity (critical/major/minor/cosmetic)

### Report

Results are written as:
- **JSON** (`results.json`): machine-readable, can be fed back to `qa-party report` to regenerate HTML
- **HTML** (`report.html`): self-contained page with embedded screenshots, verdict badges, expandable action logs, and a filter bar to show only failures

## Authentication

Two modes:

1. **Programmatic** (default): the agent navigates to `/login`, fills in credentials from the test plan, and saves the session. Auth state is stored per-credential at `~/.boatman/qa-party/auth-<hash>.json`.

2. **Manual** (via MCP `authenticate` tool): opens a visible browser for you to log in. Useful when login requires 2FA or CAPTCHA.

Auth state persists across runs. The agent detects when a session expires and re-authenticates.

## Dependencies

- [`@boatman/core`](../boatmanuibuilder/packages/core) -- Playwright browser management (navigate, interact, screenshot, auth state). Referenced via `file:` dependency.
- [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) -- Claude API for action planning and vision evaluation.
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) -- MCP server (mcp-server package only).

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for planning and evaluation |
