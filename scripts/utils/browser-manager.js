import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { settleWithin, USER_AGENT } from "./common.js";

function forceKillTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

export class BrowserManager {
  constructor(headed) {
    this.headed = headed;
    this.browser = null;
    this.server = null;
    this.browserPid = null;
    this.startLock = Promise.resolve();
  }

  async start() {
    let release;
    const previous = this.startLock;
    this.startLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.browser?.isConnected()) return this.browser;
      const attempts = [
        { name: "Playwright Chromium", options: {} },
        { name: "Microsoft Edge", options: { channel: "msedge" } },
        { name: "Google Chrome", options: { channel: "chrome" } },
      ];
      const errors = [];
      for (const candidate of attempts) {
        try {
          this.server = await chromium.launchServer({
            headless: !this.headed,
            ...candidate.options,
            args: ["--autoplay-policy=no-user-gesture-required"],
          });
          this.browserPid = this.server.process()?.pid ?? null;
          this.browser = await chromium.connect(this.server.wsEndpoint());
          console.log(`[browser] using ${candidate.name}`);
          return this.browser;
        } catch (error) {
          await this.server?.kill().catch(() => {});
          this.server = null;
          this.browserPid = null;
          errors.push(`${candidate.name}: ${error.message.split("\n")[0]}`);
        }
      }
      throw new Error(`No supported browser could launch. Run node scripts/setup.mjs. ${errors.join(" | ")}`);
    } finally {
      release();
    }
  }

  async close() {
    const server = this.server;
    const child = server?.process();
    if (this.browser) await settleWithin(this.browser.close(), 1_500);
    if (server && child?.exitCode == null) await settleWithin(server.kill(), 1_500);
    forceKillTree(this.browserPid ?? child?.pid);
    this.browser = null;
    this.server = null;
    this.browserPid = null;
  }

  getUserAgent() {
    return USER_AGENT;
  }
}
