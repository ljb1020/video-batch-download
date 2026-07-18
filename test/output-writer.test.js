import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatLocalTimestamp, writeOutputsWithMediaInfo } from "../scripts/output/writer.js";

test("formatLocalTimestamp uses local date and time components", () => {
  const date = new Date(2026, 6, 15, 21, 4, 9);

  assert.equal(formatLocalTimestamp(date), "2026_07_15_21-04-09");
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
    transcriptionRuntime: runtime,
  });

  const result = JSON.parse(await readFile(jsonPath, "utf8"));
  assert.equal(result.status, "transcription_failed");
  assert.equal(result.transcription_error, "CUDA and CPU transcription failed");
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
