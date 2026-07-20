import fs from "node:fs";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { serializeErrorInfo } from "../core/errors.js";
import { QUALITY_SELECTION_VERSION } from "../core/policies.js";
import {
  createInitialAgentReview,
  formatTranscriptTxtContent,
} from "../review/coordinator.js";
import { withFileLock, writeJsonAtomic } from "../review/atomic-files.js";
import { getVideoInfo, isValidMp4, itemKey, safeFilename } from "../utils/common.js";

function safePathSegment(value, fallback = "video", maxLen = 80) {
  const raw = String(value ?? "");
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, maxLen);
}

export function formatLocalTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("_") + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export function sanitizeStreamForOutput(stream) {
  if (!stream || typeof stream !== "object") return null;
  const output = {};
  for (const key of [
    "type", "format", "width", "height", "fps", "bitrate", "codec", "quality",
    "label", "source", "totalBytes", "hdr",
  ]) {
    if (stream[key] !== undefined && stream[key] !== null) output[key] = stream[key];
  }
  if (output.width && output.height) output.resolution = `${output.width}x${output.height}`;
  return output;
}

export function buildQualityOutput(parsed) {
  const available = Array.isArray(parsed.availableStreams) && parsed.availableStreams.length > 0
    ? parsed.availableStreams
    : parsed.mediaStreams;
  return {
    access_mode: parsed.accessMode ?? "anonymous",
    selection_version: QUALITY_SELECTION_VERSION,
    available_streams: available.map(sanitizeStreamForOutput).filter(Boolean),
    selected_streams: parsed.mediaStreams.map(sanitizeStreamForOutput).filter(Boolean),
    audit: parsed.qualityAudit ?? {
      advertisedQualities: [],
      accessibleQualities: [],
      selectedQuality: null,
      selectionReason: "Best anonymous stream exposed by the platform parser",
    },
  };
}

function writeOutputs(parsed, transcribeResult, mp4Info, outputDir, options = {}) {
  const timeStr = formatLocalTimestamp();
  const authorName = safeFilename(parsed.author?.nickname ?? "", 20);
  const rawVideoId = parsed.videoId ?? itemKey(parsed.sourceUrl);
  const fileVideoId = safePathSegment(rawVideoId, itemKey(parsed.sourceUrl), 50);
  const platformName = safePathSegment(parsed.platform, "platform", 20);
  const base = `${timeStr}_${platformName}_${authorName}_${fileVideoId}`;
  const itemDir = path.join(outputDir, base);

  fs.mkdirSync(itemDir, { recursive: true });

  const segments = transcribeResult?.segments ?? [];
  const transcript = transcribeResult?.transcript ?? "";
  const transcription = transcribeResult?.meta ?? options.transcriptionRuntime ?? null;
  const jsonPath = path.join(itemDir, `${base}.json`);
  const txtPath = transcript ? path.join(itemDir, `${base}_transcript.txt`) : null;
  const txtContent = formatTranscriptTxtContent(transcript);
  const reviewRequirement = transcript
    ? { required: true, reason: null }
    : options.processingStatus === "transcription_failed"
      ? { required: true, reason: "transcription_failed" }
      : options.transcribe === false
        ? { required: false, reason: "transcription_disabled" }
        : { required: false, reason: "no_speech" };
  const transcriptionErrorInfo = options.transcriptionErrorInfo
    ? serializeErrorInfo(options.transcriptionErrorInfo)
    : null;

  const result = {
    status: options.processingStatus ?? "success",
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
    segments,
    transcript_source: transcribeResult?.meta ? "faster-whisper" : null,
    transcription,
    transcription_error: options.transcriptionError ?? null,
    error_code: transcriptionErrorInfo?.code ?? null,
    error_category: transcriptionErrorInfo?.category ?? null,
    error_stage: transcriptionErrorInfo?.stage ?? null,
    retryable: transcriptionErrorInfo?.retryable ?? null,
    permanent: transcriptionErrorInfo?.permanent ?? null,
    user_message: transcriptionErrorInfo?.userMessage ?? null,
    technical_error: transcriptionErrorInfo?.userMessage && transcriptionErrorInfo.userMessage !== transcriptionErrorInfo.message
      ? transcriptionErrorInfo.message
      : null,
    suggestion: transcriptionErrorInfo?.suggestion ?? null,
    quality: buildQualityOutput(parsed),
    media_info: null,
    output_file: jsonPath,
    transcript_file: txtPath,
    agent_review: createInitialAgentReview({
      transcript,
      txtContent,
      ...reviewRequirement,
    }),
    video_file: null,
    video_output: Boolean(options.videoOutput),
    cache_video_file: mp4Info?.filePath ?? null,
  };

  if (txtContent && txtPath) fs.writeFileSync(txtPath, txtContent, "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
  return { result, itemDir, jsonPath, base };
}

export async function materializeVideoArtifact(mp4Info, itemDir, base, options = {}) {
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

export async function patchJsonVideoArtifact(jsonPath, videoArtifact) {
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

export async function writeOutputsWithMediaInfo(parsed, transcribeResult, mp4Info, outputDir, options = {}) {
  const { result, itemDir, jsonPath, base } = writeOutputs(parsed, transcribeResult, mp4Info, outputDir, options);

  if (mp4Info?.filePath) {
    try {
      const mediaInfo = await getVideoInfo(mp4Info.filePath, options.ffmpegPath ?? null);
      if (mediaInfo) {
        result.media_info = mediaInfo;
        const resolution = mediaInfo.resolution ?? "unknown";
        const bitrate = mediaInfo.bitrate_kbps ? `${mediaInfo.bitrate_kbps} kbps` : "unknown";
        const codec = mediaInfo.codec ?? "unknown";
        console.error(`    [media] ${resolution}, ${bitrate}, ${codec}`);
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

export const writeCompletedResult = writeOutputsWithMediaInfo;

export function writeFailedOutput(sourceUrl, errorMessage, errorType, outputDir, platform, metadata = {}) {
  const timeStr = formatLocalTimestamp();
  const safePlatform = safeFilename(platform || "未知", 20);
  const safeErrorType = safeFilename(errorType, 20);
  const unique = randomUUID().replaceAll("-", "").slice(0, 12);
  const base = `${timeStr}_failed_${safePlatform}_${safeErrorType}_${unique}`;
  const itemDir = path.join(outputDir, base);
  fs.mkdirSync(itemDir, { recursive: true });

  const result = {
    status: "failed",
    source_url: sourceUrl,
    error: errorMessage,
    error_type: metadata.error_type ?? errorType,
  };
  if (platform) result.platform = platform;
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && value !== null && key !== "error_type") result[key] = value;
  }

  const jsonPath = path.join(itemDir, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
  return jsonPath;
}

export async function writeBatchSummary(outputDir, summary, stdout = process.stdout) {
  const summaryFile = path.join(outputDir, "download-summary.json");
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  await withFileLock(summaryFile, () => writeJsonAtomic(summaryFile, summary));
  stdout.write(serialized);
  return summaryFile;
}
