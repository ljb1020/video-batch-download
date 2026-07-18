import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearTempCache,
  fileExists,
  getCacheVideoPath,
  getPendingTranscriptions,
  getTempDir,
  getTranscriptPathFromJsonPath,
  hasReusableJsonOutput,
  hasReusableTranscriptOutput,
} from "../scripts/core/resume.js";

test("resume path helpers preserve legacy cache aliases and transcript naming", () => {
  assert.equal(getCacheVideoPath({ cacheVideoPath: "new.mp4", filePath: "old.mp4" }), "new.mp4");
  assert.equal(getCacheVideoPath({ filePath: "old.mp4" }), "old.mp4");
  assert.equal(getTranscriptPathFromJsonPath("result.json"), "result_transcript.txt");
  assert.equal(getTranscriptPathFromJsonPath("result.data"), "result.data_transcript.txt");
});

test("JSON and transcript reuse requires completed files on disk", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "video-resume-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const jsonPath = path.join(dir, "result.json");
  const transcriptPath = path.join(dir, "result_transcript.txt");
  const state = { status: "completed", jsonPath, hasTranscript: true };

  assert.equal(await hasReusableJsonOutput(state), false);
  await fsp.writeFile(jsonPath, "{}", "utf8");
  assert.equal(await hasReusableJsonOutput(state), true);
  assert.equal(await hasReusableTranscriptOutput(state), false);
  await fsp.writeFile(transcriptPath, "text", "utf8");
  assert.equal(await hasReusableTranscriptOutput(state), true);

  const pending = await getPendingTranscriptions([
    { id: "complete", state },
    { id: "pending", state: { status: "downloaded" } },
  ]);
  assert.deepEqual(pending.map((item) => item.id), ["pending"]);
});

test("a completed no-speech transcription reuses its JSON without requiring TXT", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "video-resume-no-speech-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const jsonPath = path.join(dir, "result.json");
  await fsp.writeFile(jsonPath, "{}", "utf8");

  assert.equal(await hasReusableTranscriptOutput({
    status: "completed",
    jsonPath,
    hasTranscript: false,
    transcriptionCompleted: true,
  }), true);
});

test("temporary cache helpers resolve and clear the cache directory", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "video-temp-cache-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const tempDir = getTempDir(dir);
  await fsp.mkdir(tempDir);
  await fsp.writeFile(path.join(tempDir, "part.mp4"), "partial", "utf8");

  assert.equal(await fileExists(tempDir), true);
  assert.equal(await clearTempCache(dir), tempDir);
  assert.equal(await fileExists(tempDir), false);
});

test("clearing media cache preserves resumable Agent review work", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "video-temp-review-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const tempDir = getTempDir(dir);
  const reviewDir = path.join(tempDir, "agent-review", "run-1", "claim-1");
  await fsp.mkdir(reviewDir, { recursive: true });
  await fsp.writeFile(path.join(tempDir, "cached.mp4"), "cache", "utf8");
  await fsp.writeFile(path.join(reviewDir, "work.txt"), "checkpoint", "utf8");

  await clearTempCache(dir);

  assert.equal(await fileExists(path.join(tempDir, "cached.mp4")), false);
  assert.equal(await fileExists(path.join(reviewDir, "work.txt")), true);
});
