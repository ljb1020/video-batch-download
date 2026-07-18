import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgentReviewCli } from "../scripts/agent-review.mjs";
import {
  buildInitialAgentReviewSummary,
  calculateContextBudget,
  checkpointReview,
  claimReview,
  completeReview,
  createInitialAgentReview,
  estimateTranscriptTokens,
  failReview,
  finalizeSummary,
  normalizeTranscriptText,
  packReviewItems,
  pauseReview,
  planReview,
  reconcileSummary,
  sha256File,
  sha256Text,
} from "../scripts/review/coordinator.js";
import {
  recoverAtomicFile,
  replaceFileRecoverably,
  withFileLock,
  writeJsonAtomic,
} from "../scripts/review/atomic-files.js";

async function createFixture(t, options = {}) {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-review-"));
  t.after(() => fsp.rm(outputDir, { recursive: true, force: true }));
  const itemDir = path.join(outputDir, "item");
  await fsp.mkdir(itemDir);
  const transcript = options.transcript ?? "第一行\nsecond line\n";
  const txtPath = path.join(itemDir, "item_transcript.txt");
  const jsonPath = path.join(itemDir, "item.json");
  if (options.hasTxt !== false) await fsp.writeFile(txtPath, options.txtContent ?? transcript, "utf8");
  const item = {
    status: options.status ?? "success",
    source_url: "https://example.test/video",
    transcript: options.itemTranscript === undefined ? transcript : options.itemTranscript,
    segments: options.segments ?? [{ text: "第一行" }, { text: "second line" }],
    transcript_file: options.hasTxt === false ? null : txtPath,
    transcription: options.transcription === undefined ? { model: "small" } : options.transcription,
  };
  if (options.agentReview) item.agent_review = options.agentReview;
  await fsp.writeFile(jsonPath, `${JSON.stringify(item, null, 2)}\n`, "utf8");
  const historicalPath = path.join(outputDir, "historical.json");
  await fsp.writeFile(historicalPath, JSON.stringify({ untouched: true }), "utf8");
  const summaryPath = path.join(outputDir, "download-summary.json");
  await fsp.writeFile(summaryPath, `${JSON.stringify({
    runId: options.runId ?? "run-test",
    marker: "preserve-me",
    transcribe: options.transcribe === undefined ? { requested: {} } : options.transcribe,
    results: [{ url: item.source_url, jsonPath }],
  }, null, 2)}\n`, "utf8");
  return { outputDir, itemDir, transcript, txtPath, jsonPath, historicalPath, summaryPath, item };
}

function captureStream() {
  let value = "";
  return { write: (chunk) => { value += chunk; }, get value() { return value; } };
}

test("text normalization, hashes, token estimates and initial schema are deterministic", () => {
  assert.equal(normalizeTranscriptText("\uFEFF甲\r\nA\rB"), "甲\nA\nB");
  assert.equal(sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(estimateTranscriptTokens("中文abcd"), 3);

  const review = createInitialAgentReview({ transcript: "中文abcd", txtContent: "中文abcd\n", required: true });
  assert.equal(review.schema_version, 2);
  assert.equal(review.status, "pending");
  assert.equal(review.required, true);
  assert.equal(review.estimated_transcript_tokens, 3);
  assert.equal(review.source_txt_sha256, sha256Text("中文abcd\n"));

  const notRequired = createInitialAgentReview({ transcript: "", txtContent: null, required: false, reason: "no_speech" });
  const aggregate = buildInitialAgentReviewSummary([{ agent_review: review }, { agent_review: notRequired }]);
  assert.equal(aggregate.pending, 1);
  assert.equal(aggregate.notRequired, 1);
  assert.equal(aggregate.status, "pending");
});

test("dynamic budgets and largest-first packing honor hard limits and oversized files", () => {
  assert.deepEqual(calculateContextBudget({ contextWindow: 200_000, contextUsed: 20_000 }), {
    targetTokens: 72_000,
    hardLimitTokens: 90_000,
    source: "dynamic",
    remainingContextTokens: 180_000,
  });
  assert.deepEqual(calculateContextBudget(), {
    targetTokens: 40_000,
    hardLimitTokens: 60_000,
    source: "default",
  });
  const buckets = packReviewItems([
    { jsonPath: "large", estimatedTokens: 70 },
    { jsonPath: "medium", estimatedTokens: 40 },
    { jsonPath: "small", estimatedTokens: 30 },
    { jsonPath: "oversized", estimatedTokens: 120 },
  ], 100);
  assert.deepEqual(buckets.map((bucket) => bucket.estimatedTokens), [120, 70, 70]);
  assert.equal(buckets[0].oversized, true);
  assert.deepEqual(buckets[1].items.map((item) => item.jsonPath), ["large"]);
});

test("reconcile scopes itself to summary results and plan is read-only", async (t) => {
  const fixture = await createFixture(t);
  const reconciled = await reconcileSummary(fixture.summaryPath);
  assert.equal(reconciled.items.length, 1);
  assert.equal(reconciled.items[0].derivedStatus, "pending");
  assert.deepEqual(JSON.parse(await fsp.readFile(fixture.historicalPath, "utf8")), { untouched: true });

  const before = await fsp.readFile(fixture.jsonPath, "utf8");
  const plan = await planReview(fixture.summaryPath, { maxConcurrency: 5, hardLimitTokens: 60_000 });
  const after = await fsp.readFile(fixture.jsonPath, "utf8");
  assert.equal(after, before);
  assert.equal(plan.requestedMaxConcurrency, 5);
  assert.equal(plan.maxUsefulConcurrency, 1);
  assert.equal(plan.buckets[0].items[0].jsonPath, fixture.jsonPath);
});

test("reconcile derives blocked, not_required, and user-disabled review without persisting fake statuses", async (t) => {
  const failed = await createFixture(t, { status: "transcription_failed", hasTxt: false, itemTranscript: null });
  const failedResult = await reconcileSummary(failed.summaryPath);
  assert.equal(failedResult.items[0].derivedStatus, "blocked");
  const failedJson = JSON.parse(await fsp.readFile(failed.jsonPath, "utf8"));
  assert.equal(failedJson.agent_review.status, "pending");
  assert.equal(failedJson.agent_review.reason, "transcription_failed");

  const noSpeech = await createFixture(t, { hasTxt: false, itemTranscript: null });
  const noSpeechResult = await reconcileSummary(noSpeech.summaryPath);
  assert.equal(noSpeechResult.items[0].derivedStatus, "not_required");
  assert.equal(noSpeechResult.items[0].agent_review.reason, "no_speech");

  const disabled = await createFixture(t);
  const disabledResult = await reconcileSummary(disabled.summaryPath, { disableReview: true });
  assert.equal(disabledResult.items[0].derivedStatus, "not_required");
  assert.equal(disabledResult.items[0].agent_review.reason, "agent_review_disabled_by_user");
});

test("claim, checkpoint, pause and a new claim preserve progress while rejecting the old agent", async (t) => {
  const fixture = await createFixture(t);
  await reconcileSummary(fixture.summaryPath);
  const first = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "child-1",
    role: "subagent",
    now: "2026-07-18T01:00:00.000Z",
  });
  await assert.rejects(
    claimReview(fixture.jsonPath, { summaryPath: fixture.summaryPath, reviewer: "child-2", role: "subagent", now: "2026-07-18T01:01:00.000Z" }),
    { code: "REVIEW_ALREADY_CLAIMED" },
  );
  await fsp.writeFile(first.workFile, "第一行。\nsecond line\n", "utf8");
  await checkpointReview(fixture.jsonPath, first.claimId, 1, { summaryPath: fixture.summaryPath, now: "2026-07-18T01:02:00.000Z" });
  await pauseReview(fixture.jsonPath, first.claimId, { summaryPath: fixture.summaryPath, now: "2026-07-18T01:03:00.000Z" });
  await fsp.writeFile(first.workFile, "late old-agent write\ncorrupt work\n", "utf8");

  const second = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "child-2",
    role: "subagent",
    now: "2026-07-18T01:04:00.000Z",
  });
  assert.equal(second.resumeThroughLine, 1);
  assert.equal(await fsp.readFile(second.workFile, "utf8"), "第一行。\nsecond line\n");
  await assert.rejects(
    checkpointReview(fixture.jsonPath, first.claimId, 2, { summaryPath: fixture.summaryPath, generation: first.generation }),
    { code: "REVIEW_CAS_MISMATCH" },
  );
});

test("expired lease can be reclaimed and the late claimant cannot commit", async (t) => {
  const fixture = await createFixture(t);
  await reconcileSummary(fixture.summaryPath);
  const oldClaim = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "old",
    role: "subagent",
    leaseMs: 1_000,
    now: "2026-07-18T01:00:00.000Z",
  });
  const newClaim = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "new",
    role: "subagent",
    now: "2026-07-18T01:00:02.000Z",
  });
  assert.notEqual(newClaim.claimId, oldClaim.claimId);
  await assert.rejects(
    checkpointReview(fixture.jsonPath, oldClaim.claimId, 1, { summaryPath: fixture.summaryPath, generation: oldClaim.generation }),
    { code: "REVIEW_CAS_MISMATCH" },
  );
});

test("complete atomically replaces TXT, preserves raw JSON transcript values, and finalize exits zero", async (t) => {
  const fixture = await createFixture(t);
  await reconcileSummary(fixture.summaryPath);
  const original = JSON.parse(await fsp.readFile(fixture.jsonPath, "utf8"));
  const claim = await claimReview(fixture.jsonPath, { summaryPath: fixture.summaryPath, reviewer: "main", role: "main" });
  await fsp.writeFile(claim.workFile, "第一行。\nsecond line!\n", "utf8");
  await checkpointReview(fixture.jsonPath, claim.claimId, 2, { summaryPath: fixture.summaryPath });
  const completed = await completeReview(fixture.jsonPath, claim.claimId, { summaryPath: fixture.summaryPath, reportedCorrections: 2 });
  assert.equal(completed.changedLinesCount, 2);
  assert.equal(await fsp.readFile(fixture.txtPath, "utf8"), "第一行。\nsecond line!\n");
  const after = JSON.parse(await fsp.readFile(fixture.jsonPath, "utf8"));
  assert.equal(after.transcript, original.transcript);
  assert.deepEqual(after.segments, original.segments);
  assert.equal(after.agent_review.status, "reviewed");
  assert.equal(after.agent_review.reported_corrections_count, 2);

  const finalized = await finalizeSummary(fixture.summaryPath);
  assert.equal(finalized.exitCode, 0);
  assert.equal(finalized.agentReview.reviewed, 1);
  const summary = JSON.parse(await fsp.readFile(fixture.summaryPath, "utf8"));
  assert.equal(summary.marker, "preserve-me");
});

test("complete rejects edits made after the final checkpoint", async (t) => {
  const fixture = await createFixture(t);
  await reconcileSummary(fixture.summaryPath);
  const claim = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "main",
    role: "main",
  });
  await fsp.writeFile(claim.workFile, "第一行。\nsecond line\n", "utf8");
  await checkpointReview(fixture.jsonPath, claim.claimId, 2, { summaryPath: fixture.summaryPath });
  await fsp.writeFile(claim.workFile, "第一行。\nsecond line!\n", "utf8");
  await assert.rejects(
    completeReview(fixture.jsonPath, claim.claimId, { summaryPath: fixture.summaryPath }),
    { code: "REVIEW_STALE_CHECKPOINT" },
  );
  assert.equal(await fsp.readFile(fixture.txtPath, "utf8"), fixture.transcript);
});

test("only failed subagent attempts consume retry allowance and duration spans all attempts", async (t) => {
  const fixture = await createFixture(t);
  await reconcileSummary(fixture.summaryPath, { now: "2026-07-18T01:00:00.000Z" });
  const first = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "child-1",
    role: "subagent",
    now: "2026-07-18T01:00:00.000Z",
  });
  await failReview(fixture.jsonPath, first.claimId, "first failure", {
    summaryPath: fixture.summaryPath,
    now: "2026-07-18T01:01:00.000Z",
  });
  const second = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "child-2",
    role: "subagent",
    now: "2026-07-18T01:02:00.000Z",
  });
  await failReview(fixture.jsonPath, second.claimId, "second failure", {
    summaryPath: fixture.summaryPath,
    now: "2026-07-18T01:03:00.000Z",
  });
  await assert.rejects(
    claimReview(fixture.jsonPath, {
      summaryPath: fixture.summaryPath,
      reviewer: "child-3",
      role: "subagent",
      now: "2026-07-18T01:04:00.000Z",
    }),
    { code: "REVIEW_SUBAGENT_RETRY_EXHAUSTED" },
  );
  const main = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "main",
    role: "main",
    now: "2026-07-18T01:05:00.000Z",
  });
  await fsp.writeFile(main.workFile, "第一行。\nsecond line\n", "utf8");
  await checkpointReview(fixture.jsonPath, main.claimId, 2, {
    summaryPath: fixture.summaryPath,
    now: "2026-07-18T01:06:00.000Z",
  });
  await completeReview(fixture.jsonPath, main.claimId, {
    summaryPath: fixture.summaryPath,
    now: "2026-07-18T01:10:00.000Z",
  });
  const item = JSON.parse(await fsp.readFile(fixture.jsonPath, "utf8"));
  assert.equal(item.agent_review.duration_ms, 10 * 60_000);
});

test("reconcile recovers committing when the official TXT already has the target hash", async (t) => {
  const fixture = await createFixture(t);
  await reconcileSummary(fixture.summaryPath);
  const claim = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "main",
    role: "main",
  });
  const reviewedText = "第一行。\nsecond line\n";
  await fsp.writeFile(claim.workFile, reviewedText, "utf8");
  await checkpointReview(fixture.jsonPath, claim.claimId, 2, { summaryPath: fixture.summaryPath });
  const item = JSON.parse(await fsp.readFile(fixture.jsonPath, "utf8"));
  const targetHash = await sha256File(claim.workFile);
  item.agent_review.status = "committing";
  item.agent_review.commit = {
    stagePath: path.join(fixture.itemDir, ".unused.stage"),
    backupPath: path.join(fixture.itemDir, ".unused.backup"),
    work_file: claim.workFile,
    source_sha256: item.agent_review.source_txt_sha256,
    target_sha256: targetHash,
    changed_lines_count: 1,
    reported_corrections_count: 1,
    started_at: new Date().toISOString(),
  };
  await fsp.writeFile(fixture.jsonPath, `${JSON.stringify(item, null, 2)}\n`, "utf8");
  await fsp.writeFile(fixture.txtPath, reviewedText, "utf8");

  const reconciled = await reconcileSummary(fixture.summaryPath);
  assert.equal(reconciled.items[0].derivedStatus, "reviewed");
  assert.equal(await fsp.readFile(fixture.txtPath, "utf8"), reviewedText);
  await assert.rejects(fsp.access(claim.workFile), { code: "ENOENT" });
});

test("source transcript tampering is derived as stale and finalize fails", async (t) => {
  const fixture = await createFixture(t);
  await reconcileSummary(fixture.summaryPath);
  const item = JSON.parse(await fsp.readFile(fixture.jsonPath, "utf8"));
  item.transcript = `${item.transcript}tampered`;
  await fsp.writeFile(fixture.jsonPath, `${JSON.stringify(item, null, 2)}\n`, "utf8");
  const finalized = await finalizeSummary(fixture.summaryPath);
  assert.equal(finalized.exitCode, 1);
  assert.equal(finalized.items[0].derivedStatus, "stale");
});

test("finalize distinguishes resumable pending from hard failures and CLI preserves exit codes", async (t) => {
  const pending = await createFixture(t);
  await reconcileSummary(pending.summaryPath, { now: "2026-07-18T01:00:00.000Z" });
  const pendingFinal = await finalizeSummary(pending.summaryPath, { now: "2026-07-18T01:05:00.000Z" });
  assert.equal(pendingFinal.exitCode, 3);
  assert.equal(pendingFinal.agentReview.wallDurationMs, 5 * 60_000);

  const failed = await createFixture(t, { status: "transcription_failed", hasTxt: false, itemTranscript: null });
  await reconcileSummary(failed.summaryPath);
  assert.equal((await finalizeSummary(failed.summaryPath)).exitCode, 1);

  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runAgentReviewCli(["finalize", "--summary", pending.summaryPath], { stdout, stderr });
  assert.equal(code, 3);
  assert.equal(JSON.parse(stdout.value).exitCode, 3);
  assert.equal(stderr.value, "");
});

test("deterministic JSON backup is discoverable and recoverable after a crash window", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-review-atomic-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  await writeJsonAtomic(file, { version: 1 });
  const backup = `${file}.agent-review.backup`;
  await rename(file, backup);
  assert.deepEqual(await recoverAtomicFile(file), { recovered: true });
  assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")), { version: 1 });

  await fsp.copyFile(file, backup);
  await fsp.writeFile(file, "{broken", "utf8");
  assert.deepEqual(await recoverAtomicFile(file), { recovered: true, replacedCorruptTarget: true });
  assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")), { version: 1 });
});

test("immutable checkpoints survive later work edits and expired-lease takeover", async (t) => {
  const fixture = await createFixture(t);
  await reconcileSummary(fixture.summaryPath);
  const first = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "child-1",
    role: "subagent",
    leaseMs: 1_000,
    now: "2026-07-18T01:00:00.000Z",
  });
  await fsp.writeFile(first.workFile, "第一行。\nsecond line\n", "utf8");
  await checkpointReview(fixture.jsonPath, first.claimId, 1, {
    summaryPath: fixture.summaryPath,
    leaseMs: 1_000,
    now: "2026-07-18T01:00:00.500Z",
  });
  await fsp.writeFile(first.workFile, "第一行。\nlate uncheckpointed edit\n", "utf8");
  const second = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "child-2",
    role: "subagent",
    now: "2026-07-18T01:00:02.000Z",
  });
  assert.equal(second.resumeThroughLine, 1);
  assert.equal(await fsp.readFile(second.workFile, "utf8"), "第一行。\nsecond line\n");
});

test("expired claims and regressing checkpoints are rejected before takeover", async (t) => {
  const fixture = await createFixture(t);
  await reconcileSummary(fixture.summaryPath);
  const claim = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "main",
    role: "main",
    leaseMs: 1_000,
    now: "2026-07-18T01:00:00.000Z",
  });
  await assert.rejects(
    checkpointReview(fixture.jsonPath, claim.claimId, 1, {
      summaryPath: fixture.summaryPath,
      now: "2026-07-18T01:00:02.000Z",
    }),
    { code: "REVIEW_LEASE_EXPIRED" },
  );

  const fresh = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "main-2",
    role: "main",
    now: "2026-07-18T01:00:03.000Z",
  });
  await checkpointReview(fixture.jsonPath, fresh.claimId, 1, {
    summaryPath: fixture.summaryPath,
    now: "2026-07-18T01:00:04.000Z",
  });
  await assert.rejects(
    checkpointReview(fixture.jsonPath, fresh.claimId, 0, {
      summaryPath: fixture.summaryPath,
      now: "2026-07-18T01:00:05.000Z",
    }),
    { code: "REVIEW_CHECKPOINT_REGRESSION" },
  );
});

test("checkpoint normalizes BOM and CRLF before a successful commit", async (t) => {
  const fixture = await createFixture(t);
  await reconcileSummary(fixture.summaryPath);
  const claim = await claimReview(fixture.jsonPath, {
    summaryPath: fixture.summaryPath,
    reviewer: "main",
    role: "main",
  });
  await fsp.writeFile(claim.workFile, "\uFEFF第一行。\r\nsecond line!\r\n", "utf8");
  await checkpointReview(fixture.jsonPath, claim.claimId, 2, { summaryPath: fixture.summaryPath });
  await completeReview(fixture.jsonPath, claim.claimId, { summaryPath: fixture.summaryPath });
  assert.equal(await fsp.readFile(fixture.txtPath, "utf8"), "第一行。\nsecond line!\n");
});

test("forged reviewed state and pre-reconcile TXT edits cannot become false success", async (t) => {
  const forged = await createFixture(t);
  await reconcileSummary(forged.summaryPath);
  const forgedItem = JSON.parse(await fsp.readFile(forged.jsonPath, "utf8"));
  forgedItem.agent_review.status = "reviewed";
  await fsp.writeFile(forged.jsonPath, `${JSON.stringify(forgedItem, null, 2)}\n`, "utf8");
  await assert.rejects(finalizeSummary(forged.summaryPath), { code: "REVIEW_SCHEMA_INVALID" });

  const edited = await createFixture(t);
  await fsp.writeFile(edited.txtPath, "manually edited before reconcile\nsecond line\n", "utf8");
  const reconciled = await reconcileSummary(edited.summaryPath);
  assert.equal(reconciled.items[0].derivedStatus, "stale");
});

test("a reused item cannot be mutated or planned through a different runId", async (t) => {
  const fixture = await createFixture(t);
  await reconcileSummary(fixture.summaryPath);
  const otherSummary = path.join(fixture.outputDir, "other-summary.json");
  await fsp.writeFile(otherSummary, `${JSON.stringify({
    runId: "run-other",
    results: [{ jsonPath: fixture.jsonPath }],
  }, null, 2)}\n`, "utf8");
  await assert.rejects(planReview(otherSummary), { code: "REVIEW_BATCH_MISMATCH" });
  await assert.rejects(
    claimReview(fixture.jsonPath, {
      summaryPath: otherSummary,
      reviewer: "wrong-batch",
      role: "main",
    }),
    { code: "REVIEW_BATCH_MISMATCH" },
  );

  const stdout = captureStream();
  const stderr = captureStream();
  assert.equal(await runAgentReviewCli(["finalize", "--summary", otherSummary], { stdout, stderr }), 2);
  assert.equal(JSON.parse(stderr.value).code, "REVIEW_BATCH_MISMATCH");
});

test("reconcile persists the requested plan budget and actual host concurrency", async (t) => {
  const fixture = await createFixture(t);
  const reconciled = await reconcileSummary(fixture.summaryPath, {
    maxConcurrency: 5,
    effectiveConcurrency: 2,
    contextWindow: 200_000,
    contextUsed: 20_000,
  });
  assert.equal(reconciled.agentReview.requestedMaxConcurrency, 5);
  assert.equal(reconciled.agentReview.effectiveMaxConcurrency, 1);
  assert.equal(reconciled.agentReview.targetTokensPerAgent, 72_000);
  assert.equal(reconciled.agentReview.hardLimitTokensPerAgent, 90_000);
});

test("active lock heartbeats prevent stale takeover during a long transaction", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-review-lock-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "state.json");
  const events = [];
  const first = withFileLock(target, async () => {
    events.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 120));
    events.push("first-end");
  }, { staleLockMs: 40, timeoutMs: 500 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = withFileLock(target, async () => { events.push("second"); }, { staleLockMs: 40, timeoutMs: 500 });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
});

test("recoverable replacement rejects a missing official TXT without a valid backup", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-review-replace-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const targetPath = path.join(dir, "official.txt");
  const sourcePath = path.join(dir, "snapshot.txt");
  await fsp.writeFile(sourcePath, "reviewed\n", "utf8");
  await assert.rejects(replaceFileRecoverably({
    targetPath,
    sourcePath,
    stagePath: path.join(dir, "stage.txt"),
    backupPath: path.join(dir, "backup.txt"),
    expectedSourceHash: sha256Text("source\n"),
    expectedTargetHash: sha256Text("reviewed\n"),
    hashFile: sha256File,
  }), { code: "REVIEW_STALE_TARGET" });
});

test("CLI rejects unknown options instead of silently changing the plan", async (t) => {
  const fixture = await createFixture(t);
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runAgentReviewCli([
    "reconcile", "--summary", fixture.summaryPath, "--max-concurreny", "5",
  ], { stdout, stderr });
  assert.equal(code, 2);
  assert.equal(JSON.parse(stderr.value).code, "REVIEW_INVALID_ARGUMENT");
});
