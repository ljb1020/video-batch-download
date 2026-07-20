import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { ProcessingError, normalizeError, sanitizeCandidateFailure } from "../core/errors.js";
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

function mediaError(message, options = {}) {
  return new ProcessingError(message, {
    stage: "download",
    retryable: true,
    retryScope: "candidate",
    ...options,
  });
}

function expectedResponseBytes(response) {
  const contentRange = response.headers.get("content-range") ?? "";
  const rangeMatch = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (rangeMatch && rangeMatch[3] !== "*") {
    return Number(rangeMatch[3]);
  }
  return Number(response.headers.get("content-length") ?? 0);
}

function classifyDownloadError(error) {
  if (error instanceof ProcessingError) return error;
  const normalized = normalizeError(error, { stage: "download" });
  if (normalized.code !== "UNEXPECTED_ERROR") return normalized;
  if (/Download timeout|aborted/i.test(normalized.message)) {
    return mediaError(normalized.message, {
      code: "MEDIA_DOWNLOAD_TIMEOUT",
      category: "network",
      userMessage: "媒体下载超时，已尝试换用其他候选或稍后重试。",
      cause: error,
    });
  }
  return mediaError(normalized.message, {
    code: "MEDIA_NETWORK_ERROR",
    category: "network",
    userMessage: "媒体下载失败，已尝试换用其他候选或稍后重试。",
    cause: error,
  });
}

function isFatalCandidateError(error) {
  return !error.retryable || error.retryScope === "none" || ["environment", "output"].includes(error.category);
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
      throw mediaError(`Media request returned HTTP ${response.status}`, {
        code: "MEDIA_HTTP_STATUS",
        category: "network",
        details: { httpStatus: response.status },
        userMessage: `媒体地址返回 HTTP ${response.status}，已尝试换用其他候选或重新解析。`,
      });
    }

    const output = fs.createWriteStream(partialPath, { flags: "wx" });
    const readable = Readable.fromWeb(response.body);
    await finished(readable.pipe(output));

    const stat = await fsp.stat(partialPath);
    const expected = expectedResponseBytes(response);
    if (expected > 0 && stat.size !== expected) {
      throw mediaError(`Incomplete media: expected ${expected} bytes, received ${stat.size}`, {
        code: "MEDIA_INCOMPLETE",
        category: "network",
        details: { expectedBytes: expected, receivedBytes: stat.size },
        userMessage: "媒体下载不完整，已尝试换用其他候选或稍后重试。",
      });
    }
    if (!(await isValidMp4(partialPath))) {
      throw mediaError("Downloaded file is not a valid MP4/M4S container", {
        code: "MEDIA_CONTAINER_INVALID",
        category: "media",
        userMessage: "下载到的文件不是有效视频容器，已尝试换用其他候选。",
      });
    }

    await fsp.rm(finalPath, { force: true });
    await fsp.rename(partialPath, finalPath);
    return { filePath: finalPath, bytes: stat.size, skipped: false };
  } catch (error) {
    await fsp.rm(partialPath, { force: true }).catch(() => {});
    throw classifyDownloadError(error);
  } finally {
    clearTimeout(timer);
    activeDownloadControllers.delete(controller);
  }
}

function mediaHasAudioFromTracks(tracks) {
  if (tracks == null) return null;
  return Boolean(tracks.audio);
}

async function downloadStreamSet(parsed, streams, alternativeIndex, outputDir, timeoutMs, ffmpegPath, options = {}) {
  const mediaKey = getMediaCacheKey(parsed, alternativeIndex);
  const requireAudio = options.requireAudio !== false;
  if (streams.length === 1 && streams[0].type === "video+audio") {
    const downloaded = await downloadSingleStream(streams[0], mediaKey, "", outputDir, timeoutMs);
    const tracks = await assertPlayableVideo(downloaded.filePath, ffmpegPath, "Downloaded video", { requireAudio });
    await assertExpectedQuality(downloaded.filePath, streams, ffmpegPath);
    return { ...downloaded, mediaHasAudio: mediaHasAudioFromTracks(tracks) };
  }

  const videoStream = streams.find((stream) => stream.type === "video");
  const audioStream = streams.find((stream) => stream.type === "audio");
  if (!videoStream || !audioStream) {
    throw mediaError("Invalid multi-stream: missing video or audio", {
      code: audioStream ? "MEDIA_VIDEO_TRACK_MISSING" : "MEDIA_AUDIO_TRACK_MISSING",
      category: "media",
      userMessage: audioStream
        ? "候选流缺少视频轨，已尝试换用其他候选。"
        : "候选流缺少音频轨，已尝试换用其他候选。",
    });
  }

  let videoFile = null;
  let audioFile = null;
  let mergedPath = null;
  try {
    const streamResults = await Promise.allSettled([
      downloadSingleStream(videoStream, mediaKey, "_video", outputDir, timeoutMs),
      downloadSingleStream(audioStream, mediaKey, "_audio", outputDir, timeoutMs),
    ]);
    if (streamResults[0].status === "fulfilled") videoFile = streamResults[0].value;
    if (streamResults[1].status === "fulfilled") audioFile = streamResults[1].value;
    const rejected = streamResults.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
    mergedPath = path.join(getTempDir(outputDir), `${mediaKey}.mp4`);
    await mergeStreams(videoFile.filePath, audioFile.filePath, mergedPath, ffmpegPath);
    const tracks = await assertPlayableVideo(mergedPath, ffmpegPath, "Merged video", { requireAudio });
    await assertExpectedQuality(mergedPath, streams, ffmpegPath);

    await fsp.rm(videoFile.filePath, { force: true });
    await fsp.rm(audioFile.filePath, { force: true });
    const stat = await fsp.stat(mergedPath);
    return { filePath: mergedPath, bytes: stat.size, skipped: false, mediaHasAudio: mediaHasAudioFromTracks(tracks) };
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

export function buildCandidateFailureError(failures, totalAlternatives) {
  if (totalAlternatives === 0) {
    return new ProcessingError("No media candidate sets were available", {
      code: "MEDIA_DISCOVERY_FAILED",
      category: "platform",
      stage: "download",
      retryable: true,
      retryScope: "item",
      userMessage: "没有找到可下载的视频媒体地址，稍后可重试或检查是否需要登录。",
    });
  }

  const sanitized = failures.map(sanitizeCandidateFailure);
  const onlyAudioMissing = sanitized.length > 0 && sanitized.every((failure) => failure.code === "MEDIA_AUDIO_TRACK_MISSING");
  const onlyVideoMissing = sanitized.length > 0 && sanitized.every((failure) => failure.code === "MEDIA_VIDEO_TRACK_MISSING");
  const hasRetryableItemFailure = sanitized.some((failure) => failure.retryable && failure.retryScope !== "candidate");
  const hasRetryableCandidateFailure = sanitized.some((failure) => failure.retryable);
  const hasPermanentFailure = sanitized.some((failure) => failure.permanent);
  const summary = `All ${totalAlternatives} anonymous media candidate set(s) failed: ` +
    sanitized.map((failure) => `#${failure.alternativeIndex + 1} ${failure.message}`).join(" | ");

  if (onlyAudioMissing) {
    return new ProcessingError(summary, {
      code: "MEDIA_AUDIO_TRACK_MISSING",
      category: "media",
      stage: "download",
      permanent: false,
      retryable: false,
      userMessage: "所有候选媒体都没有音轨，无法转写，已快速跳过这条内容。",
      suggestion: "如果只需要保存视频，可使用 --no-transcribe；如果这是图文作品，目前需要新增图文处理能力。",
      candidateFailures: sanitized,
    });
  }

  if (onlyVideoMissing) {
    return new ProcessingError(summary, {
      code: "MEDIA_VIDEO_TRACK_MISSING",
      category: "media",
      stage: "download",
      permanent: false,
      retryable: false,
      userMessage: "所有候选媒体都没有视频轨，无法作为视频处理，已快速跳过这条内容。",
      candidateFailures: sanitized,
    });
  }

  return new ProcessingError(summary, {
    code: "MEDIA_CANDIDATES_EXHAUSTED",
    category: "media",
    stage: "download",
    permanent: hasPermanentFailure && !hasRetryableCandidateFailure,
    retryable: hasRetryableItemFailure || hasRetryableCandidateFailure,
    retryScope: hasRetryableItemFailure || hasRetryableCandidateFailure ? "item" : "none",
    userMessage: "所有候选媒体都下载或校验失败。",
    suggestion: hasRetryableItemFailure || hasRetryableCandidateFailure
      ? "这类失败可能是临时 CDN 或网络问题，稍后会按重试策略重新解析。"
      : "请检查链接权限、输出目录和本地环境后再试。",
    candidateFailures: sanitized,
  });
}

export async function downloadMedia(parsed, outputDir, timeoutMs, ffmpegPath, options = {}) {
  const alternatives = normalizeMediaAlternatives(parsed);
  const failures = [];
  for (let index = 0; index < alternatives.length; index += 1) {
    const streams = alternatives[index];
    try {
      const downloaded = await downloadStreamSet(parsed, streams, index, outputDir, timeoutMs, ffmpegPath, options);
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
      const normalized = normalizeError(error, { stage: "download" });
      const failure = sanitizeCandidateFailure({ alternativeIndex: index, message: normalized.message, ...normalized });
      failures.push(failure);
      if (isFatalCandidateError(normalized)) {
        normalized.candidateFailures = failures;
        throw normalized;
      }
      if (index + 1 < alternatives.length) {
        console.warn(`    [quality] candidate ${index + 1} failed, trying next anonymous quality: ${normalized.message}`);
      }
    }
  }
  throw buildCandidateFailureError(failures, alternatives.length);
}
