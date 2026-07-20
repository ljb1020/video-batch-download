import assert from "node:assert/strict";
import test from "node:test";

import {
  ProcessingError,
  normalizeError,
  normalizeTranscriptionError,
  serializeErrorInfo,
} from "../scripts/core/errors.js";

test("permanent processing errors are never treated as retryable", () => {
  const error = new ProcessingError("Image notes are not supported", {
    code: "UNSUPPORTED_CONTENT_TYPE",
    category: "content",
    permanent: true,
    retryable: true,
    stage: "parse",
    userMessage: "这是图文作品，不能转写。",
    suggestion: "如需处理图文内容，请先新增图片/文字提取能力。",
  });

  assert.equal(error.code, "UNSUPPORTED_CONTENT_TYPE");
  assert.equal(error.category, "content");
  assert.equal(error.permanent, true);
  assert.equal(error.retryable, false);
  assert.equal(error.stage, "parse");
  assert.equal(error.userMessage, "这是图文作品，不能转写。");
});

test("normalizeError retries plain transient parser errors by default", () => {
  const normalized = normalizeError(new Error("No Bilibili view API response"), { stage: "parse" });

  assert.equal(normalized.code, "UNEXPECTED_ERROR");
  assert.equal(normalized.category, "platform");
  assert.equal(normalized.retryable, true);
  assert.equal(normalized.retryScope, "item");
});

test("normalizeError does not treat Node ERR_* codes as retryable app errors", () => {
  const invalid = Object.assign(new TypeError("bad argument"), { code: "ERR_INVALID_ARG_TYPE" });
  const normalized = normalizeError(invalid, { stage: "parse" });

  assert.equal(normalized.code, "UNEXPECTED_ERROR");
  assert.equal(normalized.category, "internal");
  assert.equal(normalized.retryable, false);
});

test("normalizeError preserves legacy permanent errors from existing parsers", () => {
  const legacy = new Error("content deleted");
  legacy.permanent = true;

  const normalized = normalizeError(legacy, { stage: "parse" });

  assert.equal(normalized.permanent, true);
  assert.equal(normalized.retryable, false);
  assert.equal(normalized.category, "content");
});

test("normalizeError maps local environment and filesystem errors to non-retryable categories", () => {
  const enoent = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT", syscall: "spawn ffmpeg" });
  const ffmpeg = normalizeError(enoent, { stage: "preflight" });
  assert.equal(ffmpeg.code, "FFMPEG_UNAVAILABLE");
  assert.equal(ffmpeg.category, "environment");
  assert.equal(ffmpeg.retryable, false);

  const enospc = Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
  const disk = normalizeError(enospc, { stage: "download" });
  assert.equal(disk.code, "FILESYSTEM_NO_SPACE");
  assert.equal(disk.category, "output");
  assert.equal(disk.retryable, false);
});

test("normalizeTranscriptionError maps timeout and audio extraction failures", () => {
  const timeout = normalizeTranscriptionError(new Error("Transcription timeout"), { phase: "runtime" });
  assert.equal(timeout.code, "TRANSCRIPTION_TIMEOUT");
  assert.equal(timeout.category, "transcription");
  assert.equal(timeout.retryable, true);

  const missingAudio = normalizeTranscriptionError(new Error("ffmpeg failed (exit 1): Output file does not contain any stream"), { phase: "audio_extract" });
  assert.equal(missingAudio.code, "MEDIA_AUDIO_TRACK_MISSING");
  assert.equal(missingAudio.category, "media");
  assert.equal(missingAudio.retryable, false);

  const audio = normalizeTranscriptionError(new Error("ffmpeg failed (exit 1): decoder failed"), { phase: "audio_extract" });
  assert.equal(audio.code, "AUDIO_EXTRACTION_FAILED");
});

test("serializeErrorInfo preserves stable fields and omits bulky implementation details", () => {
  const error = new ProcessingError("All candidate streams failed", {
    code: "MEDIA_CANDIDATES_EXHAUSTED",
    category: "media",
    stage: "download",
    retryable: true,
    candidateFailures: [
      {
        alternativeIndex: 0,
        code: "MEDIA_HTTP_STATUS",
        category: "network",
        retryable: true,
        message: "Media request returned HTTP 403",
        url: "https://signed.example/video.mp4?token=secret",
      },
    ],
    details: { stderr: "x".repeat(10_000) },
  });

  const serialized = serializeErrorInfo(error);
  assert.equal(serialized.code, "MEDIA_CANDIDATES_EXHAUSTED");
  assert.equal(serialized.category, "media");
  assert.equal(serialized.retryable, true);
  assert.equal(serialized.candidateFailures.length, 1);
  assert.equal("url" in serialized.candidateFailures[0], false);
  assert.ok(serialized.details.stderr.length < 2_000);
});
