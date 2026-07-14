import path from "node:path";

import { downloadMedia } from "../media/downloader.js";
import { ensureFfmpegAvailable } from "../media/ffmpeg.js";
import { validateParsedVideo } from "../platforms/base.js";
import { getPlatformId } from "../platforms/router.js";
import { QUALITY_SELECTION_VERSION } from "../core/policies.js";
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
}) {
  const { url, ParserClass } = item;
  const label = `[${index + 1}/${total}]`;
  const stored = store.get(url);
  const previous = stored?.selectionVersion === QUALITY_SELECTION_VERSION && stored?.accessMode === accessMode
    ? stored
    : null;

  if (stored && !previous) {
    console.error(`${label} cached result uses a different access mode or quality selector; reparsing for best available quality`);
  }

  if (await hasReusableJsonOutput(previous)) {
    const transcriptOk = !options.transcribe || await hasReusableTranscriptOutput(previous);
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
    await store.update(url, {
      status: "downloaded",
      filePath: cacheVideoPath,
      cacheVideoPath,
      lastError: null,
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

  let attempt = 0;
  while (!isStopping() && (options.maxAttempts === 0 || attempt < options.maxAttempts)) {
    attempt += 1;
    await store.update(url, {
      status: "parsing",
      attempt,
      lastError: null,
      selectionVersion: QUALITY_SELECTION_VERSION,
      accessMode,
    });
    console.error(`${label} parse attempt ${attempt}${options.maxAttempts ? `/${options.maxAttempts}` : ""}: ${url}`);

    try {
      ensureFfmpegAvailable(options.ffmpegPath);
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
        downloadMedia(parsed, options.output, options.downloadTimeoutMs, options.ffmpegPath)
      );

      await store.update(url, {
        status: "downloaded",
        attempt,
        filePath: downloaded.filePath,
        cacheVideoPath: downloaded.filePath,
        bytes: downloaded.bytes,
        parsed,
        selectedAlternativeIndex: downloaded.alternativeIndex,
        candidateFailures: downloaded.fallbackFailures,
        selectionVersion: QUALITY_SELECTION_VERSION,
        accessMode,
        lastError: null,
      });

      console.error(`${label} downloaded (${downloaded.bytes} bytes)`);
      return {
        url,
        status: "downloaded",
        filePath: downloaded.filePath,
        bytes: downloaded.bytes,
      };
    } catch (error) {
      const permanent = Boolean(error.permanent);
      const status = permanent ? "permanent_failure" : "retrying";
      await store.update(url, { status, attempt, lastError: error.message });
      console.warn(`${label} ${status}: ${error.message}`);

      if (permanent) {
        writeFailedOutput(url, error.message, "permanent", options.output, ParserClass.getPlatformName());
        return { url, status, attempt, error: error.message };
      }

      if (options.maxAttempts !== 0 && attempt >= options.maxAttempts) break;
      await sleep(retryDelay(attempt));
    }
  }

  const lastError = store.get(url)?.lastError ?? (isStopping() ? "Interrupted" : "Attempts exhausted");
  await store.update(url, { status: "failed", attempt, lastError });
  writeFailedOutput(url, lastError, "exhausted", options.output, ParserClass.getPlatformName());
  return { url, status: "failed", attempt, error: lastError };
}

export async function runDownloadPhase(context) {
  const { urlsWithParsers, options } = context;
  console.error(`\n[phase 1] downloading ${urlsWithParsers.length} video(s)...`);

  return await Promise.all(
    urlsWithParsers.map((item, index) =>
      processDownloadItem({
        ...context,
        item,
        index,
        total: urlsWithParsers.length,
      }).catch((error) => {
        console.error(`[${index + 1}/${urlsWithParsers.length}] unexpected error: ${error.message}`);
        writeFailedOutput(
          item.url,
          error.message,
          "unexpected",
          options.output,
          item.ParserClass.getPlatformName(),
        );
        return { url: item.url, status: "failed", error: error.message };
      })
    ),
  );
}
