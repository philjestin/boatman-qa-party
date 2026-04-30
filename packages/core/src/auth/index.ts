import { BrowserManager } from "@boatman/core";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { Credential } from "../types.js";

const AUTH_DIR = resolve(homedir(), ".boatman", "qa-party");

function authStatePath(credential: Credential): string {
  const hash = createHash("md5")
    .update(credential.username)
    .digest("hex")
    .slice(0, 8);
  return resolve(AUTH_DIR, `auth-${hash}.json`);
}

export class AuthManager {
  private browsers = new Map<string, BrowserManager>();
  private activeBrowser: BrowserManager | null = null;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  hasAuthState(credential: Credential): boolean {
    return existsSync(authStatePath(credential));
  }

  async authenticate(
    credential: Credential,
    options: { headless?: boolean } = {}
  ): Promise<BrowserManager> {
    const statePath = authStatePath(credential);
    await mkdir(AUTH_DIR, { recursive: true });

    const browser = new BrowserManager({
      storageStatePath: statePath,
      headless: options.headless !== false,
    });

    if (this.hasAuthState(credential)) {
      this.browsers.set(credential.username, browser);
      this.activeBrowser = browser;
      return browser;
    }

    // Programmatic login
    const page = await browser.ensureBrowser();
    const loginUrl = `${this.baseUrl}/login`;
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1000);

    // Fill email/username
    const emailSelector =
      'input[name="email"], input[name="username"], input[type="email"], #email, #username';
    await page.locator(emailSelector).first().fill(credential.username);

    // Fill password
    const passwordSelector =
      'input[name="password"], input[type="password"], #password';
    await page.locator(passwordSelector).first().fill(credential.password);

    // Submit
    const submitSelector =
      'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")';
    await page.locator(submitSelector).first().click();

    // Wait for redirect away from login
    const startTime = Date.now();
    const maxWait = 30_000;
    while (Date.now() - startTime < maxWait) {
      await page.waitForTimeout(1000);
      const url = page.url().toLowerCase();
      if (!url.includes("login") && !url.includes("sign_in")) {
        break;
      }
    }

    await page.waitForTimeout(2000);
    await browser.saveStorageState();

    this.browsers.set(credential.username, browser);
    this.activeBrowser = browser;
    return browser;
  }

  async authenticateManual(credential: Credential): Promise<BrowserManager> {
    const statePath = authStatePath(credential);
    await mkdir(AUTH_DIR, { recursive: true });

    const browser = new BrowserManager({
      storageStatePath: statePath,
      headless: false,
    });

    const loginUrl = `${this.baseUrl}/login`;
    await browser.authenticate(loginUrl);

    this.browsers.set(credential.username, browser);
    this.activeBrowser = browser;
    return browser;
  }

  async switchTo(credential: Credential): Promise<BrowserManager> {
    const existing = this.browsers.get(credential.username);
    if (existing) {
      this.activeBrowser = existing;
      return existing;
    }
    return this.authenticate(credential);
  }

  getActive(): BrowserManager | null {
    return this.activeBrowser;
  }

  async closeAll(): Promise<void> {
    for (const browser of this.browsers.values()) {
      await browser.close();
    }
    this.browsers.clear();
    this.activeBrowser = null;
  }
}
