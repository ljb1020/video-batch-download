import assert from "node:assert/strict";
import test from "node:test";

import { buildSummary } from "../scripts/pipeline/run-batch.js";

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
});
