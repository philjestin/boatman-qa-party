import type {
  TestPlan,
  Credential,
  TestArea,
  TestCase,
  TestStep,
} from "../types.js";

interface CsvRow {
  [column: string]: string;
}

export function parseCsvTestPlan(content: string, baseUrl: string): TestPlan {
  const delimiter = detectDelimiter(content);
  const rows = parseCsvContent(content, delimiter);

  if (rows.length === 0) {
    return {
      name: "Untitled QA Party",
      baseUrl,
      credentials: [],
      testAreas: [],
    };
  }

  const credentialRows = rows.filter((r) => isCredentialRow(r));
  const testCaseRows = rows.filter((r) => isTestCaseRow(r));

  const credentials = credentialRows.map(parseCredentialRow).filter(Boolean) as Credential[];
  const testCases = testCaseRows.map((r, i) => parseTestCaseRow(r, i)).filter(Boolean) as TestCase[];

  const grouped = groupByArea(testCases, testCaseRows);

  return {
    name: extractName(rows) || "Untitled QA Party",
    baseUrl,
    credentials,
    testAreas: grouped,
  };
}

function detectDelimiter(content: string): string {
  const firstLine = content.split("\n")[0] || "";
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  return tabCount > commaCount ? "\t" : ",";
}

function parseCsvContent(content: string, delimiter: string): CsvRow[] {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0], delimiter);
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delimiter);
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cells[j] || "";
    }
    rows.push(row);
  }

  return rows;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }

  result.push(current.trim());
  return result;
}

function isCredentialRow(row: CsvRow): boolean {
  const keys = Object.keys(row).map((k) => k.toLowerCase());
  return (
    keys.some((k) => k.includes("username") || k.includes("email")) &&
    keys.some((k) => k.includes("password"))
  );
}

function isTestCaseRow(row: CsvRow): boolean {
  const keys = Object.keys(row).map((k) => k.toLowerCase());
  const hasDescriptor = keys.some(
    (k) =>
      k.includes("test case") ||
      k.includes("scenario") ||
      k.includes("description")
  );
  const hasStepsOrExpected = keys.some(
    (k) => k.includes("step") || k.includes("expected")
  );

  if (!hasDescriptor && !hasStepsOrExpected) return false;

  const description = findCol(row, ["test case", "scenario", "scenarios", "description"]);
  return !!description?.trim();
}

function parseCredentialRow(row: CsvRow): Credential | null {
  const username = findCol(row, ["username", "email"]);
  const password = findCol(row, ["password"]);
  if (!username || !password) return null;

  return {
    role: findCol(row, ["role", "user role"]) || "user",
    username: username.trim(),
    password: password.trim(),
    userId: findCol(row, ["user_id", "user id"])?.trim() || undefined,
    employerId: findCol(row, ["employer_id", "employer id"])?.trim() || undefined,
    description: findCol(row, ["name", "student name"])?.trim() || undefined,
  };
}

function parseTestCaseRow(row: CsvRow, index: number): TestCase | null {
  const description = findCol(row, [
    "test case",
    "scenario",
    "scenarios",
    "description",
  ]);
  if (!description?.trim()) return null;

  const stepsText = findCol(row, ["steps to test", "steps", "test steps"]) || "";
  const expectedResult = findCol(row, [
    "expected result",
    "expected result(s)",
    "expected",
  ]) || "";
  const priorityText = findCol(row, ["priority"]) || "";
  const id = findCol(row, ["#", "id", "no", "number"]) || `TC-${index + 1}`;

  return {
    id: id.trim(),
    description: description.trim(),
    priority: parsePriority(priorityText),
    steps: parseSteps(stepsText),
    expectedResult: expectedResult.trim(),
  };
}

function groupByArea(cases: TestCase[], rows: CsvRow[]): TestArea[] {
  const areaMap = new Map<string, TestCase[]>();

  for (let i = 0; i < cases.length; i++) {
    const row = rows[i];
    const area =
      findCol(row, ["test area", "area", "category", "section"]) || "General";
    const key = area.trim();
    if (!areaMap.has(key)) areaMap.set(key, []);
    areaMap.get(key)!.push(cases[i]);
  }

  return Array.from(areaMap.entries()).map(([name, testCases]) => ({
    name,
    categories: [{ name, testCases }],
  }));
}

function extractName(rows: CsvRow[]): string | undefined {
  for (const row of rows) {
    const feature = findCol(row, ["feature", "plan name", "qa party"]);
    if (feature?.trim()) return feature.trim();
  }
  return undefined;
}

function parseSteps(text: string): TestStep[] {
  const cleaned = text.replace(/\\n/g, "\n").trim();
  if (!cleaned) return [{ order: 1, instruction: "Follow test case description" }];

  const numbered = cleaned.split(/(?:^|\n)\s*(\d+)\.\s+/);
  if (numbered.length > 2) {
    const steps: TestStep[] = [];
    for (let i = 1; i < numbered.length; i += 2) {
      const order = parseInt(numbered[i], 10);
      const instruction = numbered[i + 1]?.trim();
      if (instruction) steps.push({ order, instruction });
    }
    if (steps.length > 0) return steps;
  }

  const bullets = cleaned.split(/\n\s*[•\-\*]\s+/);
  if (bullets.length > 1) {
    return bullets
      .map((b) => b.trim())
      .filter(Boolean)
      .map((instruction, i) => ({ order: i + 1, instruction }));
  }

  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    return lines.map((instruction, i) => ({ order: i + 1, instruction }));
  }

  return [{ order: 1, instruction: cleaned }];
}

function parsePriority(text: string): "must_have" | "nice_to_have" {
  const lower = text.toLowerCase().trim();
  if (lower.includes("nice") || lower.includes("p2") || lower.includes("p3")) {
    return "nice_to_have";
  }
  return "must_have";
}

function findCol(row: CsvRow, candidates: string[]): string | undefined {
  const rowKeys = Object.keys(row);
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    for (const key of rowKeys) {
      if (key.toLowerCase().includes(lower) && row[key].trim()) {
        return row[key];
      }
    }
  }
  return undefined;
}
