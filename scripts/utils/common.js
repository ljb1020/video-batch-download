import crypto from "node:crypto";
import fsp from "node:fs/promises";

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
