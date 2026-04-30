import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TestRunReport } from "../types.js";

export async function generateJSONReport(
  report: TestRunReport,
  outputPath: string
): Promise<string> {
  const sanitized = JSON.parse(JSON.stringify(report, (key, value) => {
    if (key === "buffer" && value?.type === "Buffer") return undefined;
    if (key === "buffer" && Buffer.isBuffer(value)) return undefined;
    return value;
  }));

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(sanitized, null, 2), "utf-8");
  return outputPath;
}
