import { BrowserManager } from "@boatman/core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ActionPlan,
  PlannedAction,
  ExecutionResult,
  ActionResult,
  ScreenshotCapture,
} from "../types.js";

export class ActionExecutor {
  private browser: BrowserManager;
  private outputDir: string;

  constructor(browser: BrowserManager, outputDir: string) {
    this.browser = browser;
    this.outputDir = outputDir;
  }

  async execute(
    plan: ActionPlan,
    screenshotEveryStep = false
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const actionResults: ActionResult[] = [];
    const screenshots: ScreenshotCapture[] = [];
    const consoleErrors: string[] = [];

    const caseDir = join(this.outputDir, plan.testCaseId);
    await mkdir(caseDir, { recursive: true });

    const page = await this.browser.ensureBrowser();
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    for (const action of plan.actions) {
      const result = await this.executeAction(action, page);
      actionResults.push(result);

      if (!result.success) {
        const diagPath = join(caseDir, `error-step-${action.order}.png`);
        try {
          const buf = await this.browser.screenshot();
          await writeFile(diagPath, buf);
          screenshots.push({
            path: diagPath,
            buffer: buf,
            afterAction: action.order,
            timestamp: Date.now(),
            description: `Diagnostic screenshot after failure on step ${action.order}`,
          });
        } catch {
          // browser may be in a bad state
        }
        return {
          testCaseId: plan.testCaseId,
          actionResults,
          screenshots,
          consoleErrors,
          error: `Action ${action.order} (${action.type}) failed: ${result.error}`,
          durationMs: Date.now() - startTime,
        };
      }

      const shouldScreenshot =
        action.screenshotAfter ||
        screenshotEveryStep ||
        action.type === "screenshot";

      if (shouldScreenshot) {
        try {
          const buf = await this.browser.screenshot({ fullPage: true });
          const screenshotPath = join(
            caseDir,
            `step-${action.order}.png`
          );
          await writeFile(screenshotPath, buf);
          screenshots.push({
            path: screenshotPath,
            buffer: buf,
            afterAction: action.order,
            timestamp: Date.now(),
            description: action.description,
          });
        } catch (err) {
          consoleErrors.push(
            `Failed to capture screenshot after step ${action.order}: ${err}`
          );
        }
      }
    }

    return {
      testCaseId: plan.testCaseId,
      actionResults,
      screenshots,
      consoleErrors,
      durationMs: Date.now() - startTime,
    };
  }

  private async executeAction(
    action: PlannedAction,
    page: Awaited<ReturnType<BrowserManager["ensureBrowser"]>>
  ): Promise<ActionResult> {
    const timestamp = Date.now();
    try {
      switch (action.type) {
        case "navigate": {
          if (!action.target) throw new Error("Navigate requires a target URL");
          await this.browser.navigate(action.target);
          break;
        }
        case "click": {
          if (!action.target) throw new Error("Click requires a target selector");
          await this.browser.interact({
            action: "click",
            selector: action.target,
          });
          break;
        }
        case "type": {
          if (!action.target) throw new Error("Type requires a target selector");
          await this.browser.interact({
            action: "type",
            selector: action.target,
            value: action.value ?? "",
          });
          break;
        }
        case "scroll": {
          const scrollY = parseInt(action.value || "500", 10);
          await this.browser.interact({
            action: "scroll",
            selector: "body",
            scrollY,
          });
          break;
        }
        case "hover": {
          if (!action.target) throw new Error("Hover requires a target selector");
          await this.browser.interact({
            action: "hover",
            selector: action.target,
          });
          break;
        }
        case "wait": {
          const ms = parseInt(action.value || "2000", 10);
          await page.waitForTimeout(ms);
          break;
        }
        case "screenshot": {
          // Actual capture happens in the post-action block; this is a no-op.
          break;
        }
        case "select": {
          if (!action.target)
            throw new Error("Select requires a target selector");
          await this.browser.interact({
            action: "click",
            selector: action.target,
          });
          await page.waitForTimeout(500);
          if (action.value) {
            await this.browser.interact({
              action: "click",
              selector: `text=${action.value}`,
            });
          }
          break;
        }
        case "press_key": {
          if (!action.value) throw new Error("press_key requires a value (key name)");
          await page.keyboard.press(action.value);
          break;
        }
        default: {
          throw new Error(`Unknown action type: ${action.type}`);
        }
      }

      return { action, success: true, timestamp };
    } catch (err) {
      return {
        action,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        timestamp,
      };
    }
  }
}
