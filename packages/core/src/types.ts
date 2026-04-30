export interface TestPlan {
  name: string;
  description?: string;
  baseUrl: string;
  credentials: Credential[];
  testAreas: TestArea[];
  metadata?: Record<string, string>;
}

export interface Credential {
  role: string;
  username: string;
  password: string;
  userId?: string;
  employerId?: string;
  description?: string;
}

export interface TestArea {
  name: string;
  categories: TestCategory[];
}

export interface TestCategory {
  name: string;
  testCases: TestCase[];
}

export interface TestCase {
  id: string;
  description: string;
  priority: "must_have" | "nice_to_have";
  steps: TestStep[];
  expectedResult: string;
  credential?: string;
  tags?: string[];
}

export interface TestStep {
  order: number;
  instruction: string;
}

export interface ActionPlan {
  testCaseId: string;
  actions: PlannedAction[];
  reasoning: string;
}

export interface PlannedAction {
  order: number;
  type:
    | "navigate"
    | "click"
    | "type"
    | "scroll"
    | "hover"
    | "wait"
    | "screenshot"
    | "select"
    | "press_key";
  target?: string;
  value?: string;
  description: string;
  screenshotAfter: boolean;
}

export interface ExecutionResult {
  testCaseId: string;
  actionResults: ActionResult[];
  screenshots: ScreenshotCapture[];
  consoleErrors: string[];
  error?: string;
  durationMs: number;
}

export interface ActionResult {
  action: PlannedAction;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface ScreenshotCapture {
  path: string;
  buffer?: Buffer;
  afterAction: number;
  timestamp: number;
  description: string;
}

export interface Evaluation {
  testCaseId: string;
  verdict: "pass" | "fail" | "partial" | "blocked" | "skipped";
  confidence: number;
  reasoning: string;
  issues: Issue[];
  screenshotsUsed: string[];
}

export interface Issue {
  severity: "critical" | "major" | "minor" | "cosmetic";
  description: string;
  screenshotPath?: string;
}

export interface TestRunReport {
  runId: string;
  testPlanName: string;
  startTime: string;
  endTime: string;
  baseUrl: string;
  summary: RunSummary;
  results: TestCaseResult[];
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  partial: number;
  blocked: number;
  skipped: number;
  passRate: number;
}

export interface TestCaseResult {
  testCase: TestCase;
  execution: ExecutionResult;
  evaluation: Evaluation;
}

export interface QAPartyConfig {
  anthropicApiKey?: string;
  model?: string;
  baseUrl: string;
  outputDir?: string;
  maxRetries?: number;
  screenshotOnEveryStep?: boolean;
  headless?: boolean;
  timeout?: number;
  priorityFilter?: "must_have" | "nice_to_have";
  categoryFilter?: string;
  testCaseFilter?: string[];
}
