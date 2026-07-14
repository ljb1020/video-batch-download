import fsp from "node:fs/promises";
import path from "node:path";

export function usage() {
  console.log(`
Usage:
  node scripts/download.mjs [options] "share text or URL" ...

Download options:
  --input <file>                 Read share text/URLs from a UTF-8 file
  --output <dir>                 Output directory (default: ./video_results)
  --parse-concurrency <n>        Concurrent browser parsers (default: 1)
  --download-concurrency <n>     Concurrent media downloads (default: 1)
  --max-attempts <n>             Attempts per item; 0 retries forever (default: 10)
  --page-timeout <seconds>       Page navigation timeout (default: 45)
  --media-wait <seconds>         Wait for media after navigation (default: 25)
  --download-timeout <seconds>   Total time allowed per transfer (default: 900)
  --no-video-output              Do not copy MP4 into item folders; keep it in .temp cache
  --clear-temp                   Delete the output .temp cache and exit
  --headed                       Show the browser for verification fallback
  --storage-state <file>         Optional Playwright storage-state JSON
  --disable-platform <id>        Disable a discovered platform plugin; repeatable

Transcription options:
  --no-transcribe                Skip Whisper transcription (download only)
  --model <name>                 Whisper model: small, medium, large-v3 (default: medium)
  --language <code>              Language hint, auto = detect (default: zh)
  --device <cpu|cuda>            Transcription device (default: cuda)
  --compute-type <type>          Precision: int8, float16, float32 (default: float16)
  --no-simplify                  Skip Traditional→Simplified Chinese conversion
  --ffmpeg-path <path>           Path to ffmpeg executable
  --transcribe-timeout <secs>    Timeout per transcription in seconds (default: 600)

Rerun with the same output directory to resume from download-state.json.
`);
}

export function parsePositiveInt(value, option, { allowZero = false } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${option} requires ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    input: null,
    output: path.resolve("video_results"),
    parseConcurrency: 1,
    downloadConcurrency: 1,
    maxAttempts: 10,
    pageTimeoutMs: 45_000,
    mediaWaitMs: 25_000,
    downloadTimeoutMs: 900_000,
    headed: false,
    storageState: null,
    videoOutput: true,
    clearTemp: false,
    // Transcription
    transcribe: true,
    model: "medium",
    language: "zh",
    device: "cuda",
    computeType: "float16",
    simplify: true,
    ffmpegPath: null,
    transcribeTimeoutMs: 600_000,
    disabledPlatforms: [],
    texts: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === "--input") options.input = path.resolve(next());
    else if (arg === "--output") options.output = path.resolve(next());
    else if (arg === "--parse-concurrency") options.parseConcurrency = parsePositiveInt(next(), arg);
    else if (arg === "--download-concurrency") options.downloadConcurrency = parsePositiveInt(next(), arg);
    else if (arg === "--max-attempts") options.maxAttempts = parsePositiveInt(next(), arg, { allowZero: true });
    else if (arg === "--page-timeout") options.pageTimeoutMs = parsePositiveInt(next(), arg) * 1_000;
    else if (arg === "--media-wait") options.mediaWaitMs = parsePositiveInt(next(), arg) * 1_000;
    else if (arg === "--download-timeout") options.downloadTimeoutMs = parsePositiveInt(next(), arg) * 1_000;
    else if (arg === "--no-video-output") options.videoOutput = false;
    else if (arg === "--clear-temp") options.clearTemp = true;
    else if (arg === "--storage-state") options.storageState = path.resolve(next());
    else if (arg === "--disable-platform") {
      options.disabledPlatforms.push(...next().split(",").map((value) => value.trim()).filter(Boolean));
    }
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--no-transcribe") options.transcribe = false;
    else if (arg === "--model") options.model = next();
    else if (arg === "--language") options.language = next();
    else if (arg === "--device") options.device = next();
    else if (arg === "--compute-type") options.computeType = next();
    else if (arg === "--no-simplify") options.simplify = false;
    else if (arg === "--ffmpeg-path") options.ffmpegPath = path.resolve(next());
    else if (arg === "--transcribe-timeout") options.transcribeTimeoutMs = parsePositiveInt(next(), arg) * 1_000;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else options.texts.push(arg);
  }
  return options;
}

export async function readInputText(options) {
  let inputText = options.texts.join("\n");
  if (options.input) inputText += `\n${await fsp.readFile(options.input, "utf8")}`;
  return inputText.replace(/^﻿/, ""); // strip UTF-8 BOM
}
