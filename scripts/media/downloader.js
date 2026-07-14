import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { QUALITY_SELECTION_VERSION } from "../core/policies.js";
import { getTempDir } from "../core/resume.js";
import { isValidMp4, itemKey, USER_AGENT } from "../utils/common.js";
import { assertExpectedQuality, assertPlayableVideo, mergeStreams } from "./ffmpeg.js";

const activeDownloadControllers = new Set();

function safePathSegment(value, fallback = "video", maxLen = 80) {
  const raw = String(value ?? "");
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, maxLen);
}

export function getMediaCacheKey(parsed, alternativeIndex = 0) {
  const platform = safePathSegment(parsed.platform, "platform", 20);
  const videoId = safePathSegment(parsed.videoId, itemKey(parsed.sourceUrl), 50);
  const policyKey = itemKey(`${QUALITY_SELECTION_VERSION}:${parsed.accessMode ?? "anonymous"}`).slice(0, 8);
  const alternative = alternativeIndex > 0 ? `_fallback${alternativeIndex}` : "";
  return `${platform}_${videoId}_${itemKey(parsed.sourceUrl)}_${policyKey}${alternative}`;
}

export function abortActiveDownloads(reason = new Error("Download interrupted")) {
  for (const controller of activeDownloadControllers) {
    try { controller.abort(reason); } catch {}
  }
}

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
  activeDownloadControllers.add(controller);
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
    activeDownloadControllers.delete(controller);
  }
}

async function downloadStreamSet(parsed, streams, alternativeIndex, outputDir, timeoutMs, ffmpegPath) {
  const mediaKey = getMediaCacheKey(parsed, alternativeIndex);
  if (streams.length === 1 && streams[0].type === "video+audio") {
    const downloaded = await downloadSingleStream(streams[0], mediaKey, "", outputDir, timeoutMs);
    await assertPlayableVideo(downloaded.filePath, ffmpegPath, "Downloaded video");
    await assertExpectedQuality(downloaded.filePath, streams, ffmpegPath);
    return downloaded;
  }

  const videoStream = streams.find((stream) => stream.type === "video");
  const audioStream = streams.find((stream) => stream.type === "audio");
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
    mergedPath = path.join(getTempDir(outputDir), `${mediaKey}.mp4`);
    await mergeStreams(videoFile.filePath, audioFile.filePath, mergedPath, ffmpegPath);
    await assertPlayableVideo(mergedPath, ffmpegPath, "Merged video");
    await assertExpectedQuality(mergedPath, streams, ffmpegPath);

    await fsp.rm(videoFile.filePath, { force: true });
    await fsp.rm(audioFile.filePath, { force: true });
    const stat = await fsp.stat(mergedPath);
    return { filePath: mergedPath, bytes: stat.size, skipped: false };
  } catch (error) {
    if (videoFile?.filePath) await fsp.rm(videoFile.filePath, { force: true }).catch(() => {});
    if (audioFile?.filePath) await fsp.rm(audioFile.filePath, { force: true }).catch(() => {});
    if (mergedPath) await fsp.rm(mergedPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function normalizeMediaAlternatives(parsed) {
  const alternatives = Array.isArray(parsed.mediaAlternatives)
    ? parsed.mediaAlternatives.filter((streams) => Array.isArray(streams) && streams.length > 0)
    : [];
  const all = [parsed.mediaStreams, ...alternatives];
  const seen = new Set();
  return all.filter((streams) => {
    if (!Array.isArray(streams) || streams.length === 0) return false;
    const key = streams.map((stream) => `${stream.type}:${stream.url}`).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function downloadMedia(parsed, outputDir, timeoutMs, ffmpegPath) {
  const alternatives = normalizeMediaAlternatives(parsed);
  const failures = [];
  for (let index = 0; index < alternatives.length; index += 1) {
    const streams = alternatives[index];
    try {
      const downloaded = await downloadStreamSet(parsed, streams, index, outputDir, timeoutMs, ffmpegPath);
      if (index > 0) {
        parsed.mediaStreams = streams;
        parsed.qualityAudit = {
          ...(parsed.qualityAudit ?? {}),
          selectionReason: `Higher anonymous candidate(s) failed; downloaded fallback ${index + 1}`,
          fallbackFailures: failures,
        };
      }
      return { ...downloaded, alternativeIndex: index, fallbackFailures: failures };
    } catch (error) {
      failures.push({ alternativeIndex: index, error: error.message });
      if (index + 1 < alternatives.length) {
        console.warn(`    [quality] candidate ${index + 1} failed, trying next anonymous quality: ${error.message}`);
      }
    }
  }
  const error = new Error(
    `All ${alternatives.length} anonymous media candidate set(s) failed: ` +
      failures.map((failure) => `#${failure.alternativeIndex + 1} ${failure.error}`).join(" | "),
  );
  error.candidateFailures = failures;
  throw error;
}
