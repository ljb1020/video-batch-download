import crypto from "node:crypto";
import fsp from "node:fs/promises";

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000, 90_000, 120_000];

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
    .replace(/\s*-\s*抖音\s*$/u, "")
    .replace(/[<>:"/\\|?* -]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (clean || fallback).slice(0, 100);
}

export function safeFilename(value, maxLen = 25) {
  if (!value) return "未知";
  const cleaned = value
    .replace(/[\\/:*?"<>|\n\r\t]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const truncated = cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
  return truncated || "未知";
}

export function itemKey(url) {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
}

export async function isValidMp4(filePath) {
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
