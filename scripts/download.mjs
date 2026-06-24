#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { chromium } from "playwright";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const URL_RE = /https?:\/\/(?:v\.douyin\.com|www\.douyin\.com|(?:www\.)?iesdouyin\.com)\/[^\s<>"']+/gi;
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000, 90_000, 120_000];

function usage() {
  console.log(`
Usage:
  node scripts/download.mjs [options] "share text or URL" ...

Options:
  --input <file>                 Read share text/URLs from a UTF-8 file
  --output <dir>                 Output directory (default: ./downloads)
  --parse-concurrency <n>        Concurrent browser parsers (default: 3)
  --download-concurrency <n>     Concurrent media downloads (default: 6)
  --max-attempts <n>             Attempts per item; 0 retries forever (default: 10)
  --page-timeout <seconds>       Page navigation timeout (default: 45)
  --media-wait <seconds>         Wait for media after navigation (default: 25)
  --download-timeout <seconds>   Total time allowed per transfer (default: 900)
  --headed                       Show the browser for verification fallback
  --storage-state <file>         Optional Playwright storage-state JSON
  --help                         Show this help

Rerun with the same output directory to resume from download-state.json.
`);
}

function parsePositiveInt(value, option, { allowZero = false } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${option} requires ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    input: null,
    output: path.resolve("downloads"),
    parseConcurrency: 3,
    downloadConcurrency: 6,
    maxAttempts: 10,
    pageTimeoutMs: 45_000,
    mediaWaitMs: 25_000,
    downloadTimeoutMs: 900_000,
    headed: false,
    storageState: null,
    texts: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === "--input") options.input = path.resolve(next());
    else if (arg === "--output") options.output = path.resolve(next());
    else if (arg === "--parse-concurrency") options.parseConcurrency = parsePositiveInt(next(), arg);
    else if (arg === "--download-concurrency") options.downloadConcurrency = parsePositiveInt(next(), arg);
    else if (arg === "--max-attempts") options.maxAttempts = parsePositiveInt(next(), arg, { allowZero: true });
    else if (arg === "--page-timeout") options.pageTimeoutMs = parsePositiveInt(next(), arg) * 1_000;
    else if (arg === "--media-wait") options.mediaWaitMs = parsePositiveInt(next(), arg) * 1_000;
    else if (arg === "--download-timeout") options.downloadTimeoutMs = parsePositiveInt(next(), arg) * 1_000;
    else if (arg === "--storage-state") options.storageState = path.resolve(next());
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else options.texts.push(arg);
  }
  return options;
}

function extractUrls(text) {
  return [...text.matchAll(URL_RE)].map((match) =>
    match[0].replace(/[，。！？；：、,.!?;:)}\]>]+$/u, ""),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleWithin(promise, timeoutMs) {
  await Promise.race([promise.catch(() => {}), sleep(timeoutMs)]);
}

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

function retryDelay(attempt) {
  const base = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
  return base + Math.floor(Math.random() * Math.min(base / 3, 5_000));
}

function sanitizeName(value, fallback = "douyin-video") {
  const clean = value
    .replace(/\s*-\s*抖音\s*$/u, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (clean || fallback).slice(0, 100);
}

function itemKey(url) {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
}

function awemeIdFromUrl(url) {
  return url.match(/\/(?:video|note)\/(\d+)/)?.[1] ?? null;
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async use(fn) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

class StateStore {
  constructor(outputDir) {
    this.file = path.join(outputDir, "download-state.json");
    this.data = { version: 1, updatedAt: null, items: {} };
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      this.data = JSON.parse(await fsp.readFile(this.file, "utf8"));
      if (!this.data.items) this.data.items = {};
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  get(url) {
    return this.data.items[url] ?? null;
  }

  async update(url, patch) {
    this.data.items[url] = {
      ...(this.data.items[url] ?? { sourceUrl: url }),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.data.updatedAt = new Date().toISOString();
    this.writeChain = this.writeChain.then(async () => {
      const temp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      try {
        await fsp.rename(temp, this.file);
      } catch (error) {
        if (process.platform !== "win32") throw error;
        await fsp.rm(this.file, { force: true });
        await fsp.rename(temp, this.file);
      }
    });
    await this.writeChain;
  }
}

class BrowserManager {
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
    // BrowserServer can report a completed close while Chromium descendants are
    // still alive on Windows. Always reap the dedicated process tree by PID.
    forceKillTree(this.browserPid ?? child?.pid);
    this.browser = null;
    this.server = null;
    this.browserPid = null;
  }
}

function candidateScore(candidate) {
  let bitrate = 0;
  try {
    bitrate = Number(new URL(candidate.url).searchParams.get("br") ?? 0);
  } catch {}
  return (candidate.totalBytes ?? 0) * 10 + bitrate;
}

function collectMediaUrls(value, results, depth = 0) {
  if (depth > 12 || value == null) return;
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value) && /(douyinvod\.com|aweme\/v1\/play)/i.test(value)) {
      results.push({ url: value.replaceAll("\\u0026", "&"), totalBytes: 0, source: "detail-json" });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectMediaUrls(child, results, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value)) collectMediaUrls(child, results, depth + 1);
  }
}

async function parseVideo(browserManager, url, options) {
  const browser = await browserManager.start();
  const contextOptions = {
    locale: "zh-CN",
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 720 },
    extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9" },
  };
  if (options.storageState) contextOptions.storageState = options.storageState;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const candidates = [];
  let detailStatus = null;
  let permanentReason = null;

  const addCandidate = (candidate) => {
    if (!candidate.url || candidates.some((item) => item.url === candidate.url)) return;
    candidates.push(candidate);
  };

  page.on("response", async (response) => {
    const responseUrl = response.url();
    const headers = response.headers();
    const contentType = headers["content-type"] ?? "";
    if (/douyinvod\.com/i.test(responseUrl) || contentType.startsWith("video/")) {
      const total = Number(headers["content-range"]?.match(/\/(\d+)$/)?.[1] ?? headers["content-length"] ?? 0);
      addCandidate({ url: responseUrl, totalBytes: total, source: "media-response" });
    }
    if (/\/aweme\/v1\/web\/aweme\/detail\//.test(responseUrl)) {
      detailStatus = response.status();
      if (response.ok()) {
        try {
          const json = await response.json();
          collectMediaUrls(json, candidates);
          const statusCode = json?.status_code ?? json?.aweme_detail?.status?.is_delete;
          if (statusCode && statusCode !== 0) permanentReason = `Douyin detail status: ${statusCode}`;
        } catch {}
      }
    }
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.pageTimeoutMs });
    const deadline = Date.now() + options.mediaWaitMs;
    let firstSeenAt = null;
    while (Date.now() < deadline) {
      if (candidates.length > 0) {
        firstSeenAt ??= Date.now();
        if (Date.now() - firstSeenAt >= 2_000) break;
      }
      await sleep(250);
    }

    const finalUrl = page.url();
    const title = sanitizeName(await page.title().catch(() => ""));
    const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
    if (/作品不存在|视频不见了|已删除|暂无权限|私密作品/u.test(bodyText)) {
      permanentReason = bodyText.match(/作品不存在|视频不见了|已删除|暂无权限|私密作品/u)?.[0];
    }
    if (candidates.length === 0) {
      const challenge = /验证码|安全验证|完成验证|captcha/i.test(bodyText);
      const reason = permanentReason ?? (challenge ? "Douyin verification challenge" : `No media response (detail status ${detailStatus ?? "unknown"})`);
      const error = new Error(reason);
      error.permanent = Boolean(permanentReason);
      throw error;
    }

    candidates.sort((a, b) => candidateScore(b) - candidateScore(a));
    return {
      sourceUrl: url,
      finalUrl,
      awemeId: awemeIdFromUrl(finalUrl) ?? itemKey(url),
      title,
      mediaUrl: candidates[0].url,
      candidateCount: candidates.length,
    };
  } finally {
    // Stop active range requests before disposing the context. Douyin's player can
    // otherwise keep context.close() waiting for minutes on Windows.
    await page.goto("about:blank", { waitUntil: "commit", timeout: 3_000 }).catch(() => {});
    await settleWithin(context.close(), 5_000);
  }
}

async function isValidMp4(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size < 1_024) return false;
    const handle = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(64);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).includes(Buffer.from("ftyp"));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function downloadMedia(parsed, outputDir, timeoutMs) {
  const filename = `${sanitizeName(parsed.title)}_${parsed.awemeId}.mp4`;
  const finalPath = path.join(outputDir, filename);
  const partialPath = `${finalPath}.part`;
  if (await isValidMp4(finalPath)) {
    const stat = await fsp.stat(finalPath);
    return { filePath: finalPath, bytes: stat.size, skipped: true };
  }

  await fsp.rm(partialPath, { force: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Download timeout")), timeoutMs);
  try {
    const response = await fetch(parsed.mediaUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Referer: "https://www.douyin.com/",
        "User-Agent": USER_AGENT,
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok || !response.body) throw new Error(`Media request returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("video") && !contentType.includes("octet-stream")) {
      throw new Error(`Unexpected media content-type: ${contentType || "missing"}`);
    }
    const output = fs.createWriteStream(partialPath, { flags: "wx" });
    await finished(Readable.fromWeb(response.body).pipe(output));

    const stat = await fsp.stat(partialPath);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    const rangeTotal = Number(response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1] ?? 0);
    const expected = rangeTotal || contentLength;
    if (expected > 0 && stat.size !== expected) {
      throw new Error(`Incomplete media: expected ${expected} bytes, received ${stat.size}`);
    }
    if (!(await isValidMp4(partialPath))) throw new Error("Downloaded file is not a valid MP4 container");
    await fsp.rm(finalPath, { force: true });
    await fsp.rename(partialPath, finalPath);
    return { filePath: finalPath, bytes: stat.size, skipped: false };
  } catch (error) {
    await fsp.rm(partialPath, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    usage();
    return;
  }

  let inputText = options.texts.join("\n");
  if (options.input) inputText += `\n${await fsp.readFile(options.input, "utf8")}`;
  const urls = [...new Set(extractUrls(inputText))];
  if (urls.length === 0) {
    console.error("No supported Douyin URLs were found.");
    process.exitCode = 2;
    return;
  }

  await fsp.mkdir(options.output, { recursive: true });
  const store = new StateStore(options.output);
  await store.load();
  const parseSemaphore = new Semaphore(options.parseConcurrency);
  const downloadSemaphore = new Semaphore(options.downloadConcurrency);
  const browserManager = new BrowserManager(options.headed);
  const results = [];
  let stopping = false;

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping after current operations...");
    await browserManager.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log(
    `[batch] ${urls.length} unique URL(s), parse concurrency ${options.parseConcurrency}, ` +
      `download concurrency ${options.downloadConcurrency}, output ${options.output}`,
  );

  async function processItem(url, index) {
    const label = `[${index + 1}/${urls.length}]`;
    const previous = store.get(url);
    if (previous?.status === "completed" && previous.filePath && (await isValidMp4(previous.filePath))) {
      console.log(`${label} already complete: ${previous.filePath}`);
      const result = { url, status: "completed", filePath: previous.filePath, bytes: previous.bytes, resumed: true };
      results.push(result);
      return;
    }

    let attempt = 0;
    while (!stopping && (options.maxAttempts === 0 || attempt < options.maxAttempts)) {
      attempt += 1;
      await store.update(url, { status: "parsing", attempt, lastError: null });
      console.log(`${label} parse attempt ${attempt}${options.maxAttempts ? `/${options.maxAttempts}` : ""}: ${url}`);
      try {
        const parsed = await parseSemaphore.use(() => parseVideo(browserManager, url, options));
        await store.update(url, {
          status: "downloading",
          attempt,
          awemeId: parsed.awemeId,
          title: parsed.title,
          finalUrl: parsed.finalUrl,
        });
        const downloaded = await downloadSemaphore.use(() =>
          downloadMedia(parsed, options.output, options.downloadTimeoutMs),
        );
        const completed = {
          status: "completed",
          attempt,
          awemeId: parsed.awemeId,
          title: parsed.title,
          finalUrl: parsed.finalUrl,
          filePath: downloaded.filePath,
          bytes: downloaded.bytes,
          lastError: null,
        };
        await store.update(url, completed);
        console.log(`${label} complete (${downloaded.bytes} bytes): ${downloaded.filePath}`);
        results.push({ url, ...completed });
        return;
      } catch (error) {
        const permanent = Boolean(error.permanent);
        const status = permanent ? "permanent_failure" : "retrying";
        await store.update(url, { status, attempt, lastError: error.message });
        console.warn(`${label} ${status}: ${error.message}`);
        if (permanent) {
          results.push({ url, status, attempt, error: error.message });
          return;
        }
        if (options.maxAttempts !== 0 && attempt >= options.maxAttempts) break;
        await sleep(retryDelay(attempt));
      }
    }

    const lastError = store.get(url)?.lastError ?? (stopping ? "Interrupted" : "Attempts exhausted");
    await store.update(url, { status: "failed", attempt, lastError });
    results.push({ url, status: "failed", attempt, error: lastError });
  }

  try {
    await Promise.all(urls.map(processItem));
  } finally {
    await browserManager.close();
  }

  const summary = {
    total: urls.length,
    completed: results.filter((item) => item.status === "completed").length,
    failed: results.filter((item) => item.status === "failed").length,
    permanentFailures: results.filter((item) => item.status === "permanent_failure").length,
    outputDir: options.output,
    stateFile: store.file,
    results,
  };
  const summaryFile = path.join(options.output, "download-summary.json");
  await fsp.writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
  const exitCode = summary.completed === summary.total ? 0 : 1;
  process.exitCode = exitCode;
  // Playwright occasionally leaves transport handles referenced after its browser
  // process is gone. State and summary are already durable, so terminate the CLI.
  setTimeout(() => process.exit(exitCode), 100);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
