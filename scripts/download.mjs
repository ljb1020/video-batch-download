#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { sleep, retryDelay, safeFilename, itemKey, isValidMp4, getVideoInfo, USER_AGENT } from "./utils/common.js";
import { Semaphore } from "./utils/semaphore.js";
import { StateStore } from "./utils/state-store.js";
import { BrowserManager } from "./utils/browser-manager.js";
import { extractAndRouteUrls } from "./platforms/router.js";

const TEMP_DIR_NAME = ".temp";
const AUDIO_PROBE_TIMEOUT_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 30 * 60_000;

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
  --no-video-output              Do not copy MP4 into item folders; keep it in .temp cache
  --clear-temp                   Delete the output .temp cache and exit
  --headed                       Show the browser for verification fallback
  --storage-state <file>         Optional Playwright storage-state JSON

Transcription options:
  --no-transcribe                Skip Whisper transcription (download only)
  --model <name>                 Whisper model: small, medium, large-v3 (default: medium)
  --language <code>              Language hint, auto = detect (default: zh)
  --device <cpu|cuda>            Transcription device (default: cuda)
  --compute-type <type>          Precision: int8, float16, float32 (default: float16)
  --no-simplify                  Skip Traditional→Simplified Chinese conversion
  --ffmpeg-path <path>           Path to ffmpeg executable
  --transcribe-timeout <secs>    Timeout per transcription in seconds (default: 600)

Rerun with the same output directory to resume from download-state.json.
`);
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getTranscriptPathFromJsonPath(jsonPath) {
  if (!jsonPath) return null;
  if (jsonPath.endsWith(".json")) return `${jsonPath.slice(0, -5)}_transcript.txt`;
  return `${jsonPath}_transcript.txt`;
}

async function hasReusableTranscriptOutput(state) {
  if (!state?.hasTranscript || state?.status !== "completed" || !state?.jsonPath) {
    return false;
  }
  if (!(await fileExists(state.jsonPath))) return false;
  return await fileExists(getTranscriptPathFromJsonPath(state.jsonPath));
}

async function hasReusableJsonOutput(state) {
  return Boolean(state?.status === "completed" && state?.jsonPath && await fileExists(state.jsonPath));
}

function getCacheVideoPath(state) {
  return state?.cacheVideoPath ?? state?.filePath ?? null;
}

async function getExistingCacheVideoPath(state) {
  const cachePath = getCacheVideoPath(state);
  return cachePath && await isValidMp4(cachePath) ? cachePath : null;
}

async function getReusableVideoPath(state) {
  const candidates = [state?.cacheVideoPath, state?.filePath, state?.videoFilePath].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    if (await isValidMp4(candidate)) return candidate;
  }
  return null;
}

async function hasReusableCacheVideo(state) {
  return Boolean(await getReusableVideoPath(state));
}

async function hasReusableVideoOutput(state) {
  return Boolean(state?.videoOutput !== false && state?.videoFilePath && await isValidMp4(state.videoFilePath));
}

async function getPendingTranscriptions(items) {
  const pending = [];
  for (const item of items) {
    if (await hasReusableTranscriptOutput(item.state)) continue;
    pending.push(item);
  }
  return pending;
}

function getTempDir(outputDir) {
  return path.join(outputDir, TEMP_DIR_NAME);
}

async function clearTempCache(outputDir) {
  const tempDir = getTempDir(outputDir);
  await fsp.rm(tempDir, { recursive: true, force: true });
  return tempDir;
}

function getFfmpegExecutable(ffmpegPath) {
  return ffmpegPath || "ffmpeg";
}

function ensureFfmpegAvailable(ffmpegPath) {
  const exe = getFfmpegExecutable(ffmpegPath);
  const result = spawnSync(exe, ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`;
    throw new Error(`ffmpeg is required but could not be run (${exe}: ${detail})`);
  }
}

function safePathSegment(value, fallback = "video", maxLen = 80) {
  const raw = String(value ?? "");
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, maxLen);
}

function getMediaCacheKey(parsed) {
  const platform = safePathSegment(parsed.platform, "platform", 20);
  const videoId = safePathSegment(parsed.videoId, itemKey(parsed.sourceUrl), 50);
  return `${platform}_${videoId}_${itemKey(parsed.sourceUrl)}`;
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
    videoOutput: true,
    clearTemp: false,
    // Transcription
    transcribe: true,
    model: "medium",
    language: "zh",
    device: "cuda",
    computeType: "float16",
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
    else if (arg === "--no-video-output") options.videoOutput = false;
    else if (arg === "--clear-temp") options.clearTemp = true;
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

async function downloadSingleStream(stream, mediaKey, suffix, outputDir, timeoutMs) {
  const tmpDir = getTempDir(outputDir);
  await fsp.mkdir(tmpDir, { recursive: true });
  const ext = stream.format === "m4s" ? "m4s" : "mp4";
  const filename = `${mediaKey}${suffix}.${ext}`;
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
        ...(stream.headers ?? {}),
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

async function getMediaTracks(filePath, ffmpegPath) {
  // Try ffprobe first (more reliable)
  const ffprobePath = ffmpegPath
    ? path.join(path.dirname(ffmpegPath), process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
    : "ffprobe";

  const parseTracks = (text) => {
    const types = new Set(String(text).split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean));
    return {
      audio: types.has("audio"),
      video: types.has("video"),
    };
  };

  const tryFfprobe = () => new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      filePath,
    ];

    const child = spawn(ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    _activeChildren.add(child);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _activeChildren.delete(child);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish(null);
    }, AUDIO_PROBE_TIMEOUT_MS);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => {
      if (code === 0) finish(parseTracks(stdout.trim()));
      else finish(null); // ffprobe failed, try ffmpeg
    });
    child.on("error", () => finish(null)); // ffprobe not found
  });

  const tryFfmpeg = () => new Promise((resolve) => {
    const exe = getFfmpegExecutable(ffmpegPath);
    const args = ["-i", filePath, "-hide_banner", "-f", "null", "-"];
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    _activeChildren.add(child);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _activeChildren.delete(child);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish(null);
    }, AUDIO_PROBE_TIMEOUT_MS);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", () => {
      finish({
        audio: stderr.includes("Audio:") || (stderr.includes("Stream #") && stderr.includes("audio")),
        video: stderr.includes("Video:") || (stderr.includes("Stream #") && stderr.includes("video")),
      });
    });
    child.on("error", () => finish(null)); // ffmpeg not found
  });

  // Try ffprobe first, then ffmpeg
  const ffprobeResult = await tryFfprobe();
  if (ffprobeResult !== null) return ffprobeResult;

  // Fallback to ffmpeg
  return await tryFfmpeg();
}

async function assertPlayableVideo(filePath, ffmpegPath, label) {
  const tracks = await getMediaTracks(filePath, ffmpegPath);
  if (tracks === null) {
    console.warn(`    [media] ${label} track probe was inconclusive; keeping downloaded video`);
    return;
  }
  if (!tracks.video) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw new Error(`${label} has no video track`);
  }
  if (!tracks.audio) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw new Error(`${label} has no audio track`);
  }
}

async function mergeStreams(videoPath, audioPath, mediaKey, outputDir, ffmpegPath) {
  const mergedPath = path.join(getTempDir(outputDir), `${mediaKey}.mp4`);
  const exe = getFfmpegExecutable(ffmpegPath);
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
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _activeChildren.delete(child);
      fn();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish(() => reject(new Error("ffmpeg merge timed out")));
    }, FFMPEG_TIMEOUT_MS);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve(mergedPath);
        else {
          const err = new Error(`ffmpeg merge failed (exit ${code}): ${stderr.trim()}`);
          err.permanent = true;
          reject(err);
        }
      });
    });
    child.on("error", (err) => {
      finish(() => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    });
  });
}

async function downloadMedia(parsed, outputDir, timeoutMs, ffmpegPath) {
  const streams = parsed.mediaStreams;
  const mediaKey = getMediaCacheKey(parsed);

  // Single stream (e.g., Douyin or Bilibili durl fallback)
  if (streams.length === 1 && streams[0].type === "video+audio") {
    const downloaded = await downloadSingleStream(
      streams[0],
      mediaKey,
      "",
      outputDir,
      timeoutMs
    );
    await assertPlayableVideo(downloaded.filePath, ffmpegPath, "Downloaded video");
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
      downloadSingleStream(videoStream, mediaKey, "_video", outputDir, timeoutMs),
      downloadSingleStream(audioStream, mediaKey, "_audio", outputDir, timeoutMs),
    ]);

    // Merge with ffmpeg
    mergedPath = await mergeStreams(
      videoFile.filePath,
      audioFile.filePath,
      mediaKey,
      outputDir,
      ffmpegPath
    );

    // Verify both video and audio tracks exist
    await assertPlayableVideo(mergedPath, ffmpegPath, "Merged video");

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
  const exe = getFfmpegExecutable(ffmpegPath);
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", mp4Path,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    wavPath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    _activeChildren.add(child);
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _activeChildren.delete(child);
      fn();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish(() => reject(new Error("ffmpeg audio extraction timed out")));
    }, FFMPEG_TIMEOUT_MS);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve(wavPath);
        else reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.trim()}`));
      });
    });
    child.on("error", (err) => {
      finish(() => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
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
  return path.dirname(fileURLToPath(import.meta.url));
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
    const probe = spawnSync(pyExe, ["--version"], { stdio: "ignore" });
    if (probe.error || probe.status !== 0) {
      lastErr = probe.error ?? new Error(`${pyExe} --version exited ${probe.status}`);
      continue;
    }
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
      if (proc !== _transcribeProc) return;
      const wasReady = _transcribeReady;
      _transcribeProc = null;
      _transcribeReady = false;
      const err = new Error(`transcribe_server exited (code ${code})`);
      if (!wasReady) reject(err);
      while (_transcribeResolvers.length) _transcribeResolvers.shift()({ error: err.message });
    });
  });

  _transcribeResponseBuf = "";
  proc.stdout.on("data", (chunk) => {
    if (proc !== _transcribeProc) return;
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

function stopTranscribeServer(reason = "transcribe server stopped") {
  if (!_transcribeProc) return;
  const proc = _transcribeProc;
  while (_transcribeResolvers.length) _transcribeResolvers.shift()({ error: reason });
  _transcribeResponseBuf = "";
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
      stopTranscribeServer("Transcription timeout");
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
  const rawVideoId = parsed.videoId ?? itemKey(parsed.sourceUrl);
  const fileVideoId = safePathSegment(rawVideoId, itemKey(parsed.sourceUrl), 50);
  const platformName = safePathSegment(parsed.platform, "platform", 20);
  const base = `${timeStr}_${platformName}_${authorName}_${fileVideoId}`;
  const itemDir = path.join(outputDir, base);

  fs.mkdirSync(itemDir, { recursive: true });

  const segments = transcribeResult?.segments ?? [];
  const transcript = transcribeResult?.transcript ?? "";
  const tMeta = transcribeResult?.meta ?? null;
  const jsonPath = path.join(itemDir, `${base}.json`);
  const txtPath = transcript ? path.join(itemDir, `${base}_transcript.txt`) : null;

  const result = {
    status: "success",
    source_url: parsed.sourceUrl,
    canonical_url: parsed.canonicalUrl,
    video_id: rawVideoId,
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
    output_file: jsonPath,
    transcript_file: txtPath,
    video_file: null,
    video_output: Boolean(options.videoOutput),
    cache_video_file: mp4Info?.filePath ?? null,
  };

  if (transcript && txtPath) {
    fs.writeFileSync(txtPath, transcript + "\n", "utf8");
  }
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");

  return { result, itemDir, jsonPath, base };
}

async function materializeVideoArtifact(mp4Info, itemDir, base, options = {}) {
  const cacheVideoPath = mp4Info?.filePath ?? null;
  if (!cacheVideoPath || !(await isValidMp4(cacheVideoPath))) {
    return { videoFilePath: null, cacheVideoPath, videoOutput: false };
  }

  if (!options.videoOutput) {
    return { videoFilePath: null, cacheVideoPath, videoOutput: false };
  }

  const videoFilePath = path.join(itemDir, `${base}.mp4`);
  if (path.resolve(cacheVideoPath) === path.resolve(videoFilePath)) {
    return { videoFilePath, cacheVideoPath, videoOutput: true };
  }

  await fsp.rm(videoFilePath, { force: true });
  try {
    await fsp.link(cacheVideoPath, videoFilePath);
  } catch {
    await fsp.copyFile(cacheVideoPath, videoFilePath);
  }

  return { videoFilePath, cacheVideoPath, videoOutput: true };
}

async function patchJsonVideoArtifact(jsonPath, videoArtifact) {
  try {
    const result = JSON.parse(await fsp.readFile(jsonPath, "utf8"));
    result.video_file = videoArtifact.videoFilePath;
    result.video_output = videoArtifact.videoOutput;
    result.cache_video_file = videoArtifact.cacheVideoPath;
    await fsp.writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(`    [artifact] failed to update JSON video fields: ${err.message}`);
  }
}

async function writeOutputsWithMediaInfo(parsed, transcribeResult, mp4Info, outputDir, options = {}) {
  const { result, itemDir, jsonPath, base } = writeOutputs(parsed, transcribeResult, mp4Info, outputDir, options);

  // Probe video file for resolution/bitrate
  if (mp4Info?.filePath) {
    try {
      const mediaInfo = await getVideoInfo(mp4Info.filePath, options.ffmpegPath ?? null);
      if (mediaInfo) {
        result.media_info = mediaInfo;

        // Log quality info
        const res = mediaInfo.resolution ?? "unknown";
        const bitrate = mediaInfo.bitrate_kbps ? `${mediaInfo.bitrate_kbps} kbps` : "unknown";
        const codec = mediaInfo.codec ?? "unknown";
        console.error(`    [media] ${res}, ${bitrate}, ${codec}`);
      }
    } catch (err) {
      console.warn(`    [media] ffprobe failed: ${err.message}`);
    }
  }

  const videoArtifact = await materializeVideoArtifact(mp4Info, itemDir, base, options);
  result.video_file = videoArtifact.videoFilePath;
  result.video_output = videoArtifact.videoOutput;
  result.cache_video_file = videoArtifact.cacheVideoPath;
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");

  return { result, itemDir, jsonPath, ...videoArtifact };
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

  if (options.clearTemp) {
    await fsp.mkdir(options.output, { recursive: true });
    const tempDir = await clearTempCache(options.output);
    console.log(JSON.stringify({ status: "cleared", tempDir }, null, 2));
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
    console.error("\nStopping after current operations...");
    stopTranscribeServer();
    for (const child of _activeChildren) {
      try { child.kill("SIGTERM"); } catch {}
    }
    await browserManager.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.error(
    `[batch] ${urlsWithParsers.length} unique URL(s), ` +
      `parse concurrency ${options.parseConcurrency}, ` +
      `download concurrency ${options.downloadConcurrency}, ` +
      `video output ${options.videoOutput ? "item folders" : ".temp cache only"}, ` +
      `transcribe ${options.transcribe ? `on (serial, ${options.model}, ${options.device})` : "off"}, ` +
      `output ${options.output}`,
  );

  // Phase 1: Parse + Download
  console.error(`\n[phase 1] downloading ${urlsWithParsers.length} video(s)...`);

  async function processDownload({ url, ParserClass }, index) {
    const label = `[${index + 1}/${urlsWithParsers.length}]`;
    const previous = store.get(url);
    if (await hasReusableJsonOutput(previous)) {
      const transcriptOk = !options.transcribe || await hasReusableTranscriptOutput(previous);
      let videoOk = !options.videoOutput || await hasReusableVideoOutput(previous);

      if (!videoOk && options.videoOutput && await hasReusableCacheVideo(previous)) {
        const jsonPath = previous.jsonPath;
        const itemDir = path.dirname(jsonPath);
        const base = path.basename(jsonPath, ".json");
        const artifact = await materializeVideoArtifact(
          { filePath: await getReusableVideoPath(previous), bytes: previous.bytes },
          itemDir,
          base,
          options,
        );
        await patchJsonVideoArtifact(jsonPath, artifact);
        await store.update(url, {
          videoFilePath: artifact.videoFilePath,
          cacheVideoPath: artifact.cacheVideoPath,
          videoOutput: artifact.videoOutput,
        });
        previous.videoFilePath = artifact.videoFilePath;
        previous.cacheVideoPath = artifact.cacheVideoPath;
        previous.videoOutput = artifact.videoOutput;
        videoOk = Boolean(artifact.videoFilePath);
      }

      if (transcriptOk && videoOk) {
        console.error(`${label} already complete: ${previous.jsonPath}`);
        results.push({
          url,
          status: "completed",
          filePath: await getReusableVideoPath(previous),
          videoFilePath: previous.videoFilePath,
          bytes: previous.bytes,
          resumed: true,
        });
        return;
      }
    }

    if (previous?.parsed && await hasReusableCacheVideo(previous)) {
      const cacheVideoPath = await getReusableVideoPath(previous);
      await store.update(url, {
        status: "downloaded",
        filePath: cacheVideoPath,
        cacheVideoPath,
        lastError: null,
      });
      console.error(`${label} using cached video: ${cacheVideoPath}`);
      results.push({
        url,
        status: "downloaded",
        filePath: cacheVideoPath,
        bytes: previous.bytes,
        resumed: true,
      });
      return;
    }

    let attempt = 0;
    while (!stopping && (options.maxAttempts === 0 || attempt < options.maxAttempts)) {
      attempt += 1;
      await store.update(url, { status: "parsing", attempt, lastError: null });
      console.error(`${label} parse attempt ${attempt}${options.maxAttempts ? `/${options.maxAttempts}` : ""}: ${url}`);

      try {
        ensureFfmpegAvailable(options.ffmpegPath);
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
          filePath: downloaded.filePath, // Backward-compatible cache path alias
          cacheVideoPath: downloaded.filePath,
          bytes: downloaded.bytes,
          parsed,
          lastError: null,
        });

        console.error(`${label} downloaded (${downloaded.bytes} bytes)`);
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
    console.error("[phase 1] browser closed\n");
  }

  // Phase 1.5: Write outputs for downloaded items (skip-transcribe mode)
  if (!options.transcribe) {
    const urls = urlsWithParsers.map((item) => item.url);
    const downloaded = urls
      .map((url) => ({ url, state: store.get(url) }))
      .filter((item) => item.state?.status === "downloaded" && getCacheVideoPath(item.state) && item.state?.parsed);

    if (downloaded.length > 0) {
      console.error(`[phase 1.5] writing outputs for ${downloaded.length} video(s) (transcription skipped)...`);
      for (const { url, state } of downloaded) {
        try {
          const cacheVideoPath = getCacheVideoPath(state);
          const { jsonPath, videoFilePath, videoOutput, cacheVideoPath: outputCacheVideoPath } = await writeOutputsWithMediaInfo(
            state.parsed,
            null,
            { filePath: cacheVideoPath, bytes: state.bytes },
            options.output,
            options
          );
          await store.update(url, {
            status: "completed",
            jsonPath,
            hasTranscript: false,
            videoFilePath,
            videoOutput,
            cacheVideoPath: outputCacheVideoPath,
            lastError: null,
          });
          console.error(`  completed: ${jsonPath}`);
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
    const downloaded = [];
    for (const url of urls) {
      const state = store.get(url);
      if (state?.status !== "downloaded" || !state?.parsed) continue;
      const reusableVideoPath = await getReusableVideoPath(state);
      if (!reusableVideoPath) continue;
      downloaded.push({ url, state: { ...state, cacheVideoPath: reusableVideoPath, filePath: reusableVideoPath } });
    }
    const pending = await getPendingTranscriptions(downloaded);

    if (pending.length === 0) {
      console.error("[phase 2] nothing to transcribe");
    } else {
      const skipped = downloaded.length - pending.length;
      console.error(
        `[phase 2] transcribing ${pending.length} video(s)` +
        (skipped > 0 ? ` (${skipped} already transcribed)` : "") +
        "..."
      );

      let serverReady = true;
      try {
        await spawnTranscribeServer(options);
      } catch (err) {
        console.error(`[phase 2] failed to start transcribe server: ${err.message}`);
        serverReady = false;
      }

      if (!serverReady) {
        for (const { url, state } of pending) {
          const cacheVideoPath = getCacheVideoPath(state);
          try {
            const { jsonPath, videoFilePath, videoOutput, cacheVideoPath: outputCacheVideoPath } = await writeOutputsWithMediaInfo(
              state.parsed,
              null,
              { filePath: cacheVideoPath, bytes: state.bytes },
              options.output,
              options,
            );
            await store.update(url, {
              status: "completed",
              jsonPath,
              hasTranscript: false,
              videoFilePath,
              videoOutput,
              cacheVideoPath: outputCacheVideoPath,
              lastError: "Transcription server failed to start",
            });
            console.error(`  completed without transcript: ${jsonPath}`);
          } catch (writeErr) {
            await store.update(url, { status: "failed", lastError: writeErr.message });
          }
        }
      }

      if (serverReady) {
        for (let i = 0; i < pending.length; i++) {
          if (stopping) break;
          const { url, state } = pending[i];
          const label = `[${i + 1}/${pending.length}]`;
          const cacheVideoPath = getCacheVideoPath(state);
          let wavPath = null;

          try {
            if (!_transcribeProc) {
              await spawnTranscribeServer(options);
            }
            await store.update(url, { status: "transcribing" });
            console.error(`${label} extracting audio...`);
            wavPath = await extractAudio(cacheVideoPath, options.ffmpegPath);
            console.error(`${label} transcribing (${options.model}, ${options.device})...`);

            const transcribeResult = await transcribeAudio(wavPath, options);

            const { jsonPath, videoFilePath, videoOutput, cacheVideoPath: outputCacheVideoPath } = await writeOutputsWithMediaInfo(
              state.parsed,
              transcribeResult,
              { filePath: cacheVideoPath, bytes: state.bytes },
              options.output,
              options
            );

            await store.update(url, {
              status: "completed",
              jsonPath,
              hasTranscript: Boolean(transcribeResult?.transcript),
              videoFilePath,
              videoOutput,
              cacheVideoPath: outputCacheVideoPath,
              lastError: null,
            });
            console.error(`${label} complete (${state.bytes} bytes, transcribed): ${jsonPath}`);
          } catch (err) {
            console.warn(`${label} transcribe failed: ${err.message}`);
            try {
              const { jsonPath, videoFilePath, videoOutput, cacheVideoPath: outputCacheVideoPath } = await writeOutputsWithMediaInfo(
                state.parsed,
                null,
                { filePath: cacheVideoPath, bytes: state.bytes },
                options.output,
                options
              );
              await store.update(url, {
                status: "completed",
                jsonPath,
                hasTranscript: false,
                videoFilePath,
                videoOutput,
                cacheVideoPath: outputCacheVideoPath,
                lastError: err.message,
              });
              console.error(`${label} completed without transcript: ${jsonPath}`);
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
  const finalResults = await Promise.all(urls.map(async (url) => {
    const s = store.get(url);
    const cacheVideoFile = await getExistingCacheVideoPath(s);
    return {
      url,
      status: s?.status ?? "unknown",
      videoId: s?.videoId,
      title: s?.title,
      jsonPath: s?.jsonPath,
      videoFile: s?.videoFilePath ?? null,
      videoOutput: s?.videoOutput ?? false,
      cacheVideoFile,
      bytes: s?.bytes,
      hasTranscript: s?.hasTranscript ?? false,
      lastError: s?.lastError,
    };
  }));

  const summary = {
    total: urls.length,
    completed: finalResults.filter((r) => r.status === "completed").length,
    withTranscript: finalResults.filter((r) => r.hasTranscript).length,
    failed: finalResults.filter((r) => r.status === "failed").length,
    permanentFailures: finalResults.filter((r) => r.status === "permanent_failure").length,
    outputDir: options.output,
    stateFile: store.file,
    videoOutput: options.videoOutput,
    videoPolicy: options.videoOutput ? "item" : "temp",
    videosOutput: finalResults.filter((r) => r.videoOutput && r.videoFile).length,
    videosInCache: finalResults.filter((r) => r.cacheVideoFile).length,
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
