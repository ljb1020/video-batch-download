import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSummary } from "../scripts/pipeline/run-batch.js";
import { createInitialAgentReview } from "../scripts/review/coordinator.js";

test("batch summary counts transcription failures separately and records runtime config", async () => {
  const items = {
    ok: {
      status: "completed",
      hasTranscript: true,
      transcription: {
        model: "small",
        device: "cpu",
        compute_type: "int8",
        fallback_reason: "CUDA unavailable",
      },
    },
    bad: {
      status: "transcription_failed",
      hasTranscript: false,
      lastError: "CPU transcription failed",
      transcription: {
        model: "small",
        device: "cpu",
        compute_type: "int8",
        fallback_reason: "CUDA unavailable",
      },
    },
  };
  const summary = await buildSummary({
    urlsWithParsers: [{ url: "ok" }, { url: "bad" }],
    options: {
      output: "out",
      videoOutput: false,
      transcribe: true,
      model: "medium",
      device: "cuda",
      computeType: "float16",
    },
    store: { file: "state.json", get: (url) => items[url] },
    accessMode: "anonymous",
    platforms: [],
    platformWarnings: [],
  });

  assert.equal(summary.completed, 1);
  assert.equal(summary.transcriptionFailed, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.transcribe.requested, {
    model: "medium",
    device: "cuda",
    compute_type: "float16",
  });
  assert.equal(summary.transcribe.actual.length, 2);
  assert.equal(summary.results[1].status, "transcription_failed");
  assert.match(summary.runId, /^[0-9a-f-]{36}$/u);
  assert.equal(summary.agentReview.status, "completed");
});

test("batch summary aggregates review state only from current result JSON paths", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "video-summary-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transcriptFile = path.join(dir, "item_transcript.txt");
  const jsonPath = path.join(dir, "item.json");
  const transcript = "待审阅文本";
  const txtContent = `${transcript}\n`;
  await writeFile(transcriptFile, txtContent, "utf8");
  await writeFile(jsonPath, JSON.stringify({
    status: "success",
    transcript,
    transcript_file: transcriptFile,
    agent_review: createInitialAgentReview({ transcript, txtContent, required: true }),
  }), "utf8");

  const summary = await buildSummary({
    urlsWithParsers: [{ url: "current" }],
    options: { output: dir, videoOutput: false, transcribe: true, model: "small", device: "cpu", computeType: "int8" },
    store: { file: "state.json", get: () => ({ status: "completed", jsonPath, hasTranscript: true }) },
    accessMode: "anonymous",
    platforms: [],
    platformWarnings: [],
    runId: "test-run",
  });

  assert.equal(summary.runId, "test-run");
  assert.equal(summary.results[0].transcriptFile, transcriptFile);
  assert.equal("agentReview" in summary.results[0], false);
  assert.equal(summary.agentReview.status, "pending");
  assert.equal(summary.agentReview.required, 1);
  assert.equal(summary.agentReview.pending, 1);
});
