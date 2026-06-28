#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { sleep, retryDelay, safeFilename, isValidMp4, getVideoInfo, USER_AGENT } from "./utils/common.js";
import { Semaphore } from "./utils/semaphore.js";
import { StateStore } from "./utils/state-store.js";
import { BrowserManager } from "./utils/browser-manager.js";
import { extractAndRouteUrls } from "./platforms/router.js";

function usage() {
  console.log(`
Usage:
  node scripts/download.mjs [options] "share text or URL" ...

Download options:
  --input <file>                 Read share text/URLs from a UTF-8 file
  --output <dir>                 Output directory (default: ./video_results)
  --parse-concurrency <n>        Concurrent browser parsers (default: 1)
  --download-concurrency <n>     Concurrent media downloads (default: 1)
  --max-attempts <n>             Attempts per item; 0 retries forever (default: 10)
  --page-timeout <seconds>       Page navigation timeout (default: 45)
  --media-wait <seconds>         Wait for media after navigation (default: 25)
  --download-timeout <seconds>   Total time allowed per transfer (default: 900)
  --headed                       Show the browser for verification fallback
  --storage-state <file>         Optional Playwright storage-state JSON

Transcription options:
  --no-transcribe                Skip Whisper transcription (download only)
  --model <name>                 Whisper model: small, medium, large-v3 (default: small)
  --language <code>              Language hint, auto = detect (default: auto)
  --device <cpu|cuda>            Transcription device (default: cpu)
  --compute-type <type>          Precision: int8, float16, float32 (default: int8)
  --no-simplify                  Skip Traditional→Simplified Chinese conversion
  --ffmpeg-path <path>           Path to ffmpeg executable
  --transcribe-timeout <secs>    Timeout per transcription in seconds (default: 600)

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
    output: path.resolve("video_results"),
    parseConcurrency: 1,
    downloadConcurrency: 1,
    maxAttempts: 10,
    pageTimeoutMs: 45_000,
    mediaWaitMs: 25_000,
    downloadTimeoutMs: 900_000,
    headed: false,
    storageState: null,
    // Transcription
    transcribe: true,
    model: "small",
    language: "auto",
    device: "cpu",
    computeType: "int8",
    simplify: true,
    ffmpegPath: null,
    transcribeTimeoutMs: 600_000,
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
    else if (arg === "--no-transcribe") options.transcribe = false;
    else if (arg === "--model") options.model = next();
    else if (arg === "--language") options.language = next();
    else if (arg === "--device") options.device = next();
    else if (arg === "--compute-type") options.computeType = next();
    else if (arg === "--no-simplify") options.simplify = false;
    else if (arg === "--ffmpeg-path") options.ffmpegPath = path.resolve(next());
    else if (arg === "--transcribe-timeout") options.transcribeTimeoutMs = parsePositiveInt(next(), arg) * 1_000;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else options.texts.push(arg);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Download (multi-stream support)
// ---------------------------------------------------------------------------

const _activeChildren = new Set();

async function downloadSingleStream(stream, videoId, suffix, outputDir, timeoutMs) {
  const tmpDir = path.join(outputDir, ".temp");
  await fsp.mkdir(tmpDir, { recursive: true });
  const ext = stream.format === "m4s" ? "m4s" : "mp4";
  const filename = `${videoId}${suffix}.${ext}`;
  const finalPath = path.join(tmpDir, filename);
  const partialPath = `${finalPath}.part`;

  if (await isValidMp4(finalPath)) {
    const stat = await fsp.stat(finalPath);
    return { filePath: finalPath, bytes: stat.size, skipped: true };
  }

  await fsp.rm(partialPath, { force: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Download timeout")), timeoutMs);

  try {
    const referer = stream.referer ?? "https://www.google.com/";
    const response = await fetch(stream.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Referer: referer,
        "User-Agent": USER_AGENT,
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok || !response.body) {
      throw new Error(`Media request returned HTTP ${response.status}`);
    }

    const output = fs.createWriteStream(partialPath, { flags: "wx" });
    const readable = Readable.fromWeb(response.body);
    await finished(readable.pipe(output));

    const stat = await fsp.stat(partialPath);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    const rangeTotal = Number(response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1] ?? 0);
    const expected = rangeTotal || contentLength;

    if (expected > 0 && stat.size !== expected) {
      throw new Error(`Incomplete media: expected ${expected} bytes, received ${stat.size}`);
    }

    if (!(await isValidMp4(partialPath))) {
      throw new Error("Downloaded file is not a valid MP4/M4S container");
    }

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

async function hasAudioTrack(filePath, ffmpegPath) {
  // Try ffprobe first (more reliable)
  const ffprobePath = ffmpegPath
    ? path.join(path.dirname(ffmpegPath), process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
    : "ffprobe";

  const tryFfprobe = () => new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      filePath,
    ];

    const child = spawn(ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    _activeChildren.add(child);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => {
      _activeChildren.delete(child);
      if (code === 0) {
        resolve(stdout.trim().includes("audio"));
      } else {
        resolve(null); // ffprobe failed, try ffmpeg
      }
    });
    child.on("error", () => { _activeChildren.delete(child); resolve(null); }); // ffprobe not found
  });

  const tryFfmpeg = () => new Promise((resolve) => {
    const exe = ffmpegPath || "ffmpeg";
    const args = ["-i", filePath, "-hide_banner", "-f", "null", "-"];
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    _activeChildren.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", () => {
      _activeChildren.delete(child);
      const hasAudio = stderr.includes("Audio:") ||
                       (stderr.includes("Stream #") && stderr.includes("audio"));
      resolve(hasAudio);
    });
    child.on("error", () => { _activeChildren.delete(child); resolve(false); }); // ffmpeg not found
  });

  // Try ffprobe first, then ffmpeg
  const ffprobeResult = await tryFfprobe();
  if (ffprobeResult !== null) return ffprobeResult;

  // Fallback to ffmpeg
  return await tryFfmpeg();
}

async function mergeStreams(videoPath, audioPath, videoId, outputDir, ffmpegPath) {
  const mergedPath = path.join(outputDir, ".temp", `${videoId}.mp4`);
  const exe = ffmpegPath || "ffmpeg";
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-c:v", "copy",
    "-c:a", "aac",
    "-movflags", "+faststart",
    mergedPath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    _activeChildren.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      _activeChildren.delete(child);
      if (code === 0) resolve(mergedPath);
      else {
        const err = new Error(`ffmpeg merge failed (exit ${code}): ${stderr.trim()}`);
        err.permanent = true;
        reject(err);
      }
    });
    child.on("error", (err) => {
      _activeChildren.delete(child);
      reject(new Error(`ffmpeg spawn error: ${err.message}`));
    });
  });
}

async function downloadMedia(parsed, outputDir, timeoutMs, ffmpegPath) {
  const streams = parsed.mediaStreams;

  // Single stream (e.g., Douyin or Bilibili durl fallback)
  if (streams.length === 1 && streams[0].type === "video+audio") {
    const downloaded = await downloadSingleStream(
      streams[0],
      parsed.videoId,
      "",
      outputDir,
      timeoutMs
    );
    const audioOk = await hasAudioTrack(downloaded.filePath, ffmpegPath);
    if (!audioOk) {
      await fsp.rm(downloaded.filePath, { force: true }).catch(() => {});
      throw new Error("Downloaded video has no audio track");
    }
    return downloaded;
  }

  // Multi-stream (e.g., Bilibili DASH)
  const videoStream = streams.find((s) => s.type === "video");
  const audioStream = streams.find((s) => s.type === "audio");

  if (!videoStream || !audioStream) {
    throw new Error("Invalid multi-stream: missing video or audio");
  }

  let videoFile = null;
  let audioFile = null;
  let mergedPath = null;

  try {
    [videoFile, audioFile] = await Promise.all([
      downloadSingleStream(videoStream, parsed.videoId, "_video", outputDir, timeoutMs),
      downloadSingleStream(audioStream, parsed.videoId, "_audio", outputDir, timeoutMs),
    ]);

    // Merge with ffmpeg
    mergedPath = await mergeStreams(
      videoFile.filePath,
      audioFile.filePath,
      parsed.videoId,
      outputDir,
      ffmpegPath
    );

    // Verify audio track exists
    const audioOk = await hasAudioTrack(mergedPath, ffmpegPath);
    if (!audioOk) {
      const err = new Error("Merged video has no audio track");
      err.permanent = true;
      throw err;
    }

    // Clean up intermediate files
    await fsp.rm(videoFile.filePath, { force: true });
    await fsp.rm(audioFile.filePath, { force: true });

    const stat = await fsp.stat(mergedPath);
    return { filePath: mergedPath, bytes: stat.size, skipped: false };
  } catch (error) {
    // Clean up intermediate files on any failure
    if (videoFile?.filePath) await fsp.rm(videoFile.filePath, { force: true }).catch(() => {});
    if (audioFile?.filePath) await fsp.rm(audioFile.filePath, { force: true }).catch(() => {});
    if (mergedPath) await fsp.rm(mergedPath, { force: true }).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Audio extraction (ffmpeg)
// ---------------------------------------------------------------------------

async function extractAudio(mp4Path, ffmpegPath) {
  const wavPath = mp4Path.replace(/\.mp4$/i, "_16k.wav");
  const exe = ffmpegPath || "ffmpeg";
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", mp4Path,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    wavPath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    _activeChildren.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      _activeChildren.delete(child);
      if (code === 0) resolve(wavPath);
      else reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.trim()}`));
    });
    child.on("error", (err) => {
      _activeChildren.delete(child);
      reject(new Error(`ffmpeg spawn error: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Transcription server
// ---------------------------------------------------------------------------

let _transcribeProc = null;
let _transcribeReady = false;
let _transcribeResolvers = [];
let _transcribeResponseBuf = "";
let _transcribeReadyPromise = null;

function getScriptDir() {
  const raw = path.dirname(new URL(import.meta.url).pathname);
  return process.platform === "win32" ? raw.replace(/^\/([A-Z]:)/i, "$1") : raw;
}

function spawnTranscribeServer(options) {
  const scriptDir = getScriptDir();
  const serverPath = path.join(scriptDir, "transcribe_server.py");

  // Try python3 (Unix), python (Windows), then py (Windows Launcher)
  const candidates = process.platform === "win32"
    ? ["python", "py"]
    : ["python3", "python"];

  let proc = null;
  let lastErr = null;
  for (const pyExe of candidates) {
    try {
      proc = spawn(pyExe, [
        serverPath,
        "--model", options.model,
        "--device", options.device,
        "--compute-type", options.computeType,
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: scriptDir,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      _activeChildren.add(proc);
      proc.once("close", () => _activeChildren.delete(proc));
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!proc) throw new Error(`Cannot find Python executable (tried: ${candidates.join(", ")}): ${lastErr?.message}`);

  _transcribeReadyPromise = new Promise((resolve, reject) => {
    proc.stderr.on("data", (chunk) => {
      const msg = chunk.toString();
      process.stderr.write(msg);
      if (!_transcribeReady && msg.includes("[server] model loaded")) {
        _transcribeReady = true;
        resolve();
      }
    });
    proc.once("error", (err) => {
      if (!_transcribeReady) reject(new Error(`transcribe_server spawn error: ${err.message}`));
    });
    proc.once("close", (code) => {
      const wasReady = _transcribeReady;
      _transcribeProc = null;
      _transcribeReady = false;
      const err = new Error(`transcribe_server exited (code ${code})`);
      if (!wasReady) reject(err);
      while (_transcribeResolvers.length) _transcribeResolvers.shift()({ error: err.message });
    });
  });

  proc.stdout.on("data", (chunk) => {
    _transcribeResponseBuf += chunk.toString();
    let nlIdx;
    while ((nlIdx = _transcribeResponseBuf.indexOf("\n")) !== -1) {
      const line = _transcribeResponseBuf.slice(0, nlIdx).trim();
      _transcribeResponseBuf = _transcribeResponseBuf.slice(nlIdx + 1);
      if (line && _transcribeResolvers.length) {
        const resolver = _transcribeResolvers.shift();
        try {
          resolver(JSON.parse(line));
        } catch {
          resolver({ error: `parse error: ${line.slice(0, 200)}` });
        }
      }
    }
  });

  proc.stdin.on("error", () => {});

  _transcribeProc = proc;
  return _transcribeReadyPromise;
}

function stopTranscribeServer() {
  if (!_transcribeProc) return;
  const proc = _transcribeProc;
  try {
    proc.stdin.write(JSON.stringify({ stop: true }) + "\n");
    proc.stdin.end();
  } catch {}
  setTimeout(() => {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }, 3000);
  _transcribeProc = null;
  _transcribeReady = false;
}

async function transcribeAudio(wavPath, options) {
  if (!_transcribeProc) throw new Error("transcribe server not running");

  const req = {
    wav_path: wavPath,
    model: options.model,
    language: options.language,
    device: options.device,
    compute_type: options.computeType,
    no_simplify: !options.simplify,
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = _transcribeResolvers.indexOf(resolver);
      if (idx !== -1) _transcribeResolvers.splice(idx, 1);
      reject(new Error("Transcription timeout"));
    }, options.transcribeTimeoutMs);

    const resolver = (result) => {
      clearTimeout(timer);
      if (result.error) reject(new Error(result.error));
      else resolve(result);
    };
    _transcribeResolvers.push(resolver);
    try {
      _transcribeProc.stdin.write(JSON.stringify(req) + "\n");
    } catch (err) {
      clearTimeout(timer);
      // Remove the resolver we just pushed to prevent mismatch
      const idx = _transcribeResolvers.indexOf(resolver);
      if (idx !== -1) _transcribeResolvers.splice(idx, 1);
      reject(new Error(`write to server failed: ${err.message}`));
    }
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function writeOutputs(parsed, transcribeResult, mp4Info, outputDir, options = {}) {
  const now = new Date();
  const timeStr = now.toISOString().replace("T", "_").replace(/[:.]/g, "-").slice(0, 19);
  const authorName = safeFilename(parsed.author?.nickname ?? "", 20);
  const vid = parsed.videoId;
  const base = `${timeStr}_${parsed.platform}_${authorName}_${vid}`;
  const itemDir = path.join(outputDir, base);

  fs.mkdirSync(itemDir, { recursive: true });

  const segments = transcribeResult?.segments ?? [];
  const transcript = transcribeResult?.transcript ?? "";
  const tMeta = transcribeResult?.meta ?? null;

  const result = {
    status: "success",
    source_url: parsed.sourceUrl,
    canonical_url: parsed.canonicalUrl,
    video_id: vid,
    platform: parsed.platform,
    content_type: "video",
    title: parsed.title,
    description: parsed.description,
    author: parsed.author,
    post_time: parsed.postTime,
    duration: parsed.duration,
    stats: parsed.statistics,
    transcript: transcript || null,
    segments: segments,
    transcript_source: tMeta ? "faster-whisper" : null,
    transcription: tMeta,
    media_info: null, // Will be filled by ffprobe
    output_file: null,
    transcript_file: null,
  };

  const jsonPath = path.join(itemDir, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
  result.output_file = jsonPath;

  if (transcript) {
    const txtPath = path.join(itemDir, `${base}_transcript.txt`);
    fs.writeFileSync(txtPath, transcript + "\n", "utf8");
    result.transcript_file = txtPath;
  }

  return { result, itemDir, jsonPath };
}

async function writeOutputsWithMediaInfo(parsed, transcribeResult, mp4Info, outputDir, options = {}) {
  const { result, itemDir, jsonPath } = writeOutputs(parsed, transcribeResult, mp4Info, outputDir, options);

  // Probe video file for resolution/bitrate
  if (mp4Info?.filePath) {
    try {
      const mediaInfo = await getVideoInfo(mp4Info.filePath, options.ffmpegPath ?? null);
      if (mediaInfo) {
        result.media_info = mediaInfo;
        // Re-write JSON with media_info
        fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");

        // Log quality info
        const res = mediaInfo.resolution ?? "unknown";
        const bitrate = mediaInfo.bitrate_kbps ? `${mediaInfo.bitrate_kbps} kbps` : "unknown";
        const codec = mediaInfo.codec ?? "unknown";
        console.log(`    [media] ${res}, ${bitrate}, ${codec}`);
      }
    } catch (err) {
      console.warn(`    [media] ffprobe failed: ${err.message}`);
    }
  }

  return { result, itemDir, jsonPath };
}

function writeFailedOutput(sourceUrl, errorMessage, errorType, outputDir, platform) {
  const now = new Date();
  const timeStr = now.toISOString().replace("T", "_").replace(/[:.]/g, "-").slice(0, 19);
  const safePlat = safeFilename(platform || "未知", 20);
  const safeErr = safeFilename(errorType, 20);
  const base = `${timeStr}_failed_${safePlat}_${safeErr}`;
  const itemDir = path.join(outputDir, base);
  fs.mkdirSync(itemDir, { recursive: true });

  const result = {
    status: "failed",
    source_url: sourceUrl,
    error: errorMessage,
    error_type: errorType,
  };
  if (platform) result.platform = platform;

  const jsonPath = path.join(itemDir, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
  return jsonPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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
  inputText = inputText.replace(/^﻿/, ""); // strip UTF-8 BOM

  const urlsWithParsers = extractAndRouteUrls(inputText);
  if (urlsWithParsers.length === 0) {
    console.error("No supported video URLs were found.");
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
    stopTranscribeServer();
    for (const child of _activeChildren) {
      try { child.kill("SIGTERM"); } catch {}
    }
    await browserManager.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log(
    `[batch] ${urlsWithParsers.length} unique URL(s), ` +
      `parse concurrency ${options.parseConcurrency}, ` +
      `download concurrency ${options.downloadConcurrency}, ` +
      `transcribe ${options.transcribe ? `on (serial, ${options.model}, ${options.device})` : "off"}, ` +
      `output ${options.output}`,
  );

  // Phase 1: Parse + Download
  console.log(`\n[phase 1] downloading ${urlsWithParsers.length} video(s)...`);

  async function processDownload({ url, ParserClass }, index) {
    const label = `[${index + 1}/${urlsWithParsers.length}]`;
    const previous = store.get(url);
    if (previous?.status === "completed" && previous.filePath && (await isValidMp4(previous.filePath))) {
      console.log(`${label} already complete: ${previous.filePath}`);
      results.push({
        url,
        status: "completed",
        filePath: previous.filePath,
        bytes: previous.bytes,
        resumed: true,
      });
      return;
    }

    let attempt = 0;
    while (!stopping && (options.maxAttempts === 0 || attempt < options.maxAttempts)) {
      attempt += 1;
      await store.update(url, { status: "parsing", attempt, lastError: null });
      console.log(`${label} parse attempt ${attempt}${options.maxAttempts ? `/${options.maxAttempts}` : ""}: ${url}`);

      try {
        const parser = new ParserClass();
        const parsed = await parseSemaphore.use(() => parser.parse(browserManager, url, options));

        await store.update(url, {
          status: "downloading",
          attempt,
          videoId: parsed.videoId,
          title: parsed.title,
          finalUrl: parsed.canonicalUrl,
        });

        const downloaded = await downloadSemaphore.use(() =>
          downloadMedia(parsed, options.output, options.downloadTimeoutMs, options.ffmpegPath)
        );

        await store.update(url, {
          status: "downloaded",
          attempt,
          filePath: downloaded.filePath,
          bytes: downloaded.bytes,
          parsed,
          lastError: null,
        });

        console.log(`${label} downloaded (${downloaded.bytes} bytes)`);
        results.push({
          url,
          status: "downloaded",
          filePath: downloaded.filePath,
          bytes: downloaded.bytes,
        });
        return;
      } catch (error) {
        const permanent = Boolean(error.permanent);
        const status = permanent ? "permanent_failure" : "retrying";
        await store.update(url, { status, attempt, lastError: error.message });
        console.warn(`${label} ${status}: ${error.message}`);

        if (permanent) {
          writeFailedOutput(url, error.message, "permanent", options.output, ParserClass.getPlatformName());
          results.push({ url, status, attempt, error: error.message });
          return;
        }

        if (options.maxAttempts !== 0 && attempt >= options.maxAttempts) break;
        await sleep(retryDelay(attempt));
      }
    }

    const lastError = store.get(url)?.lastError ?? (stopping ? "Interrupted" : "Attempts exhausted");
    await store.update(url, { status: "failed", attempt, lastError });
    writeFailedOutput(url, lastError, "exhausted", options.output, ParserClass.getPlatformName());
    results.push({ url, status: "failed", attempt, error: lastError });
  }

  try {
    await Promise.all(
      urlsWithParsers.map((item, index) =>
        processDownload(item, index).catch((error) => {
          console.error(`[${index + 1}/${urlsWithParsers.length}] unexpected error: ${error.message}`);
          writeFailedOutput(item.url, error.message, "unexpected", options.output, item.ParserClass.getPlatformName());
          results.push({ url: item.url, status: "failed", error: error.message });
        })
      )
    );
  } finally {
    await browserManager.close();
    console.log("[phase 1] browser closed\n");
  }

  // Phase 1.5: Write outputs for downloaded items (skip-transcribe mode)
  if (!options.transcribe) {
    const urls = urlsWithParsers.map((item) => item.url);
    const downloaded = urls
      .map((url) => ({ url, state: store.get(url) }))
      .filter((item) => item.state?.status === "downloaded" && item.state?.filePath && item.state?.parsed);

    if (downloaded.length > 0) {
      console.log(`[phase 1.5] writing outputs for ${downloaded.length} video(s) (transcription skipped)...`);
      for (const { url, state } of downloaded) {
        try {
          const { jsonPath } = await writeOutputsWithMediaInfo(
            state.parsed,
            null,
            { filePath: state.filePath, bytes: state.bytes },
            options.output,
            options
          );
          await store.update(url, {
            status: "completed",
            jsonPath,
            hasTranscript: false,
            lastError: null,
          });
          console.log(`  completed: ${jsonPath}`);
        } catch (err) {
          console.warn(`  failed to write output for ${url}: ${err.message}`);
          await store.update(url, { status: "failed", lastError: err.message });
        }
      }
    }
  }

  // Phase 2: Transcribe
  if (options.transcribe) {
    const urls = urlsWithParsers.map((item) => item.url);
    const downloaded = urls
      .map((url) => ({ url, state: store.get(url) }))
      .filter((item) => item.state?.filePath && item.state?.parsed);

    if (downloaded.length === 0) {
      console.log("[phase 2] nothing to transcribe");
    } else {
      console.log(`[phase 2] transcribing ${downloaded.length} video(s)...`);

      let serverReady = true;
      try {
        await spawnTranscribeServer(options);
      } catch (err) {
        console.error(`[phase 2] failed to start transcribe server: ${err.message}`);
        serverReady = false;
      }

      if (serverReady) {
        for (let i = 0; i < downloaded.length; i++) {
          if (stopping) break;
          const { url, state } = downloaded[i];
          const label = `[${i + 1}/${downloaded.length}]`;
          let wavPath = null;

          try {
            await store.update(url, { status: "transcribing" });
            console.log(`${label} extracting audio...`);
            wavPath = await extractAudio(state.filePath, options.ffmpegPath);
            console.log(`${label} transcribing (${options.model}, ${options.device})...`);

            const transcribeResult = await transcribeAudio(wavPath, options);

            const { jsonPath } = await writeOutputsWithMediaInfo(
              state.parsed,
              transcribeResult,
              { filePath: state.filePath, bytes: state.bytes },
              options.output,
              options
            );

            await store.update(url, {
              status: "completed",
              jsonPath,
              hasTranscript: Boolean(transcribeResult?.transcript),
              lastError: null,
            });
            console.log(`${label} complete (${state.bytes} bytes, transcribed): ${jsonPath}`);
          } catch (err) {
            console.warn(`${label} transcribe failed: ${err.message}`);
            try {
              const { jsonPath } = await writeOutputsWithMediaInfo(
                state.parsed,
                null,
                { filePath: state.filePath, bytes: state.bytes },
                options.output,
                options
              );
              await store.update(url, {
                status: "completed",
                jsonPath,
                hasTranscript: false,
                lastError: err.message,
              });
              console.log(`${label} completed without transcript: ${jsonPath}`);
            } catch (writeErr) {
              await store.update(url, { status: "failed", lastError: writeErr.message });
            }
          } finally {
            if (wavPath) await fsp.rm(wavPath, { force: true }).catch(() => {});
          }
        }

        stopTranscribeServer();
      }
    }
  }

  // Final summary
  const urls = urlsWithParsers.map((item) => item.url);
  const finalResults = urls.map((url) => {
    const s = store.get(url);
    return {
      url,
      status: s?.status ?? "unknown",
      videoId: s?.videoId,
      title: s?.title,
      jsonPath: s?.jsonPath,
      bytes: s?.bytes,
      hasTranscript: s?.hasTranscript ?? false,
      lastError: s?.lastError,
    };
  });

  const summary = {
    total: urls.length,
    completed: finalResults.filter((r) => r.status === "completed").length,
    withTranscript: finalResults.filter((r) => r.hasTranscript).length,
    failed: finalResults.filter((r) => r.status === "failed").length,
    permanentFailures: finalResults.filter((r) => r.status === "permanent_failure").length,
    outputDir: options.output,
    stateFile: store.file,
    transcribe: options.transcribe
      ? { model: options.model, device: options.device, computeType: options.computeType }
      : null,
    results: finalResults,
  };

  const summaryFile = path.join(options.output, "download-summary.json");
  await fsp.writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));

  const hasFailures = summary.failed > 0 || summary.permanentFailures > 0;
  const exitCode = summary.completed === summary.total && !hasFailures ? 0 : 1;
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
