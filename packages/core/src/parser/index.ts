import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { TestPlan } from "../types.js";
import { parseMarkdownTestPlan } from "./markdown-parser.js";
import { parseCsvTestPlan } from "./csv-parser.js";

export function parseTestPlan(
  content: string,
  filePath: string,
  baseUrl: string
): TestPlan {
  const ext = extname(filePath).toLowerCase();

  switch (ext) {
    case ".csv":
    case ".tsv":
      return parseCsvTestPlan(content, baseUrl);
    case ".md":
    case ".markdown":
      return parseMarkdownTestPlan(content, baseUrl);
    default:
      if (content.includes("|") && content.includes("#")) {
        return parseMarkdownTestPlan(content, baseUrl);
      }
      if (looksLikeCsv(content)) {
        return parseCsvTestPlan(content, baseUrl);
      }
      return parseMarkdownTestPlan(content, baseUrl);
  }
}

export async function parseTestPlanFile(
  filePath: string,
  baseUrl: string
): Promise<TestPlan> {
  const content = await readFile(filePath, "utf-8");
  return parseTestPlan(content, filePath, baseUrl);
}

function looksLikeCsv(content: string): boolean {
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return false;

  const firstLineTabCount = (lines[0].match(/\t/g) || []).length;
  const firstLineCommaCount = (lines[0].match(/,/g) || []).length;

  if (firstLineTabCount >= 2) {
    const secondLineTabCount = (lines[1].match(/\t/g) || []).length;
    return Math.abs(firstLineTabCount - secondLineTabCount) <= 2;
  }

  if (firstLineCommaCount >= 2) {
    const secondLineCommaCount = (lines[1].match(/,/g) || []).length;
    return Math.abs(firstLineCommaCount - secondLineCommaCount) <= 2;
  }

  return false;
}

export { parseMarkdownTestPlan } from "./markdown-parser.js";
export { parseCsvTestPlan } from "./csv-parser.js";
