import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProcessingError } from "../scripts/core/errors.js";
import { formatLocalTimestamp, writeFailedOutput, writeOutputsWithMediaInfo } from "../scripts/output/writer.js";

test("formatLocalTimestamp uses local date and time components", () => {
  const date = new Date(2026, 6, 15, 21, 4, 9);

  assert.equal(formatLocalTimestamp(date), "2026_07_15_21-04-09");
});

test("failed output records structured error fields and uses unique paths", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-failed-output-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));

  const firstPath = writeFailedOutput(
    "https://v.douyin.com/O4xI88QN9XI/",
    "This is an image note",
    "permanent",
    outputDir,
    "抖音",
    {
      error_code: "UNSUPPORTED_CONTENT_TYPE",
      error_category: "content",
      error_stage: "parse",
      retryable: false,
      permanent: true,
      attempts: 1,
      user_message: "这是抖音图文作品，不是可转写视频，已跳过。",
      suggestion: "如果需要处理图文内容，需要新增图片/文字提取能力。",
      content_type: "image_note",
    },
  );
  const secondPath = writeFailedOutput(
    "https://v.douyin.com/O4xI88QN9XI/",
    "This is an image note",
    "permanent",
    outputDir,
    "抖音",
    { error_code: "UNSUPPORTED_CONTENT_TYPE", error_category: "content", attempts: 1 },
  );

  assert.notEqual(firstPath, secondPath);
  const result = JSON.parse(await readFile(firstPath, "utf8"));
  assert.equal(result.status, "failed");
  assert.equal(result.error_type, "permanent");
  assert.equal(result.error_code, "UNSUPPORTED_CONTENT_TYPE");
  assert.equal(result.error_category, "content");
  assert.equal(result.retryable, false);
  assert.equal(result.permanent, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.content_type, "image_note");
  assert.match(result.user_message, /图文作品/u);
  assert.match(result.suggestion, /图片\/文字提取能力/u);
});

test("failed transcription is explicit in the user-facing JSON", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-output-writer-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const runtime = {
    model: "small",
    device: "cpu",
    compute_type: "int8",
    fallback_reason: "CUDA unavailable",
  };

  const { jsonPath } = await writeOutputsWithMediaInfo({
    sourceUrl: "https://video.weibo.com/show?fid=1034:1",
    canonicalUrl: "https://weibo.com/tv/show/1034:1",
    videoId: "1034:1",
    platform: "微博",
    title: "测试",
    description: "",
    author: { nickname: "测试作者", uid: null, url: null },
    postTime: null,
    duration: null,
    statistics: {},
    mediaStreams: [{ url: "https://media.test/video.mp4", type: "video+audio", format: "mp4" }],
  }, null, null, outputDir, {
    videoOutput: false,
    processingStatus: "transcription_failed",
    transcriptionError: "CUDA and CPU transcription failed",
    transcriptionErrorInfo: new ProcessingError("CUDA and CPU transcription failed", {
      code: "TRANSCRIPTION_RUNTIME_FAILED",
      category: "transcription",
      stage: "transcribe",
      retryable: false,
      userMessage: "本地转写运行失败，视频和元数据已保留。",
      suggestion: "可以尝试 --device cpu、降低模型大小，或查看错误详情定位本地运行环境问题。",
    }),
    transcriptionRuntime: runtime,
  });

  const result = JSON.parse(await readFile(jsonPath, "utf8"));
  assert.equal(result.status, "transcription_failed");
  assert.equal(result.transcription_error, "CUDA and CPU transcription failed");
  assert.equal(result.error_code, "TRANSCRIPTION_RUNTIME_FAILED");
  assert.equal(result.error_category, "transcription");
  assert.equal(result.error_stage, "transcribe");
  assert.equal(result.retryable, false);
  assert.equal(result.permanent, false);
  assert.match(result.user_message, /转写运行失败/u);
  assert.match(result.technical_error, /CUDA and CPU transcription failed/u);
  assert.deepEqual(result.transcription, runtime);
  assert.equal(result.agent_review.schema_version, 2);
  assert.equal(result.agent_review.required, true);
  assert.equal(result.agent_review.status, "pending");
  assert.equal(result.agent_review.reason, "transcription_failed");
  assert.equal(result.agent_review.source_txt_sha256, null);
});

test("a transcript gets a reviewable UTF-8/LF TXT and hash-backed pending state", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-output-review-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const transcript = "第一行\r\n第二 line";

  const { jsonPath } = await writeOutputsWithMediaInfo({
    sourceUrl: "https://example.test/video",
    canonicalUrl: "https://example.test/video",
    videoId: "review-1",
    platform: "测试",
    title: "审阅测试",
    description: "",
    author: { nickname: "作者" },
    statistics: {},
    mediaStreams: [],
  }, { transcript, segments: [{ text: "第一行" }, { text: "第二 line" }] }, null, outputDir, {
    videoOutput: false,
    transcribe: true,
  });

  const result = JSON.parse(await readFile(jsonPath, "utf8"));
  const txt = await readFile(result.transcript_file, "utf8");
  assert.equal(result.transcript, transcript);
  assert.equal(txt, "第一行\n第二 line\n");
  assert.equal(result.agent_review.required, true);
  assert.equal(result.agent_review.status, "pending");
  assert.equal(result.agent_review.reason, null);
  assert.equal(result.agent_review.review_started_at, null);
  assert.equal(result.agent_review.subagent_failure_count, 0);
  assert.match(result.agent_review.source_transcript_sha256, /^[a-f0-9]{64}$/u);
  assert.match(result.agent_review.source_txt_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.agent_review.estimated_transcript_tokens, 7);
});
