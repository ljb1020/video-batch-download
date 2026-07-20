import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { parseArgs, readInputText, usage } from "../cli/options.js";
import { QUALITY_SELECTION_VERSION } from "../core/policies.js";
import { clearTempCache, getExistingCacheVideoPath } from "../core/resume.js";
import { abortActiveDownloads } from "../media/downloader.js";
import { terminateActiveMediaProcesses } from "../media/ffmpeg.js";
import { extractAndRouteUrls, getPlatformId, loadPlatforms } from "../platforms/router.js";
import { TranscriptionClient } from "../transcription/client.js";
import { writeBatchSummary } from "../output/writer.js";
import { buildInitialAgentReviewSummary } from "../review/coordinator.js";
import { BrowserManager } from "../utils/browser-manager.js";
import { Semaphore } from "../utils/semaphore.js";
import { StateStore } from "../utils/state-store.js";
import { runDownloadPhase } from "./download-phase.js";
import { finalizeWithoutTranscription, runTranscriptionPhase } from "./transcribe-phase.js";

export async function buildSummary({
  urlsWithParsers,
  options,
  store,
  accessMode,
  platforms,
  platformWarnings,
  runId = randomUUID(),
}) {
  const urls = urlsWithParsers.map(({ url }) => url);
  const finalResults = await Promise.all(urls.map(async (url) => {
    const state = store.get(url);
    let agentReview = null;
    let transcriptFile = null;
    if (state?.jsonPath) {
      try {
        const item = JSON.parse(await fsp.readFile(state.jsonPath, "utf8"));
        agentReview = item.agent_review ?? null;
        transcriptFile = item.transcript_file ?? null;
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.warn(`[summary] failed to read agent review state from ${state.jsonPath}: ${error.message}`);
        }
      }
    }
    return {
      url,
      status: state?.status ?? "unknown",
      videoId: state?.videoId,
      title: state?.title,
      jsonPath: state?.jsonPath,
      videoFile: state?.videoFilePath ?? null,
      videoOutput: state?.videoOutput ?? false,
      cacheVideoFile: await getExistingCacheVideoPath(state),
      bytes: state?.bytes,
      hasTranscript: state?.hasTranscript ?? false,
      transcription: state?.transcription ?? null,
      transcriptFile,
      agentReview,
      lastError: state?.lastError,
      lastErrorCode: state?.lastErrorCode,
      lastErrorCategory: state?.lastErrorCategory,
      lastUserMessage: state?.lastUserMessage,
      retryable: state?.retryable,
      permanent: state?.permanent,
    };
  }));
  const reviewAggregate = buildInitialAgentReviewSummary(finalResults.map((result) => ({
    agentReview: result.agentReview,
    status: result.status,
    transcript_file: result.transcriptFile,
  })));
  const publicResults = finalResults.map(({ agentReview: _agentReview, ...result }) => result);

  return {
    runId,
    total: urls.length,
    completed: finalResults.filter((result) => result.status === "completed").length,
    withTranscript: finalResults.filter((result) => result.hasTranscript).length,
    transcriptionFailed: finalResults.filter((result) => result.status === "transcription_failed").length,
    failed: finalResults.filter((result) => result.status === "failed").length,
    permanentFailures: finalResults.filter((result) => result.status === "permanent_failure").length,
    outputDir: options.output,
    stateFile: store.file,
    videoOutput: options.videoOutput,
    videoPolicy: options.videoOutput ? "item" : "temp",
    accessMode,
    qualitySelectionVersion: QUALITY_SELECTION_VERSION,
    videosOutput: finalResults.filter((result) => result.videoOutput && result.videoFile).length,
    videosInCache: finalResults.filter((result) => result.cacheVideoFile).length,
    transcribe: options.transcribe !== false
      ? {
          requested: { model: options.model, device: options.device, compute_type: options.computeType },
          actual: finalResults
            .map((result) => result.transcription)
            .filter(Boolean),
        }
      : null,
    agentReview: reviewAggregate,
    platforms: platforms.map((ParserClass) => getPlatformId(ParserClass)),
    platformWarnings,
    results: publicResults,
  };
}

export async function runBatch(options) {
  if (options.clearTemp) {
    await fsp.mkdir(options.output, { recursive: true });
    const tempDir = await clearTempCache(options.output);
    const result = { status: "cleared", tempDir };
    console.log(JSON.stringify(result, null, 2));
    return { exitCode: 0, summary: result };
  }

  const inputText = await readInputText(options);
  const runId = randomUUID();
  const platformWarnings = [];
  const platforms = await loadPlatforms({
    disabledPlatforms: options.disabledPlatforms,
    onWarning: (message) => {
      platformWarnings.push(message);
      console.warn(`[platforms] ${message}`);
    },
  });
  console.error(
    `[platforms] loaded ${platforms.length}: ` +
    (platforms.map((ParserClass) => getPlatformId(ParserClass)).join(", ") || "none"),
  );

  const urlsWithParsers = await extractAndRouteUrls(inputText, { platforms });
  if (urlsWithParsers.length === 0) {
    console.error("No supported video URLs were found.");
    return { exitCode: 2, summary: null };
  }

  await fsp.mkdir(options.output, { recursive: true });
  const store = new StateStore(options.output);
  await store.load();

  const parseSemaphore = new Semaphore(options.parseConcurrency);
  const downloadSemaphore = new Semaphore(options.downloadConcurrency);
  const browserManager = new BrowserManager(options.headed);
  const transcriber = new TranscriptionClient(options);
  const accessMode = options.storageState ? "provided-storage-state" : "anonymous";
  const stopState = { stopping: false };
  const isStopping = () => stopState.stopping;

  const stop = async () => {
    if (stopState.stopping) return;
    stopState.stopping = true;
    console.error("\nStopping after current operations...");
    transcriber.terminate();
    abortActiveDownloads();
    terminateActiveMediaProcesses();
    await browserManager.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.error(
    `[batch] ${urlsWithParsers.length} unique URL(s), ` +
    `parse concurrency ${options.parseConcurrency}, ` +
    `download concurrency ${options.downloadConcurrency}, ` +
    `video output ${options.videoOutput ? "item folders" : ".temp cache only"}, ` +
    `transcribe ${options.transcribe !== false ? `on (serial, ${options.model}, ${options.device})` : "off"}, ` +
    `output ${options.output}`,
  );

  try {
    try {
      await runDownloadPhase({
        urlsWithParsers,
        options,
        store,
        browserManager,
        parseSemaphore,
        downloadSemaphore,
        accessMode,
        isStopping,
      });
    } finally {
      await browserManager.close();
      console.error("[phase 1] browser closed\n");
    }

    if (options.transcribe !== false) {
      await runTranscriptionPhase({
        urlsWithParsers,
        options,
        store,
        transcriber,
        isStopping,
      });
    } else {
      await finalizeWithoutTranscription({ urlsWithParsers, options, store });
    }

    const summary = await buildSummary({
      urlsWithParsers,
      options,
      store,
      accessMode,
      platforms,
      platformWarnings,
      runId,
    });
    await writeBatchSummary(options.output, summary);

    const hasFailures = summary.failed > 0 ||
      summary.permanentFailures > 0 ||
      summary.transcriptionFailed > 0;
    const exitCode = summary.completed === summary.total && !hasFailures ? 0 : 1;
    return { exitCode, summary };
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    transcriber.close();
    abortActiveDownloads();
    terminateActiveMediaProcesses();
    await browserManager.close();
  }
}

export async function runCli(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    usage();
    return { exitCode: 2, summary: null };
  }

  if (options.help) {
    usage();
    return { exitCode: 0, summary: null };
  }

  return await runBatch(options);
}
