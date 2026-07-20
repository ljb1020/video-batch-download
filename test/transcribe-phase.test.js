import assert from "node:assert/strict";
import test from "node:test";

import { ProcessingError } from "../scripts/core/errors.js";
import { runTranscriptionPhase, writeOutputItem } from "../scripts/pipeline/transcribe-phase.js";

test("a final transcription failure preserves output paths and uses transcription_failed", async () => {
  let storedPatch = null;
  let writeOptions = null;
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
    errorInfo: new ProcessingError("CPU transcription failed", {
      code: "TRANSCRIPTION_RUNTIME_FAILED",
      category: "transcription",
      stage: "transcribe",
      retryable: false,
      userMessage: "本地转写运行失败，视频和元数据已保留。",
    }),
    options: { output: "out" },
    store: {
      update: async (_url, patch) => {
        storedPatch = patch;
      },
    },
    writeOutputs: async (_parsed, _result, _mp4, _out, options) => {
      writeOptions = options;
      return {
        jsonPath: "result.json",
        videoFilePath: "result.mp4",
        videoOutput: true,
        cacheVideoPath: "cached.mp4",
      };
    },
  });

  assert.equal(jsonPath, "result.json");
  assert.equal(writeOptions.transcriptionError, "CPU transcription failed");
  assert.equal(writeOptions.transcriptionErrorInfo?.userMessage, "本地转写运行失败，视频和元数据已保留。");
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
    lastErrorCode: "TRANSCRIPTION_RUNTIME_FAILED",
    lastErrorCategory: "transcription",
    lastErrorStage: "transcribe",
    lastUserMessage: "本地转写运行失败，视频和元数据已保留。",
    lastSuggestion: null,
    retryable: false,
    permanent: false,
    candidateFailures: null,
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
  assert.equal(storedPatch.lastErrorCode, null);
  assert.equal(storedPatch.retryable, null);
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

test("retryable transcription timeouts are retried then marked non-retryable when exhausted", async () => {
  let attempts = 0;
  let finalWrite = null;
  const url = "https://example.test/video";
  const storeData = new Map([
    [url, {
      status: "downloaded",
      parsed: { title: "video" },
      cacheVideoPath: "cached.mp4",
      filePath: "cached.mp4",
      bytes: 10,
    }],
  ]);
  const pendingItem = {
    url,
    state: storeData.get(url),
  };

  await runTranscriptionPhase({
    urlsWithParsers: [{ url }],
    options: {
      output: "out",
      ffmpegPath: null,
      maxAttempts: 2,
      model: "small",
      device: "cpu",
      computeType: "int8",
    },
    store: {
      get: (key) => storeData.get(key),
      update: async (key, patch) => {
        storeData.set(key, { ...storeData.get(key), ...patch });
      },
    },
    isStopping: () => false,
    transcriber: {
      start: async () => {},
      isRunning: () => true,
      close: () => {},
      getRuntimeConfig: () => ({ model: "small", device: "cpu", compute_type: "int8" }),
      transcribe: async () => {
        attempts += 1;
        throw new Error("Transcription timeout after 120s");
      },
    },
    deps: {
      collectDownloadedItems: async () => [pendingItem],
      getPendingTranscriptions: async (items) => items,
      extractAudio: async () => "audio.wav",
      sleep: async () => {},
      retryDelay: () => 0,
      writeOutputItem: async (args) => {
        finalWrite = args;
        if (args.store?.update) {
          await args.store.update(args.url, {
            status: args.status,
            lastError: args.errorMessage,
            lastErrorCode: args.errorInfo?.code ?? null,
            retryable: args.errorInfo?.retryable ?? null,
          });
        }
        return "failed.json";
      },
    },
  });

  assert.equal(attempts, 2);
  assert.equal(finalWrite.status, "transcription_failed");
  assert.equal(finalWrite.errorInfo.code, "TRANSCRIPTION_TIMEOUT");
  assert.equal(finalWrite.errorInfo.retryable, false);
  assert.match(finalWrite.errorMessage, /timeout/i);
  assert.equal(storeData.get(url).status, "transcription_failed");
  assert.equal(storeData.get(url).retryable, false);
  // Terminal conversion must clone, not mutate the original retryable timeout error object.
  assert.notEqual(finalWrite.errorInfo.cause?.retryable, false);
});
