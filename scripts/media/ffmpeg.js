import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ProcessingError, ffmpegUnavailableError, normalizeError } from "../core/errors.js";
import { getVideoInfo } from "../utils/common.js";

const AUDIO_PROBE_TIMEOUT_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 30 * 60_000;
const activeMediaProcesses = new Set();
const verifiedFfmpegExecutables = new Set();

function getFfmpegExecutable(ffmpegPath) {
  return ffmpegPath || "ffmpeg";
}

function trackProcess(child) {
  activeMediaProcesses.add(child);
  child.once("close", () => activeMediaProcesses.delete(child));
  return child;
}

export function terminateActiveMediaProcesses() {
  for (const child of activeMediaProcesses) {
    try { child.kill("SIGTERM"); } catch {}
  }
}

export function ensureFfmpegAvailable(ffmpegPath) {
  const exe = getFfmpegExecutable(ffmpegPath);
  if (verifiedFfmpegExecutables.has(exe)) return;
  const result = spawnSync(exe, ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`;
    throw ffmpegUnavailableError(`ffmpeg is required but could not be run (${exe}: ${detail})`, {
      stage: "preflight",
      details: { executable: exe, cause: detail },
      cause: result.error,
    });
  }
  verifiedFfmpegExecutables.add(exe);
}

export async function getMediaTracks(filePath, ffmpegPath) {
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
    const child = trackProcess(spawn(ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"] }));
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeMediaProcesses.delete(child);
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
      else finish(null);
    });
    child.on("error", () => finish(null));
  });

  const tryFfmpeg = () => new Promise((resolve) => {
    const exe = getFfmpegExecutable(ffmpegPath);
    const args = ["-i", filePath, "-hide_banner", "-f", "null", "-"];
    const child = trackProcess(spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] }));
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeMediaProcesses.delete(child);
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
    child.on("error", () => finish(null));
  });

  const ffprobeResult = await tryFfprobe();
  if (ffprobeResult !== null) return ffprobeResult;
  return await tryFfmpeg();
}

export function validateMediaTracks(tracks, label, { requireAudio = true } = {}) {
  if (tracks === null) {
    console.warn(`    [media] ${label} track probe was inconclusive; keeping downloaded video`);
    return;
  }
  if (!tracks.video) {
    throw new ProcessingError(`${label} has no video track`, {
      code: "MEDIA_VIDEO_TRACK_MISSING",
      category: "media",
      stage: "download",
      retryable: true,
      retryScope: "candidate",
      userMessage: "下载到的媒体没有视频轨，已尝试换用其他候选。",
    });
  }
  if (requireAudio && !tracks.audio) {
    throw new ProcessingError(`${label} has no audio track`, {
      code: "MEDIA_AUDIO_TRACK_MISSING",
      category: "media",
      stage: "download",
      retryable: true,
      retryScope: "candidate",
      userMessage: "下载到的媒体没有音轨，无法转写，已尝试换用其他候选。",
      suggestion: "如果只需要保存视频，可使用 --no-transcribe 跳过音频转写要求。",
    });
  }
}

export async function assertPlayableVideo(filePath, ffmpegPath, label, options = {}) {
  const tracks = await getMediaTracks(filePath, ffmpegPath);
  try {
    validateMediaTracks(tracks, label, options);
  } catch (error) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
  // null = inconclusive probe; callers must treat that as mediaHasAudio: null.
  return tracks;
}

export async function assertExpectedQuality(filePath, streams, ffmpegPath) {
  const expected = streams.find((stream) => stream.type === "video" || stream.type === "video+audio");
  if (!expected) return;
  const actual = await getVideoInfo(filePath, ffmpegPath);
  if (!actual) return;

  const expectedPixels = Number(expected.width ?? 0) * Number(expected.height ?? 0);
  const actualPixels = Number(actual.width ?? 0) * Number(actual.height ?? 0);
  if (expectedPixels > 0 && actualPixels > 0 && actualPixels < expectedPixels * 0.95) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw new ProcessingError(
      `Downloaded resolution ${actual.resolution ?? "unknown"} is below candidate ` +
      `${expected.width}x${expected.height}`,
      {
        code: "MEDIA_QUALITY_MISMATCH",
        category: "media",
        stage: "download",
        retryable: true,
        retryScope: "candidate",
        userMessage: "下载到的清晰度低于候选声明，已尝试换用其他候选。",
      },
    );
  }

  const expectedFps = Number(expected.fps ?? 0);
  if (expectedFps > 0 && actual.fps && actual.fps + 1 < expectedFps) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw new ProcessingError(`Downloaded frame rate ${actual.fps} is below candidate ${expectedFps}`, {
      code: "MEDIA_QUALITY_MISMATCH",
      category: "media",
      stage: "download",
      retryable: true,
      retryScope: "candidate",
      userMessage: "下载到的帧率低于候选声明，已尝试换用其他候选。",
    });
  }

  if (expected.hdr === true && actual.hdr === false) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw new ProcessingError("Downloaded stream is not HDR although the selected candidate was HDR", {
      code: "MEDIA_QUALITY_MISMATCH",
      category: "media",
      stage: "download",
      retryable: true,
      retryScope: "candidate",
      userMessage: "下载到的视频不符合候选 HDR 声明，已尝试换用其他候选。",
    });
  }
}

export async function mergeStreams(videoPath, audioPath, mergedPath, ffmpegPath) {
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
    const child = trackProcess(spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] }));
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeMediaProcesses.delete(child);
      fn();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish(() => reject(new ProcessingError("ffmpeg merge timed out", {
        code: "FFMPEG_TIMEOUT",
        category: "media",
        stage: "download",
        retryable: true,
        retryScope: "candidate",
        userMessage: "ffmpeg 合并超时，已尝试换用其他候选。",
      })));
    }, FFMPEG_TIMEOUT_MS);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve(mergedPath);
        else {
          const message = `ffmpeg merge failed (exit ${code}): ${stderr.trim()}`;
          const stderrText = stderr.trim();
          const outputLikeError = /No space left|Permission denied|Read-only file system/i.test(stderrText);
          const environmentLikeError = /Unknown encoder|Encoder .* not found|Invalid encoder|not support(?:ed)?/i.test(stderrText);
          reject(new ProcessingError(message, {
            code: outputLikeError ? "OUTPUT_WRITE_FAILED" : environmentLikeError ? "FFMPEG_UNSUPPORTED" : "FFMPEG_MERGE_FAILED",
            category: outputLikeError ? "output" : environmentLikeError ? "environment" : "media",
            stage: "download",
            retryable: !outputLikeError && !environmentLikeError,
            retryScope: outputLikeError || environmentLikeError ? "none" : "candidate",
            userMessage: outputLikeError
              ? "ffmpeg 合并时无法写入输出文件，请检查磁盘空间和目录权限。"
              : environmentLikeError
                ? "当前 ffmpeg 不支持所需的音视频合并能力，请更换完整版本 ffmpeg。"
                : "ffmpeg 合并音视频流失败，已尝试换用其他候选。",
            details: { exitCode: code, stderr: stderrText },
          }));
        }
      });
    });
    child.on("error", (err) => {
      finish(() => reject(normalizeError(err, {
        stage: "download",
        code: "FFMPEG_SPAWN_FAILED",
        category: "environment",
        retryable: false,
        userMessage: "ffmpeg 进程启动失败，请检查 ffmpeg 路径和权限。",
      })));
    });
  });
}

export async function extractAudio(mp4Path, ffmpegPath) {
  const wavPath = mp4Path.replace(/\.mp4$/i, "_16k.wav");
  const exe = getFfmpegExecutable(ffmpegPath);
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", mp4Path,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    wavPath,
  ];

  return new Promise((resolve, reject) => {
    const child = trackProcess(spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] }));
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeMediaProcesses.delete(child);
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
