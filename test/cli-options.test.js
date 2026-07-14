import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs, parsePositiveInt, readInputText } from "../scripts/cli/options.js";

test("parseArgs preserves download and transcription defaults", () => {
  const options = parseArgs([]);

  assert.equal(options.output, path.resolve("video_results"));
  assert.equal(options.parseConcurrency, 1);
  assert.equal(options.downloadConcurrency, 1);
  assert.equal(options.maxAttempts, 10);
  assert.equal(options.transcribe, true);
  assert.equal(options.model, "medium");
  assert.equal(options.device, "cuda");
  assert.equal(options.videoOutput, true);
  assert.deepEqual(options.disabledPlatforms, []);
  assert.deepEqual(options.texts, []);
});

test("parseArgs converts durations, repeatable platform values, and positional text", () => {
  const options = parseArgs([
    "--page-timeout", "12",
    "--media-wait", "4",
    "--download-timeout", "90",
    "--transcribe-timeout", "30",
    "--max-attempts", "0",
    "--disable-platform", "weibo,kuaishou",
    "--disable-platform", "douyin",
    "--no-video-output",
    "--no-transcribe",
    "share text",
  ]);

  assert.equal(options.pageTimeoutMs, 12_000);
  assert.equal(options.mediaWaitMs, 4_000);
  assert.equal(options.downloadTimeoutMs, 90_000);
  assert.equal(options.transcribeTimeoutMs, 30_000);
  assert.equal(options.maxAttempts, 0);
  assert.deepEqual(options.disabledPlatforms, ["weibo", "kuaishou", "douyin"]);
  assert.equal(options.videoOutput, false);
  assert.equal(options.transcribe, false);
  assert.deepEqual(options.texts, ["share text"]);
});

test("parsePositiveInt and parseArgs preserve validation messages", () => {
  assert.throws(() => parsePositiveInt("0", "--jobs"), {
    message: "--jobs requires a positive integer",
  });
  assert.throws(() => parsePositiveInt("-1", "--jobs", { allowZero: true }), {
    message: "--jobs requires a non-negative integer",
  });
  assert.throws(() => parseArgs(["--unknown"]), { message: "Unknown option: --unknown" });
  assert.throws(() => parseArgs(["--input"]), { message: "--input requires a value" });
});

test("readInputText combines positional and UTF-8 file input", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "video-cli-options-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "input.txt");
  await fsp.writeFile(input, "https://file.example/video", "utf8");

  assert.equal(
    await readInputText({ texts: ["https://arg.example/video"], input }),
    "https://arg.example/video\nhttps://file.example/video",
  );
});
