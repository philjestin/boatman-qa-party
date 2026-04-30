import type { TestRunReport } from "../types.js";
import { generateJSONReport } from "./json-reporter.js";
import { generateHTMLReport } from "./html-reporter.js";

export class ReportGenerator {
  async generateJSON(
    report: TestRunReport,
    outputPath: string
  ): Promise<string> {
    return generateJSONReport(report, outputPath);
  }

  async generateHTML(
    report: TestRunReport,
    outputPath: string
  ): Promise<string> {
    return generateHTMLReport(report, outputPath);
  }
}
