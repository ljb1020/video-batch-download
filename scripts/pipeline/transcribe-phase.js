import fsp from "node:fs/promises";

import {
  getCacheVideoPath,
  getPendingTranscriptions,
  getReusableVideoPath,
} from "../core/resume.js";
import { extractAudio } from "../media/ffmpeg.js";
import { writeOutputsWithMediaInfo } from "../output/writer.js";

async function writeCompletedItem({ url, state, transcribeResult, errorMessage, options, store }) {
  const cacheVideoPath = getCacheVideoPath(state);
  const {
    jsonPath,
    videoFilePath,
    videoOutput,
    cacheVideoPath: outputCacheVideoPath,
  } = await writeOutputsWithMediaInfo(
    state.parsed,
    transcribeResult,
    { filePath: cacheVideoPath, bytes: state.bytes },
    options.output,
    options,
  );

  await store.update(url, {
    status: "completed",
    jsonPath,
    hasTranscript: Boolean(transcribeResult?.transcript),
    videoFilePath,
    videoOutput,
    cacheVideoPath: outputCacheVideoPath,
    lastError: errorMessage,
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
      const jsonPath = await writeCompletedItem({
        url,
        state,
        transcribeResult: null,
        errorMessage: null,
        options,
        store,
      });
      console.error(`  completed: ${jsonPath}`);
    } catch (error) {
      console.warn(`  failed to write output for ${url}: ${error.message}`);
      await store.update(url, { status: "failed", lastError: error.message });
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
}) {
  const downloaded = await collectDownloadedItems(urlsWithParsers, store);
  const pending = await getPendingTranscriptions(downloaded);

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
    console.error(`[phase 2] failed to start transcribe server: ${error.message}`);
    for (const { url, state } of pending) {
      try {
        const jsonPath = await writeCompletedItem({
          url,
          state,
          transcribeResult: null,
          errorMessage: "Transcription server failed to start",
          options,
          store,
        });
        console.error(`  completed without transcript: ${jsonPath}`);
      } catch (writeError) {
        await store.update(url, { status: "failed", lastError: writeError.message });
      }
    }
    return;
  }

  try {
    for (let index = 0; index < pending.length; index += 1) {
      if (isStopping()) break;
      const { url, state } = pending[index];
      const label = `[${index + 1}/${pending.length}]`;
      const cacheVideoPath = getCacheVideoPath(state);
      let wavPath = null;

      try {
        if (!transcriber.isRunning()) await transcriber.start();
        await store.update(url, { status: "transcribing" });
        console.error(`${label} extracting audio...`);
        wavPath = await extractAudio(cacheVideoPath, options.ffmpegPath);
        console.error(`${label} transcribing (${options.model}, ${options.device})...`);

        const transcribeResult = await transcriber.transcribe(wavPath);
        const jsonPath = await writeCompletedItem({
          url,
          state,
          transcribeResult,
          errorMessage: null,
          options,
          store,
        });
        console.error(`${label} complete (${state.bytes} bytes, transcribed): ${jsonPath}`);
      } catch (error) {
        console.warn(`${label} transcribe failed: ${error.message}`);
        try {
          const jsonPath = await writeCompletedItem({
            url,
            state,
            transcribeResult: null,
            errorMessage: error.message,
            options,
            store,
          });
          console.error(`${label} completed without transcript: ${jsonPath}`);
        } catch (writeError) {
          await store.update(url, { status: "failed", lastError: writeError.message });
        }
      } finally {
        if (wavPath) await fsp.rm(wavPath, { force: true }).catch(() => {});
      }
    }
  } finally {
    transcriber.close();
  }
}
