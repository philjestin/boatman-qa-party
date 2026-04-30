# Boatman QA Party

AI-powered QA party automation agent. Parses QA test plan documents, uses Playwright to navigate staging environments, takes screenshots, and uses Claude's vision to evaluate pass/fail.

## Project Structure

TypeScript monorepo with npm workspaces:

- `packages/core` — Test plan parser, AI agent loop (planner/executor/evaluator), report generation, auth management
- `packages/mcp-server` — MCP server for interactive Claude Code-driven testing
- `packages/cli` — Standalone CLI for batch test execution

## Dependencies

- `@boatman/core` (from sibling repo `../boatmanuibuilder/packages/core`) — Playwright browser management, screenshots, interactions
- `@anthropic-ai/sdk` — Claude API for action planning and visual evaluation
- `@modelcontextprotocol/sdk` — MCP server (mcp-server package only)

## Build

```bash
npm install
npm run build
```

Requires `boatmanuibuilder` to be built first (sibling repo dependency).

## Architecture

### Agent Loop (per test case)

1. **Parse** — Read test plan document into structured TestCase objects
2. **Plan** — Claude reads test steps, produces a browser action plan (navigate, click, type, etc.)
3. **Execute** — Playwright executes the planned actions, capturing screenshots
4. **Evaluate** — Claude vision analyzes screenshots against expected results
5. **Report** — Results collected into HTML/JSON report

### Auth

Supports programmatic login with staging credentials. Auth state saved per-credential at `~/.boatman/qa-party/`.

### MCP Server

Tools: `parse_test_plan`, `run_test_case`, `run_test_suite`, `evaluate_screenshot`, `authenticate`

### CLI

```bash
qa-party run <plan-file> --base-url <staging-url>
qa-party parse <plan-file>
qa-party report <results-json>
```

## Environment Variables

- `ANTHROPIC_API_KEY` — Required for AI planning and evaluation
