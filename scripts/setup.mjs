import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

async function canLaunch() {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

if (await canLaunch()) {
  console.log("Playwright Chromium is ready.");
  process.exit(0);
}

console.log("Installing Playwright Chromium...");
const skillRoot = fileURLToPath(new URL("..", import.meta.url));
const playwrightCli = path.join(skillRoot, "node_modules", "playwright", "cli.js");
const result = spawnSync(process.execPath, [playwrightCli, "install", "chromium"], {
  cwd: skillRoot,
  stdio: "inherit",
  shell: false,
});

if (result.status !== 0 || !(await canLaunch())) {
  if (result.error) console.error(result.error.message);
  console.error("Chromium installation did not complete successfully.");
  process.exit(1);
}

console.log("Playwright Chromium is ready.");
