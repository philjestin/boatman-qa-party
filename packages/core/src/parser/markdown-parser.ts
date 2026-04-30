import type {
  TestPlan,
  Credential,
  TestArea,
  TestCategory,
  TestCase,
  TestStep,
} from "../types.js";

interface MarkdownSection {
  level: number;
  title: string;
  content: string;
  children: MarkdownSection[];
}

interface TableRow {
  [column: string]: string;
}

export function parseMarkdownTestPlan(
  content: string,
  baseUrl: string
): TestPlan {
  const sections = splitIntoSections(content);
  const name = extractPlanName(content);
  const description = extractDescription(sections);
  const credentials = extractCredentials(content);
  const testAreas = extractTestAreas(sections);
  const metadata = extractMetadata(sections);

  return {
    name,
    description,
    baseUrl,
    credentials,
    testAreas,
    metadata,
  };
}

function splitIntoSections(content: string): MarkdownSection[] {
  const lines = content.split("\n");
  const root: MarkdownSection[] = [];
  const stack: { level: number; section: MarkdownSection }[] = [];

  let currentContent: string[] = [];

  function flushContent() {
    const text = currentContent.join("\n").trim();
    currentContent = [];
    if (stack.length > 0) {
      stack[stack.length - 1].section.content += (
        stack[stack.length - 1].section.content ? "\n" : ""
      ) + text;
    }
    return text;
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushContent();
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      const section: MarkdownSection = { level, title, content: "", children: [] };

      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      if (stack.length > 0) {
        stack[stack.length - 1].section.children.push(section);
      } else {
        root.push(section);
      }

      stack.push({ level, section });
    } else {
      currentContent.push(line);
    }
  }

  flushContent();
  return root;
}

function extractPlanName(content: string): string {
  const match = content.match(/^#\s+(?:QA Party Plan:\s*)?(.+)$/m);
  if (match) return match[1].trim();

  const titleMatch = content.match(/^#\s+(.+)$/m);
  return titleMatch ? titleMatch[1].trim() : "Untitled QA Party";
}

function extractDescription(sections: MarkdownSection[]): string | undefined {
  for (const section of sections) {
    if (
      section.title.toLowerCase().includes("description") ||
      section.title.toLowerCase().includes("overview")
    ) {
      return section.content.trim() || undefined;
    }
    for (const child of section.children) {
      if (
        child.title.toLowerCase().includes("description") ||
        child.title.toLowerCase().includes("overview")
      ) {
        return child.content.trim() || undefined;
      }
    }
  }
  return undefined;
}

function extractMetadata(
  sections: MarkdownSection[]
): Record<string, string> | undefined {
  const meta: Record<string, string> = {};

  for (const section of sections) {
    if (
      section.title.toLowerCase().includes("basic information") ||
      section.title.toLowerCase().includes("overview")
    ) {
      const table = parseTable(section.content);
      for (const row of table) {
        const field = row["field"] || row["Field"] || Object.values(row)[0];
        const value = row["value"] || row["Value"] || Object.values(row)[1];
        if (field && value) {
          meta[field.trim()] = value.trim();
        }
      }
    }
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

function extractCredentials(content: string): Credential[] {
  const credentials: Credential[] = [];
  const tables = findAllTables(content);

  for (const table of tables) {
    if (table.length === 0) continue;

    const headers = Object.keys(table[0]).map((h) => h.toLowerCase());
    const hasUsername =
      headers.some((h) => h.includes("username") || h.includes("email"));
    const hasPassword = headers.some((h) => h.includes("password"));

    if (!hasUsername || !hasPassword) continue;

    for (const row of table) {
      const username = findColumn(row, [
        "username",
        "email",
        "Username",
        "Email",
      ]);
      const password = findColumn(row, ["password", "Password"]);
      if (!username || !password) continue;

      const role =
        findColumn(row, ["role", "Role", "User Role", "user role"]) ||
        findColumn(row, [
          "Core/Premium",
          "core/premium",
          "Employer",
          "employer",
        ]) ||
        "user";

      const userId = findColumn(row, [
        "user_id",
        "User_id",
        "User ID",
        "user id",
      ]);
      const employerId = findColumn(row, [
        "employer_id",
        "Employer_id",
        "Employer ID",
        "employer id",
      ]);
      const name = findColumn(row, [
        "name",
        "Name",
        "Student Name",
        "Student Name (Preferred)",
      ]);

      credentials.push({
        role: role.trim(),
        username: username.trim(),
        password: password.trim(),
        userId: userId?.trim() || undefined,
        employerId: employerId?.trim() || undefined,
        description: name?.trim() || undefined,
      });
    }
  }

  return credentials;
}

function extractTestAreas(sections: MarkdownSection[]): TestArea[] {
  const areas: TestArea[] = [];
  const seen = new Set<string>();

  function visitSection(section: MarkdownSection) {
    // If this section title looks like a test area, extract it with its children as categories
    const isTestArea = /test area/i.test(section.title);

    if (isTestArea && hasTestCaseTables(section)) {
      const areaMatch = section.title.match(
        /^(?:Test Area\s*\d*:\s*)?(.+)$/i
      );
      const areaName = areaMatch ? areaMatch[1].trim() : section.title;
      const categories = extractCategories(section);
      if (categories.length > 0) {
        areas.push({ name: areaName, categories });
        for (const cat of categories) {
          for (const tc of cat.testCases) {
            seen.add(tc.id);
          }
        }
        return;
      }
    }

    // Otherwise, if this section has test case tables and no "test area" children,
    // treat it as its own area
    if (
      hasTestCaseTables(section) &&
      !section.children.some((c) => /test area/i.test(c.title))
    ) {
      const categories = extractCategories(section);
      const newCategories = categories
        .map((cat) => ({
          ...cat,
          testCases: cat.testCases.filter((tc) => !seen.has(tc.id)),
        }))
        .filter((cat) => cat.testCases.length > 0);

      if (newCategories.length > 0) {
        const areaName = section.title.replace(/^(?:Test Area\s*\d*:\s*)/i, "").trim();
        areas.push({ name: areaName, categories: newCategories });
        for (const cat of newCategories) {
          for (const tc of cat.testCases) {
            seen.add(tc.id);
          }
        }
      }
    }

    for (const child of section.children) {
      visitSection(child);
    }
  }

  for (const section of sections) {
    visitSection(section);
  }

  if (areas.length === 0) {
    const flatCases = extractFlatTestCases(sections);
    if (flatCases.length > 0) {
      areas.push({
        name: "Test Cases",
        categories: [{ name: "General", testCases: flatCases }],
      });
    }
  }

  return areas;
}

function hasTestCaseTables(section: MarkdownSection): boolean {
  const allContent = gatherContent(section);
  const tables = findAllTables(allContent);
  return tables.some((table) => isTestCaseTable(table));
}

function gatherContent(section: MarkdownSection): string {
  let content = section.content;
  for (const child of section.children) {
    content += "\n## " + child.title + "\n" + gatherContent(child);
  }
  return content;
}

function isTestCaseTable(table: TableRow[]): boolean {
  if (table.length === 0) return false;
  const headers = Object.keys(table[0]).map((h) => h.toLowerCase());
  return (
    headers.some(
      (h) =>
        h.includes("test case") ||
        h.includes("scenario") ||
        h.includes("description")
    ) &&
    headers.some(
      (h) =>
        h.includes("step") ||
        h.includes("expected") ||
        h.includes("result")
    )
  );
}

function extractCategories(section: MarkdownSection): TestCategory[] {
  const categories: TestCategory[] = [];

  // Check if section itself has categories as children
  if (section.children.length > 0) {
    for (const child of section.children) {
      const catMatch = child.title.match(/^(?:Category:\s*)?(.+)$/i);
      const catName = catMatch ? catMatch[1].trim() : child.title;
      const cases = parseTestCasesFromContent(child.content);

      // Also check sub-children
      for (const grandchild of child.children) {
        cases.push(...parseTestCasesFromContent(grandchild.content));
      }

      if (cases.length > 0) {
        categories.push({ name: catName, testCases: cases });
      }
    }
  }

  // Also check the section's own content for tables
  const directCases = parseTestCasesFromContent(section.content);
  if (directCases.length > 0) {
    categories.push({ name: section.title, testCases: directCases });
  }

  return categories;
}

function parseTestCasesFromContent(content: string): TestCase[] {
  const cases: TestCase[] = [];
  const tables = findAllTables(content);

  for (const table of tables) {
    if (!isTestCaseTable(table)) continue;

    for (const row of table) {
      const id =
        findColumn(row, ["#", "id", "ID", "No", "no", "Number"]) || "";
      const description =
        findColumn(row, [
          "Test Case",
          "test case",
          "Scenarios",
          "scenarios",
          "Scenario",
          "scenario",
          "Description",
          "description",
        ]) || "";
      const stepsText =
        findColumn(row, [
          "Steps to Test",
          "steps to test",
          "Steps",
          "steps",
          "Test Steps",
          "test steps",
        ]) || "";
      const expectedResult =
        findColumn(row, [
          "Expected Result",
          "expected result",
          "Expected Result(s)",
          "expected result(s)",
          "Expected",
          "expected",
        ]) || "";
      const priorityText =
        findColumn(row, ["Priority", "priority"]) || "must_have";

      if (!description.trim()) continue;

      const steps = parseSteps(stepsText);
      const priority = parsePriority(priorityText);

      cases.push({
        id: id.trim() || `TC-${cases.length + 1}`,
        description: cleanText(description),
        priority,
        steps,
        expectedResult: cleanText(expectedResult),
      });
    }
  }

  return cases;
}

function extractFlatTestCases(sections: MarkdownSection[]): TestCase[] {
  const cases: TestCase[] = [];

  function visit(section: MarkdownSection) {
    cases.push(...parseTestCasesFromContent(section.content));
    for (const child of section.children) {
      visit(child);
    }
  }

  for (const section of sections) {
    visit(section);
  }

  return cases;
}

function parseSteps(text: string): TestStep[] {
  const cleaned = cleanText(text);
  if (!cleaned) return [{ order: 1, instruction: "Follow test case description" }];

  // Try numbered steps: "1. ...", "2. ..."
  const numbered = cleaned.split(/(?:^|\n)\s*(\d+)\.\s+/);
  if (numbered.length > 2) {
    const steps: TestStep[] = [];
    for (let i = 1; i < numbered.length; i += 2) {
      const order = parseInt(numbered[i], 10);
      const instruction = numbered[i + 1]?.trim();
      if (instruction) {
        steps.push({ order, instruction });
      }
    }
    if (steps.length > 0) return steps;
  }

  // Try bullet points
  const bullets = cleaned.split(/\n\s*[•\-\*]\s+/);
  if (bullets.length > 1) {
    return bullets
      .map((b) => b.trim())
      .filter(Boolean)
      .map((instruction, i) => ({ order: i + 1, instruction }));
  }

  // Try newline-separated
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

function parseTable(content: string): TableRow[] {
  const tables = findAllTables(content);
  return tables[0] || [];
}

function findAllTables(content: string): TableRow[][] {
  const results: TableRow[][] = [];
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Detect a pipe-delimited table header
    if (line.startsWith("|") && line.endsWith("|") && line.includes("|")) {
      const headers = parsePipeRow(line);

      // Skip separator row(s)
      let j = i + 1;
      while (
        j < lines.length &&
        lines[j].trim().match(/^\|[\s\-:]+\|/)
      ) {
        j++;
      }

      const rows: TableRow[] = [];
      while (j < lines.length) {
        const rowLine = lines[j].trim();
        if (!rowLine.startsWith("|") || !rowLine.endsWith("|")) break;

        const cells = parsePipeRow(rowLine);
        if (cells.length === 0) break;

        const row: TableRow = {};
        for (let k = 0; k < headers.length; k++) {
          row[headers[k]] = cells[k] || "";
        }
        rows.push(row);
        j++;
      }

      if (rows.length > 0) {
        results.push(rows);
      }
      i = j;
    } else {
      i++;
    }
  }

  // Also handle tab-separated tables (spreadsheet paste)
  if (results.length === 0) {
    const tsvTables = findTsvTables(content);
    results.push(...tsvTables);
  }

  return results;
}

function findTsvTables(content: string): TableRow[][] {
  const results: TableRow[][] = [];
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.includes("\t")) {
      const headers = line.split("\t").map((h) => h.trim());
      const rows: TableRow[] = [];
      let j = i + 1;

      while (j < lines.length && lines[j].includes("\t")) {
        const cells = lines[j].split("\t").map((c) => c.trim());
        const row: TableRow = {};
        for (let k = 0; k < headers.length; k++) {
          row[headers[k]] = cells[k] || "";
        }
        rows.push(row);
        j++;
      }

      if (rows.length > 0) {
        results.push(rows);
      }
      i = j;
    } else {
      i++;
    }
  }

  return results;
}

function parsePipeRow(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function findColumn(row: TableRow, candidates: string[]): string | undefined {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key].trim()) return row[key];
  }
  // Fuzzy: check if any row key contains the candidate
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

function cleanText(text: string): string {
  return text
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}
