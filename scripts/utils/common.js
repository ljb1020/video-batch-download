import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000, 90_000, 120_000];
const MIN_VALID_FILE_SIZE = 1_024;

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function settleWithin(promise, timeoutMs) {
  await Promise.race([promise.catch(() => {}), sleep(timeoutMs)]);
}

export function retryDelay(attempt) {
  const base = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
  return base + Math.floor(Math.random() * Math.min(base / 3, 5_000));
}

export function sanitizeName(value, fallback = "video") {
  const clean = value
    .replace(/[<>:"/\\|?* -]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (clean || fallback).slice(0, 100);
}

export function safeFilename(value, maxLen = 25) {
  if (!value) return "unknown";
  const cleaned = value
    .replace(/[\\/:*?"<>|\n\r\t]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const truncated = cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
  return truncated || "unknown";
}

export function itemKey(url) {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
}

export async function isValidMp4(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size < MIN_VALID_FILE_SIZE) return false;
    const handle = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(64);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const header = buffer.subarray(0, bytesRead);
      // Support both MP4 (ftyp) and M4S (styp, moof) containers
      return header.includes(Buffer.from("ftyp")) ||
             header.includes(Buffer.from("styp")) ||
             header.includes(Buffer.from("moof"));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/**
 * Get video metadata using ffprobe.
 * @param {string} filePath - Path to video file
 * @param {string|null} ffmpegPath - Path to ffmpeg (ffprobe assumed in same dir)
 * @returns {Promise<{width: number, height: number, bitrate_kbps: number, duration_secs: number, codec: string, format: string} | null>}
 */
export async function getVideoInfo(filePath, ffmpegPath = null) {
  // Resolve ffprobe path from ffmpeg path
  let ffprobeExe;
  if (ffmpegPath) {
    const dir = path.dirname(ffmpegPath);
    ffprobeExe = path.join(dir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  } else {
    ffprobeExe = "ffprobe";
  }

  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,codec_name,bit_rate,duration",
      "-show_entries", "format=duration,bit_rate",
      "-of", "json",
      filePath,
    ];

    const child = spawn(ffprobeExe, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const stream = data.streams?.[0] ?? {};
        const format = data.format ?? {};

        const width = stream.width ?? 0;
        const height = stream.height ?? 0;
        const codec = stream.codec_name ?? "unknown";

        // Bitrate: prefer stream, fallback to format
        const bitrateBps = Number(stream.bit_rate ?? format.bit_rate ?? 0);
        const bitrateKbps = bitrateBps > 0 ? Math.round(bitrateBps / 1000) : 0;

        // Duration: prefer stream, fallback to format
        const durationSecs = Number(stream.duration ?? format.duration ?? 0);

        // Format name
        const formatName = format.format_name ?? "unknown";

        resolve({
          width,
          height,
          resolution: width && height ? `${width}x${height}` : null,
          bitrate_kbps: bitrateKbps || null,
          duration_secs: durationSecs > 0 ? Math.round(durationSecs * 10) / 10 : null,
          codec,
          format: formatName,
        });
      } catch {
        resolve(null);
      }
    });

    child.on("error", () => resolve(null));
  });
}
