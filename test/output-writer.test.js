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
});
