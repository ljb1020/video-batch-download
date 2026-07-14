import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { getVideoInfo } from "../utils/common.js";

const AUDIO_PROBE_TIMEOUT_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 30 * 60_000;
const activeMediaProcesses = new Set();

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
  const result = spawnSync(exe, ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`;
    throw new Error(`ffmpeg is required but could not be run (${exe}: ${detail})`);
  }
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

export async function assertPlayableVideo(filePath, ffmpegPath, label) {
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

export async function assertExpectedQuality(filePath, streams, ffmpegPath) {
  const expected = streams.find((stream) => stream.type === "video" || stream.type === "video+audio");
  if (!expected) return;
  const actual = await getVideoInfo(filePath, ffmpegPath);
  if (!actual) return;

  const expectedPixels = Number(expected.width ?? 0) * Number(expected.height ?? 0);
  const actualPixels = Number(actual.width ?? 0) * Number(actual.height ?? 0);
  if (expectedPixels > 0 && actualPixels > 0 && actualPixels < expectedPixels * 0.95) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw new Error(
      `Downloaded resolution ${actual.resolution ?? "unknown"} is below candidate ` +
      `${expected.width}x${expected.height}`,
    );
  }

  const expectedFps = Number(expected.fps ?? 0);
  if (expectedFps > 0 && actual.fps && actual.fps + 1 < expectedFps) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw new Error(`Downloaded frame rate ${actual.fps} is below candidate ${expectedFps}`);
  }

  if (expected.hdr === true && actual.hdr === false) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw new Error("Downloaded stream is not HDR although the selected candidate was HDR");
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
