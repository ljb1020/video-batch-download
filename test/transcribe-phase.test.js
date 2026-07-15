import assert from "node:assert/strict";
import test from "node:test";

import { writeOutputItem } from "../scripts/pipeline/transcribe-phase.js";

test("a final transcription failure preserves output paths and uses transcription_failed", async () => {
  let storedPatch = null;
  const runtimeConfig = {
    model: "small",
    device: "cpu",
    compute_type: "int8",
    fallback_reason: "CUDA unavailable",
  };

  const jsonPath = await writeOutputItem({
    url: "https://example.test/video",
    state: {
      parsed: { title: "video" },
      cacheVideoPath: "cached.mp4",
      bytes: 123,
    },
    transcribeResult: null,
    errorMessage: "CPU transcription failed",
    status: "transcription_failed",
    runtimeConfig,
    options: { output: "out" },
    store: {
      update: async (_url, patch) => {
        storedPatch = patch;
      },
    },
    writeOutputs: async () => ({
      jsonPath: "result.json",
      videoFilePath: "result.mp4",
      videoOutput: true,
      cacheVideoPath: "cached.mp4",
    }),
  });

  assert.equal(jsonPath, "result.json");
  assert.deepEqual(storedPatch, {
    status: "transcription_failed",
    jsonPath: "result.json",
    hasTranscript: false,
    transcriptionCompleted: false,
    transcription: runtimeConfig,
    videoFilePath: "result.mp4",
    videoOutput: true,
    cacheVideoPath: "cached.mp4",
    lastError: "CPU transcription failed",
  });
});

test("successful transcription remains completed and records actual runtime metadata", async () => {
  let storedPatch = null;
  const meta = { model: "small", device: "cpu", compute_type: "int8" };

  await writeOutputItem({
    url: "url",
    state: { parsed: {}, cacheVideoPath: "cached.mp4", bytes: 1 },
    transcribeResult: { transcript: "text", segments: [], meta },
    errorMessage: null,
    options: { output: "out" },
    store: { update: async (_url, patch) => { storedPatch = patch; } },
    writeOutputs: async () => ({
      jsonPath: "result.json",
      videoFilePath: null,
      videoOutput: false,
      cacheVideoPath: "cached.mp4",
    }),
  });

  assert.equal(storedPatch.status, "completed");
  assert.equal(storedPatch.hasTranscript, true);
  assert.equal(storedPatch.transcriptionCompleted, true);
  assert.deepEqual(storedPatch.transcription, meta);
  assert.equal(storedPatch.lastError, null);
});

test("a successful no-speech result is completed without a transcript TXT", async () => {
  let storedPatch = null;

  await writeOutputItem({
    url: "url",
    state: { parsed: {}, cacheVideoPath: "cached.mp4", bytes: 1 },
    transcribeResult: { transcript: "", segments: [], meta: { language: "zh" } },
    errorMessage: null,
    options: { output: "out" },
    store: { update: async (_url, patch) => { storedPatch = patch; } },
    writeOutputs: async () => ({
      jsonPath: "result.json",
      videoFilePath: null,
      videoOutput: false,
      cacheVideoPath: "cached.mp4",
    }),
  });

  assert.equal(storedPatch.status, "completed");
  assert.equal(storedPatch.hasTranscript, false);
  assert.equal(storedPatch.transcriptionCompleted, true);
});
