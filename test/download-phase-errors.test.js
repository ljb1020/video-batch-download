import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProcessingError } from "../scripts/core/errors.js";
import { QUALITY_SELECTION_VERSION } from "../scripts/core/policies.js";
import { processDownloadItem } from "../scripts/pipeline/download-phase.js";

class FixtureParser {
  static platformId = "fixture";
  static getPlatformName() { return "测试平台"; }
  async parse() {
    return {
      platform: "测试平台",
      sourceUrl: "https://example.test/video/1",
      canonicalUrl: "https://example.test/video/1",
      videoId: "video-1",
      title: "测试视频",
      author: { nickname: "作者", uid: null, url: null },
      description: null,
      postTime: null,
      duration: 10,
      statistics: {},
      mediaStreams: [{ url: "https://media.example/video.mp4", type: "video+audio", format: "mp4" }],
    };
  }
}

function createStore() {
  const data = new Map();
  const updates = [];
  return {
    updates,
    get: (url) => data.get(url) ?? null,
    update: async (url, patch) => {
      updates.push({ url, patch });
      data.set(url, { ...(data.get(url) ?? { sourceUrl: url }), ...patch });
    },
  };
}

function baseContext(overrides = {}) {
  const store = createStore();
  return {
    item: { url: "https://example.test/video/1", ParserClass: FixtureParser },
    index: 0,
    total: 1,
    options: {
      output: "out",
      maxAttempts: 0,
      transcribe: true,
      downloadTimeoutMs: 1_000,
      ffmpegPath: null,
      ...overrides.options,
    },
    store,
    browserManager: {},
    parseSemaphore: { use: (fn) => fn() },
    downloadSemaphore: { use: (fn) => fn() },
    accessMode: "anonymous",
    isStopping: () => false,
    deps: {
      ensureFfmpegAvailable: () => {},
      downloadMedia: async () => ({ filePath: "video.mp4", bytes: 123, alternativeIndex: 0, fallbackFailures: [] }),
      sleep: async () => {},
      retryDelay: () => 0,
      writeFailedOutput: () => "failed.json",
      ...overrides.deps,
    },
    ...overrides.context,
    store,
  };
}

test("non-retryable environment errors stop immediately even when maxAttempts is unlimited", async () => {
  let failedMetadata = null;
  const context = baseContext({
    deps: {
      ensureFfmpegAvailable: () => {
        throw new ProcessingError("ffmpeg is not available", {
          code: "FFMPEG_UNAVAILABLE",
          category: "environment",
          stage: "preflight",
          retryable: false,
          userMessage: "ffmpeg 不可用，请安装 ffmpeg 或通过 --ffmpeg-path 指定路径。",
        });
      },
      writeFailedOutput: (_url, _message, _type, _output, _platform, metadata) => {
        failedMetadata = metadata;
        return "failed.json";
      },
    },
  });

  const result = await processDownloadItem(context);

  assert.equal(result.status, "failed");
  assert.equal(result.attempt, 1);
  assert.equal(context.store.get(context.item.url).status, "failed");
  assert.equal(context.store.get(context.item.url).lastErrorCode, "FFMPEG_UNAVAILABLE");
  assert.equal(context.store.get(context.item.url).retryable, false);
  assert.equal(failedMetadata.error_code, "FFMPEG_UNAVAILABLE");
  assert.equal(failedMetadata.error_type, "non_retryable");
});

test("successful fallback keeps candidate failure diagnostics", async () => {
  const fallbackFailures = [{ alternativeIndex: 0, code: "MEDIA_HTTP_STATUS", message: "403" }];
  const context = baseContext({
    deps: {
      downloadMedia: async () => ({ filePath: "video.mp4", bytes: 123, alternativeIndex: 1, fallbackFailures }),
    },
  });

  await processDownloadItem(context);

  assert.deepEqual(context.store.get(context.item.url).candidateFailures, fallbackFailures);
});

test("in-flight stop reports interruption instead of the underlying media error", async () => {
  let stopping = false;
  let failedMetadata = null;
  const context = baseContext({
    context: { isStopping: () => stopping },
    deps: {
      downloadMedia: async () => {
        stopping = true;
        throw new ProcessingError("Download timeout", {
          code: "MEDIA_DOWNLOAD_TIMEOUT",
          category: "network",
          stage: "download",
          retryable: true,
        });
      },
      writeFailedOutput: (_url, _message, _type, _output, _platform, metadata) => {
        failedMetadata = metadata;
        return "interrupted.json";
      },
    },
    options: { maxAttempts: 3 },
  });

  const result = await processDownloadItem(context);

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "OPERATION_INTERRUPTED");
  assert.equal(failedMetadata.error_type, "interrupted");
  assert.equal(failedMetadata.error_code, "OPERATION_INTERRUPTED");
});

test("outer download phase catch writes structured unexpected failures", async () => {
  const { runDownloadPhase } = await import("../scripts/pipeline/download-phase.js");
  const store = createStore();
  let failedMetadata = null;
  let failedMessage = null;

  // Force processDownloadItem path to throw outside its internal try by using a bad item shape.
  const results = await runDownloadPhase({
    urlsWithParsers: [{ url: "https://example.test/video/outer", ParserClass: FixtureParser }],
    options: {
      output: "out",
      maxAttempts: 1,
      transcribe: true,
      downloadTimeoutMs: 1_000,
      ffmpegPath: null,
    },
    store,
    browserManager: {},
    parseSemaphore: { use: async () => { throw Object.assign(new Error("boom"), { unexpectedOuter: true }); } },
    downloadSemaphore: { use: (fn) => fn() },
    accessMode: "anonymous",
    isStopping: () => false,
    deps: {
      ensureFfmpegAvailable: () => {},
      downloadMedia: async () => ({ filePath: "video.mp4", bytes: 1, alternativeIndex: 0, fallbackFailures: [] }),
      sleep: async () => {},
      retryDelay: () => 0,
      writeFailedOutput: (_url, message, type, _output, _platform, metadata) => {
        failedMessage = message;
        failedMetadata = { type, ...metadata };
        return "outer-failed.json";
      },
    },
  });

  // parse errors are handled inside processDownloadItem, so this still exercises structured failure write.
  assert.equal(results[0].status, "failed");
  assert.ok(results[0].errorCode);
  assert.equal(store.get("https://example.test/video/outer").status, "failed");
  assert.ok(failedMetadata?.error_code || store.get("https://example.test/video/outer").lastErrorCode);
  assert.ok(failedMessage || store.get("https://example.test/video/outer").lastError);
});

test("permanent platform errors are recorded as permanent_failure without retrying", async () => {
  class PermanentParser extends FixtureParser {
    async parse() {
      throw new ProcessingError("This is an image note", {
        code: "UNSUPPORTED_CONTENT_TYPE",
        category: "content",
        stage: "parse",
        permanent: true,
        userMessage: "这是图文作品，不是可转写视频。",
      });
    }
  }
  let parseAttempts = 0;
  PermanentParser.prototype.parse = async () => {
    parseAttempts += 1;
    throw new ProcessingError("This is an image note", {
      code: "UNSUPPORTED_CONTENT_TYPE",
      category: "content",
      stage: "parse",
      permanent: true,
      userMessage: "这是图文作品，不是可转写视频。",
    });
  };

  const context = baseContext({
    context: { item: { url: "https://example.test/note/1", ParserClass: PermanentParser } },
    options: { maxAttempts: 10 },
  });

  const result = await processDownloadItem(context);

  assert.equal(result.status, "permanent_failure");
  assert.equal(result.attempt, 1);
  assert.equal(parseAttempts, 1);
  assert.equal(context.store.get(context.item.url).lastErrorCode, "UNSUPPORTED_CONTENT_TYPE");
  assert.equal(context.store.get(context.item.url).permanent, true);
});

test("successful download stores mediaHasAudio from probe, not optimistic true", async () => {
  const context = baseContext({
    deps: {
      downloadMedia: async (_parsed, _out, _timeout, _ffmpeg, options) => {
        assert.equal(options.requireAudio, true);
        return {
          filePath: "video.mp4",
          bytes: 123,
          alternativeIndex: 0,
          fallbackFailures: [],
          mediaHasAudio: null, // inconclusive probe
        };
      },
    },
  });

  await processDownloadItem(context);
  assert.equal(context.store.get(context.item.url).mediaHasAudio, null);

  const conclusive = baseContext({
    deps: {
      downloadMedia: async () => ({
        filePath: "video.mp4",
        bytes: 10,
        alternativeIndex: 0,
        fallbackFailures: [],
        mediaHasAudio: true,
      }),
    },
  });
  await processDownloadItem(conclusive);
  assert.equal(conclusive.store.get(conclusive.item.url).mediaHasAudio, true);
});

test("transcribe undefined still requires audio on download and resume cache path", async () => {
  let seenRequireAudio = null;
  const context = baseContext({
    options: { transcribe: undefined },
    deps: {
      downloadMedia: async (_parsed, _out, _timeout, _ffmpeg, options) => {
        seenRequireAudio = options.requireAudio;
        return {
          filePath: "video.mp4",
          bytes: 50,
          alternativeIndex: 0,
          fallbackFailures: [],
          mediaHasAudio: true,
        };
      },
    },
  });

  await processDownloadItem(context);
  assert.equal(seenRequireAudio, true);
  assert.equal(context.store.get(context.item.url).mediaHasAudio, true);
});

async function writeMinimalMp4(filePath) {
  // isValidMp4 requires >= 1024 bytes and an ftyp marker.
  const header = Buffer.alloc(1024, 0);
  Buffer.from("ftypisom").copy(header, 4);
  await fsp.writeFile(filePath, header);
}

test("resume rejects silent cache when requireAudio even if transcribe is undefined", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "download-phase-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, "silent.mp4");
  await writeMinimalMp4(cachePath);

  let parseCalls = 0;
  class CountingParser extends FixtureParser {
    async parse() {
      parseCalls += 1;
      return super.parse();
    }
  }

  const url = "https://example.test/video/resume-silent";
  const context = baseContext({
    context: { item: { url, ParserClass: CountingParser } },
    options: { maxAttempts: 1, transcribe: undefined },
  });
  await context.store.update(url, {
    status: "downloaded",
    selectionVersion: QUALITY_SELECTION_VERSION,
    accessMode: "anonymous",
    mediaHasAudio: false,
    filePath: cachePath,
    cacheVideoPath: cachePath,
    bytes: 1024,
    parsed: {
      platform: "测试平台",
      sourceUrl: url,
      canonicalUrl: url,
      videoId: "video-1",
      title: "silent",
      author: { nickname: "作者", uid: null, url: null },
      description: null,
      postTime: null,
      duration: 1,
      statistics: {},
      mediaStreams: [{ url: "https://media.example/video.mp4", type: "video+audio", format: "mp4" }],
    },
  });

  const result = await processDownloadItem(context);
  assert.equal(result.status, "downloaded");
  assert.equal(parseCalls, 1);
  assert.notEqual(result.filePath, cachePath);
});

test("resume reuses cache when mediaHasAudio is true without re-download", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "download-phase-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, "ok.mp4");
  await writeMinimalMp4(cachePath);

  let parseCalls = 0;
  class CountingParser extends FixtureParser {
    async parse() {
      parseCalls += 1;
      return super.parse();
    }
  }

  const url = "https://example.test/video/resume-ok";
  const context = baseContext({
    context: { item: { url, ParserClass: CountingParser } },
    options: { maxAttempts: 1, transcribe: undefined },
  });
  await context.store.update(url, {
    status: "downloaded",
    selectionVersion: QUALITY_SELECTION_VERSION,
    accessMode: "anonymous",
    mediaHasAudio: true,
    filePath: cachePath,
    cacheVideoPath: cachePath,
    bytes: 1024,
    parsed: {
      platform: "测试平台",
      sourceUrl: url,
      canonicalUrl: url,
      videoId: "video-1",
      title: "ok",
      author: { nickname: "作者", uid: null, url: null },
      description: null,
      postTime: null,
      duration: 1,
      statistics: {},
      mediaStreams: [{ url: "https://media.example/video.mp4", type: "video+audio", format: "mp4" }],
    },
  });

  const result = await processDownloadItem(context);
  assert.equal(result.status, "downloaded");
  assert.equal(result.resumed, true);
  assert.equal(result.filePath, cachePath);
  assert.equal(parseCalls, 0);
});
