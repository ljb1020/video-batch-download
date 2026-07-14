import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "scripts", "download.mjs");

function runEntry(args) {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("download entry preserves help and option validation exit codes", () => {
  const help = runEntry(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);

  const invalid = runEntry(["--not-a-real-option"]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Unknown option/);
  assert.match(invalid.stdout, /Usage:/);
});

test("download entry clears only the requested temporary cache", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-download-entry-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const tempDir = path.join(outputDir, ".temp");
  const itemDir = path.join(outputDir, "existing-result");
  await mkdir(tempDir);
  await mkdir(itemDir);
  await writeFile(path.join(tempDir, "cached.mp4"), "cache");
  await writeFile(path.join(itemDir, "result.json"), "{}");

  const result = runEntry(["--clear-temp", "--output", outputDir]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"status": "cleared"/);
  await assert.rejects(() => access(tempDir));
  await access(itemDir);
});
