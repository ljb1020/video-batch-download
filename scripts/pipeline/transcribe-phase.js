import fsp from "node:fs/promises";

import {
  ProcessingError,
  buildErrorStatePatch,
  clearErrorStatePatch,
  normalizeError,
  normalizeTranscriptionError,
} from "../core/errors.js";
import {
  getCacheVideoPath,
  getPendingTranscriptions,
  getReusableVideoPath,
} from "../core/resume.js";
import { extractAudio } from "../media/ffmpeg.js";
import { writeOutputsWithMediaInfo } from "../output/writer.js";
import { retryDelay, sleep } from "../utils/common.js";

const DEFAULT_TRANSCRIBE_ATTEMPTS = 2;

function terminalTranscriptionError(error) {
  if (!error?.retryable) return error;
  // Return a new instance so exhausted retries do not mutate the original error object.
  return new ProcessingError(error.message, {
    code: error.code,
    category: error.category,
    stage: error.stage,
    permanent: error.permanent,
    retryable: false,
    retryScope: "none",
    userMessage: error.userMessage,
    suggestion: error.suggestion,
    details: error.details,
    candidateFailures: error.candidateFailures,
    cause: error,
  });
}

export async function writeOutputItem({
  url,
  state,
  transcribeResult,
  errorMessage,
  errorInfo = null,
  status = "completed",
  runtimeConfig = null,
  options,
  store,
  writeOutputs = writeOutputsWithMediaInfo,
}) {
  const cacheVideoPath = getCacheVideoPath(state);
  const normalizedError = errorInfo
    ? normalizeError(errorInfo, { stage: errorInfo.stage ?? "transcribe" })
    : errorMessage
      ? normalizeTranscriptionError(new Error(errorMessage), { phase: "runtime" })
      : null;
  const errorPatch = normalizedError ? buildErrorStatePatch(normalizedError) : clearErrorStatePatch();
  const {
    jsonPath,
    videoFilePath,
    videoOutput,
    cacheVideoPath: outputCacheVideoPath,
  } = await writeOutputs(
    state.parsed,
    transcribeResult,
    { filePath: cacheVideoPath, bytes: state.bytes },
    options.output,
    {
      ...options,
      processingStatus: status === "completed" ? "success" : status,
      // Keep transcription_error as the technical message; user-facing copy lives in user_message.
      transcriptionError: normalizedError?.message ?? errorMessage,
      transcriptionErrorInfo: normalizedError,
      transcriptionRuntime: runtimeConfig,
    },
  );

  await store.update(url, {
    status,
    jsonPath,
    hasTranscript: Boolean(transcribeResult?.transcript),
    transcriptionCompleted: Boolean(transcribeResult),
    transcription: transcribeResult?.meta ?? runtimeConfig,
    videoFilePath,
    videoOutput,
    cacheVideoPath: outputCacheVideoPath,
    ...errorPatch,
  });

  return jsonPath;
}

export async function finalizeWithoutTranscription({ urlsWithParsers, options, store }) {
  const downloaded = urlsWithParsers
    .map(({ url }) => ({ url, state: store.get(url) }))
    .filter((item) => item.state?.status === "downloaded" && getCacheVideoPath(item.state) && item.state?.parsed);

  if (downloaded.length === 0) return;

  console.error(`[phase 1.5] writing outputs for ${downloaded.length} video(s) (transcription skipped)...`);
  for (const { url, state } of downloaded) {
    try {
      const jsonPath = await writeOutputItem({
        url,
        state,
        transcribeResult: null,
        errorMessage: null,
        options,
        store,
      });
      console.error(`  completed: ${jsonPath}`);
    } catch (error) {
      const normalized = normalizeError(error, { stage: "output", category: "output", retryable: false });
      console.warn(`  failed to write output for ${url}: ${normalized.message}`);
      await store.update(url, { status: "failed", ...buildErrorStatePatch(normalized) });
    }
  }
}

async function collectDownloadedItems(urlsWithParsers, store) {
  const downloaded = [];
  for (const { url } of urlsWithParsers) {
    const state = store.get(url);
    if (state?.status !== "downloaded" || !state?.parsed) continue;
    const reusableVideoPath = await getReusableVideoPath(state);
    if (!reusableVideoPath) continue;
    downloaded.push({
      url,
      state: { ...state, cacheVideoPath: reusableVideoPath, filePath: reusableVideoPath },
    });
  }
  return downloaded;
}

export async function runTranscriptionPhase({
  urlsWithParsers,
  options,
  store,
  transcriber,
  isStopping,
  deps = {},
}) {
  const {
    extractAudio: extractAudioImpl = extractAudio,
    sleep: sleepImpl = sleep,
    retryDelay: retryDelayImpl = retryDelay,
    writeOutputItem: writeOutputItemImpl = writeOutputItem,
    collectDownloadedItems: collectDownloadedItemsImpl = collectDownloadedItems,
    getPendingTranscriptions: getPendingTranscriptionsImpl = getPendingTranscriptions,
  } = deps;
  const downloaded = await collectDownloadedItemsImpl(urlsWithParsers, store);
  const pending = await getPendingTranscriptionsImpl(downloaded);

  if (pending.length === 0) {
    console.error("[phase 2] nothing to transcribe");
    return;
  }

  const skipped = downloaded.length - pending.length;
  console.error(
    `[phase 2] transcribing ${pending.length} video(s)` +
    (skipped > 0 ? ` (${skipped} already transcribed)` : "") +
    "...",
  );

  try {
    await transcriber.start();
  } catch (error) {
    const normalized = normalizeTranscriptionError(error, { phase: "start", isStopping: isStopping() });
    console.error(`[phase 2] failed to start transcribe server: ${normalized.userMessage ?? normalized.message}`);
    for (const { url, state } of pending) {
      try {
        const jsonPath = await writeOutputItemImpl({
          url,
          state,
          transcribeResult: null,
          errorMessage: normalized.message,
          errorInfo: normalized,
          status: "transcription_failed",
          runtimeConfig: transcriber.getRuntimeConfig?.() ?? null,
          options,
          store,
        });
        console.error(`  transcription failed; video and metadata preserved: ${jsonPath}`);
      } catch (writeError) {
        const writeFailure = normalizeError(writeError, { stage: "output", category: "output", retryable: false });
        await store.update(url, { status: "failed", ...buildErrorStatePatch(writeFailure) });
      }
    }
    return;
  }

  const configuredAttempts = options.transcribeAttempts
    ?? (options.maxAttempts > 0 ? options.maxAttempts : DEFAULT_TRANSCRIBE_ATTEMPTS);
  const maxTranscribeAttempts = Math.max(1, Number(configuredAttempts) || DEFAULT_TRANSCRIBE_ATTEMPTS);

  try {
    for (let index = 0; index < pending.length; index += 1) {
      if (isStopping()) break;
      const { url, state } = pending[index];
      const label = `[${index + 1}/${pending.length}]`;
      const cacheVideoPath = getCacheVideoPath(state);
      let wavPath = null;
      let failurePhase = "runtime";
      let lastError = null;

      try {
        if (!transcriber.isRunning()) await transcriber.start();
        await store.update(url, { status: "transcribing", ...clearErrorStatePatch() });
        console.error(`${label} extracting audio...`);
        failurePhase = "audio_extract";
        wavPath = await extractAudioImpl(cacheVideoPath, options.ffmpegPath);

        for (let attempt = 1; attempt <= maxTranscribeAttempts; attempt += 1) {
          if (isStopping()) {
            lastError = normalizeTranscriptionError(new Error("Interrupted"), {
              phase: "runtime",
              isStopping: true,
            });
            break;
          }

          failurePhase = "runtime";
          const runtime = transcriber.getRuntimeConfig?.() ?? options;
          console.error(
            `${label} transcribing attempt ${attempt}/${maxTranscribeAttempts} ` +
            `(${runtime.model}, ${runtime.device}/${runtime.compute_type ?? runtime.computeType})...`,
          );

          try {
            const transcribeResult = await transcriber.transcribe(wavPath);
            const jsonPath = await writeOutputItemImpl({
              url,
              state,
              transcribeResult,
              errorMessage: null,
              options,
              store,
            });
            console.error(`${label} complete (${state.bytes} bytes, transcribed): ${jsonPath}`);
            lastError = null;
            break;
          } catch (error) {
            const normalized = normalizeTranscriptionError(error, {
              phase: failurePhase,
              isStopping: isStopping(),
            });
            lastError = normalized;
            const canRetry = normalized.retryable
              && !normalized.permanent
              && attempt < maxTranscribeAttempts
              && !isStopping();
            if (!canRetry) break;
            console.warn(
              `${label} transcribe attempt ${attempt} failed, retrying: ` +
              `${normalized.userMessage ?? normalized.message}`,
            );
            await store.update(url, { status: "transcribing", attempt, ...buildErrorStatePatch(normalized) });
            await sleepImpl(retryDelayImpl(attempt));
          }
        }

        if (lastError) {
          const terminal = terminalTranscriptionError(lastError);
          console.warn(`${label} transcribe failed: ${terminal.userMessage ?? terminal.message}`);
          try {
            const jsonPath = await writeOutputItemImpl({
              url,
              state,
              transcribeResult: null,
              errorMessage: terminal.message,
              errorInfo: terminal,
              status: "transcription_failed",
              runtimeConfig: transcriber.getRuntimeConfig?.() ?? null,
              options,
              store,
            });
            console.error(`${label} transcription failed; video and metadata preserved: ${jsonPath}`);
          } catch (writeError) {
            const writeFailure = normalizeError(writeError, { stage: "output", category: "output", retryable: false });
            await store.update(url, { status: "failed", ...buildErrorStatePatch(writeFailure) });
          }
        }
      } catch (error) {
        const normalized = terminalTranscriptionError(
          normalizeTranscriptionError(error, { phase: failurePhase, isStopping: isStopping() }),
        );
        console.warn(`${label} transcribe failed: ${normalized.userMessage ?? normalized.message}`);
        try {
          const jsonPath = await writeOutputItemImpl({
            url,
            state,
            transcribeResult: null,
            errorMessage: normalized.message,
            errorInfo: normalized,
            status: "transcription_failed",
            runtimeConfig: transcriber.getRuntimeConfig?.() ?? null,
            options,
            store,
          });
          console.error(`${label} transcription failed; video and metadata preserved: ${jsonPath}`);
        } catch (writeError) {
          const writeFailure = normalizeError(writeError, { stage: "output", category: "output", retryable: false });
          await store.update(url, { status: "failed", ...buildErrorStatePatch(writeFailure) });
        }
      } finally {
        if (wavPath) await fsp.rm(wavPath, { force: true }).catch(() => {});
      }
    }
  } finally {
    transcriber.close();
  }
}
