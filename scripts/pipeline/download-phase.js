import path from "node:path";

import {
  ProcessingError,
  buildErrorStatePatch,
  buildFailureOutputMetadata,
  clearErrorStatePatch,
  normalizeError,
  operationInterruptedError,
} from "../core/errors.js";
import { QUALITY_SELECTION_VERSION } from "../core/policies.js";
import { downloadMedia } from "../media/downloader.js";
import { ensureFfmpegAvailable, getMediaTracks } from "../media/ffmpeg.js";
import { validateParsedVideo } from "../platforms/base.js";
import { getPlatformId } from "../platforms/router.js";
import {
  getReusableVideoPath,
  hasReusableCacheVideo,
  hasReusableJsonOutput,
  hasReusableTranscriptOutput,
  hasReusableVideoOutput,
} from "../core/resume.js";
import {
  materializeVideoArtifact,
  patchJsonVideoArtifact,
  writeFailedOutput,
} from "../output/writer.js";
import { retryDelay, sleep } from "../utils/common.js";

function failureTypeFor(error, fallback = "unexpected") {
  if (error.permanent) return "permanent";
  if (!error.retryable) return "non_retryable";
  return fallback;
}

function writeFailureReport(writeFailedOutputImpl, url, error, errorType, options, ParserClass, attempt) {
  return writeFailedOutputImpl(
    url,
    error.userMessage || error.message,
    errorType,
    options.output,
    ParserClass.getPlatformName(),
    buildFailureOutputMetadata(error, { attempts: attempt, errorType }),
  );
}

async function restoreMissingVideoOutput(previous, options, store, url) {
  const jsonPath = previous.jsonPath;
  const itemDir = path.dirname(jsonPath);
  const base = path.basename(jsonPath, ".json");
  const artifact = await materializeVideoArtifact(
    { filePath: await getReusableVideoPath(previous), bytes: previous.bytes },
    itemDir,
    base,
    options,
  );

  await patchJsonVideoArtifact(jsonPath, artifact);
  await store.update(url, {
    videoFilePath: artifact.videoFilePath,
    cacheVideoPath: artifact.cacheVideoPath,
    videoOutput: artifact.videoOutput,
  });
  Object.assign(previous, artifact);
  return Boolean(artifact.videoFilePath);
}

export async function processDownloadItem({
  item,
  index,
  total,
  options,
  store,
  browserManager,
  parseSemaphore,
  downloadSemaphore,
  accessMode,
  isStopping,
  deps = {},
}) {
  const {
    downloadMedia: downloadMediaImpl = downloadMedia,
    ensureFfmpegAvailable: ensureFfmpegAvailableImpl = ensureFfmpegAvailable,
    retryDelay: retryDelayImpl = retryDelay,
    sleep: sleepImpl = sleep,
    writeFailedOutput: writeFailedOutputImpl = writeFailedOutput,
  } = deps;
  const { url, ParserClass } = item;
  const label = `[${index + 1}/${total}]`;
  const stored = store.get(url);
  const previous = stored?.selectionVersion === QUALITY_SELECTION_VERSION && stored?.accessMode === accessMode
    ? stored
    : null;

  if (stored && !previous) {
    console.error(`${label} cached result uses a different access mode or quality selector; reparsing for best available quality`);
  }

  // Keep download/resume audio gating aligned: default (undefined) still requires audio.
  const requireAudio = options.transcribe !== false;

  if (await hasReusableJsonOutput(previous)) {
    const transcriptOk = !requireAudio || await hasReusableTranscriptOutput(previous);
    let videoOk = !options.videoOutput || await hasReusableVideoOutput(previous);

    if (!videoOk && options.videoOutput && await hasReusableCacheVideo(previous)) {
      videoOk = await restoreMissingVideoOutput(previous, options, store, url);
    }

    if (transcriptOk && videoOk) {
      console.error(`${label} already complete: ${previous.jsonPath}`);
      return {
        url,
        status: "completed",
        filePath: await getReusableVideoPath(previous),
        videoFilePath: previous.videoFilePath,
        bytes: previous.bytes,
        resumed: true,
      };
    }
  }

  if (previous?.parsed && await hasReusableCacheVideo(previous)) {
    const cacheVideoPath = await getReusableVideoPath(previous);
    let cacheUsable = true;
    if (requireAudio) {
      if (previous.mediaHasAudio === false) {
        cacheUsable = false;
      } else if (previous.mediaHasAudio === true) {
        cacheUsable = true;
      } else {
        // null / undefined / legacy entries: resume must re-probe.
        const tracks = await getMediaTracks(cacheVideoPath, options.ffmpegPath);
        cacheUsable = !tracks || tracks.audio;
        if (tracks) {
          await store.update(url, { mediaHasAudio: Boolean(tracks.audio) });
        }
      }
    }
    if (cacheUsable) {
      await store.update(url, {
        status: "downloaded",
        filePath: cacheVideoPath,
        cacheVideoPath,
        ...clearErrorStatePatch(),
      });
      console.error(`${label} using cached video: ${cacheVideoPath}`);
      return {
        url,
        status: "downloaded",
        filePath: cacheVideoPath,
        bytes: previous.bytes,
        resumed: true,
      };
    }
    console.error(`${label} cached video has no audio track; reparsing for transcribable media`);
  }

  let attempt = 0;
  while (!isStopping() && (options.maxAttempts === 0 || attempt < options.maxAttempts)) {
    attempt += 1;
    await store.update(url, {
      status: "parsing",
      attempt,
      ...clearErrorStatePatch(),
      selectionVersion: QUALITY_SELECTION_VERSION,
      accessMode,
    });
    console.error(`${label} parse attempt ${attempt}${options.maxAttempts ? `/${options.maxAttempts}` : ""}: ${url}`);

    try {
      if (attempt === 1) ensureFfmpegAvailableImpl(options.ffmpegPath);
      const parser = new ParserClass();
      const parsed = validateParsedVideo(
        await parseSemaphore.use(() => parser.parse(browserManager, url, options)),
        getPlatformId(ParserClass),
      );
      parsed.accessMode = accessMode;

      await store.update(url, {
        status: "downloading",
        attempt,
        videoId: parsed.videoId,
        title: parsed.title,
        finalUrl: parsed.canonicalUrl,
      });

      const downloaded = await downloadSemaphore.use(() =>
        downloadMediaImpl(parsed, options.output, options.downloadTimeoutMs, options.ffmpegPath, {
          requireAudio,
        })
      );

      await store.update(url, {
        status: "downloaded",
        attempt,
        filePath: downloaded.filePath,
        cacheVideoPath: downloaded.filePath,
        bytes: downloaded.bytes,
        parsed,
        selectedAlternativeIndex: downloaded.alternativeIndex,
        selectionVersion: QUALITY_SELECTION_VERSION,
        accessMode,
        // Only conclusive probes write true/false; inconclusive stays null so resume re-probes.
        mediaHasAudio: requireAudio ? (downloaded.mediaHasAudio ?? null) : null,
        ...clearErrorStatePatch(),
        candidateFailures: downloaded.fallbackFailures,
      });

      console.error(`${label} downloaded (${downloaded.bytes} bytes)`);
      return {
        url,
        status: "downloaded",
        filePath: downloaded.filePath,
        bytes: downloaded.bytes,
      };
    } catch (error) {
      const stopping = isStopping();
      const normalized = stopping
        ? operationInterruptedError(error?.message ?? "Interrupted", {
            details: { originalError: error?.message ?? String(error ?? "Unknown error") },
          })
        : normalizeError(error, { stage: "download" });
      const exhausted = options.maxAttempts !== 0 && attempt >= options.maxAttempts;
      const shouldRetry = normalized.retryable && !normalized.permanent && !exhausted && !stopping;
      const status = normalized.permanent
        ? "permanent_failure"
        : shouldRetry ? "retrying" : "failed";
      await store.update(url, {
        status,
        attempt,
        ...buildErrorStatePatch(normalized),
      });
      console.warn(`${label} ${status}: ${normalized.userMessage || normalized.message}`);

      if (!shouldRetry) {
        const errorType = failureTypeFor(normalized, stopping ? "interrupted" : exhausted ? "exhausted" : "non_retryable");
        const jsonPath = writeFailureReport(
          writeFailedOutputImpl,
          url,
          normalized,
          errorType,
          options,
          ParserClass,
          attempt,
        );
        await store.update(url, { status, jsonPath });
        return { url, status, attempt, error: normalized.message, errorCode: normalized.code, jsonPath };
      }

      await sleepImpl(retryDelayImpl(attempt));
    }
  }

  const interrupted = isStopping();
  const fallbackError = interrupted
    ? operationInterruptedError()
    : new ProcessingError("Attempts exhausted", {
      code: "UNEXPECTED_ERROR",
      category: "internal",
      stage: "download",
      retryable: false,
      retryScope: "none",
      userMessage: "尝试次数已耗尽。",
    });
  const errorType = interrupted ? "interrupted" : "exhausted";
  const jsonPath = writeFailureReport(
    writeFailedOutputImpl,
    url,
    fallbackError,
    errorType,
    options,
    ParserClass,
    attempt,
  );
  await store.update(url, { status: "failed", attempt, jsonPath, ...buildErrorStatePatch(fallbackError) });
  return { url, status: "failed", attempt, error: fallbackError.message, errorCode: fallbackError.code, jsonPath };
}

export async function runDownloadPhase(context) {
  const { urlsWithParsers, options, store } = context;
  console.error(`\n[phase 1] downloading ${urlsWithParsers.length} video(s)...`);

  // One process-level preflight; per-item ensureFfmpegAvailable is memoized as a backup.
  try {
    ensureFfmpegAvailable(options.ffmpegPath);
  } catch (error) {
    const normalized = normalizeError(error, { stage: "preflight" });
    console.error(`[phase 1] preflight failed: ${normalized.userMessage ?? normalized.message}`);
  }

  return await Promise.all(
    urlsWithParsers.map((item, index) =>
      processDownloadItem({
        ...context,
        item,
        index,
        total: urlsWithParsers.length,
      }).catch(async (error) => {
        const normalized = normalizeError(error, { stage: "download", category: "internal", retryable: false });
        console.error(
          `[${index + 1}/${urlsWithParsers.length}] unexpected error: ` +
          `${normalized.userMessage ?? normalized.message}`,
        );
        const jsonPath = writeFailureReport(
          writeFailedOutput,
          item.url,
          normalized,
          "unexpected",
          options,
          item.ParserClass,
          store?.get?.(item.url)?.attempt ?? null,
        );
        if (store?.update) {
          await store.update(item.url, {
            status: "failed",
            jsonPath,
            ...buildErrorStatePatch(normalized),
          });
        }
        return {
          url: item.url,
          status: "failed",
          error: normalized.message,
          errorCode: normalized.code,
          jsonPath,
        };
      })
    ),
  );
}
