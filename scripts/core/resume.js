import fsp from "node:fs/promises";
import path from "node:path";

import { isValidMp4 } from "../utils/common.js";
import { TEMP_DIR_NAME } from "./policies.js";

export async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function getTranscriptPathFromJsonPath(jsonPath) {
  if (!jsonPath) return null;
  if (jsonPath.endsWith(".json")) return `${jsonPath.slice(0, -5)}_transcript.txt`;
  return `${jsonPath}_transcript.txt`;
}

export async function hasReusableTranscriptOutput(state) {
  if (!state?.hasTranscript || state?.status !== "completed" || !state?.jsonPath) {
    return false;
  }
  if (!(await fileExists(state.jsonPath))) return false;
  return await fileExists(getTranscriptPathFromJsonPath(state.jsonPath));
}

export async function hasReusableJsonOutput(state) {
  return Boolean(state?.status === "completed" && state?.jsonPath && await fileExists(state.jsonPath));
}

export function getCacheVideoPath(state) {
  return state?.cacheVideoPath ?? state?.filePath ?? null;
}

export async function getExistingCacheVideoPath(state) {
  const cachePath = getCacheVideoPath(state);
  return cachePath && await isValidMp4(cachePath) ? cachePath : null;
}

export async function getReusableVideoPath(state) {
  const candidates = [state?.cacheVideoPath, state?.filePath, state?.videoFilePath].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    if (await isValidMp4(candidate)) return candidate;
  }
  return null;
}

export async function hasReusableCacheVideo(state) {
  return Boolean(await getReusableVideoPath(state));
}

export async function hasReusableVideoOutput(state) {
  return Boolean(state?.videoOutput !== false && state?.videoFilePath && await isValidMp4(state.videoFilePath));
}

export async function getPendingTranscriptions(items) {
  const pending = [];
  for (const item of items) {
    if (await hasReusableTranscriptOutput(item.state)) continue;
    pending.push(item);
  }
  return pending;
}

export function getTempDir(outputDir) {
  return path.join(outputDir, TEMP_DIR_NAME);
}

export async function clearTempCache(outputDir) {
  const tempDir = getTempDir(outputDir);
  await fsp.rm(tempDir, { recursive: true, force: true });
  return tempDir;
}
