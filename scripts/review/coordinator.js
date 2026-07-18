import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  cleanupReplacement,
  createReplacementPaths,
  pathExists,
  recoverAtomicFile,
  replaceFileRecoverably,
  withFileLock,
  writeUtf8File,
  writeJsonAtomic,
} from "./atomic-files.js";

export const AGENT_REVIEW_SCHEMA_VERSION = 2;
export const DEFAULT_MAX_CONCURRENCY = 3;
export const DEFAULT_LEASE_MS = 60 * 60_000;
export const MAX_ATTEMPT_HISTORY = 20;
export const MAX_ERROR_LENGTH = 2_000;

export class ReviewCoordinatorError extends Error {
  constructor(message, code = "REVIEW_ERROR") {
    super(message);
    this.name = "ReviewCoordinatorError";
    this.code = code;
  }
}

export function normalizeTranscriptText(text) {
  return String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export function formatTranscriptTxtContent(transcript) {
  const normalized = normalizeTranscriptText(transcript).replace(/\n+$/u, "");
  return normalized ? `${normalized}\n` : null;
}

export function sha256Text(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

export async function sha256File(filePath) {
  return createHash("sha256").update(await fsp.readFile(filePath)).digest("hex");
}

export function estimateTranscriptTokens(text) {
  let cjk = 0;
  let other = 0;
  const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  for (const character of String(text ?? "")) {
    if (cjkPattern.test(character)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function createInitialAgentReview({ transcript, txtContent, required, reason = null }) {
  const transcriptText = String(transcript ?? "");
  return {
    schema_version: AGENT_REVIEW_SCHEMA_VERSION,
    required: Boolean(required),
    status: "pending",
    reason: reason ?? null,
    source_transcript_sha256: sha256Text(transcriptText),
    source_txt_sha256: txtContent === null || txtContent === undefined ? null : sha256Text(txtContent),
    reviewed_txt_sha256: null,
    estimated_transcript_tokens: estimateTranscriptTokens(transcriptText),
    generation: 0,
    review_started_at: null,
    subagent_failure_count: 0,
    active_claim: null,
    checkpoint: null,
    attempt_history: [],
    reviewed_at: null,
    duration_ms: null,
    changed_lines_count: null,
    reported_corrections_count: null,
    error: null,
  };
}

function reviewFromResult(result) {
  return result?.agent_review ?? result?.agentReview ?? null;
}

function persistedStatus(review) {
  return review?.status ?? "pending";
}

export function deriveReviewStatus({ review, item = null, now = Date.now(), facts = {} }) {
  if (!review) throw new ReviewCoordinatorError("Missing agent_review schema", "REVIEW_SCHEMA_MISSING");
  if (!review.required) return "not_required";
  if (review.reason === "transcription_failed" || item?.status === "transcription_failed" ||
      (item && Object.hasOwn(item, "transcript_file") && !item.transcript_file)) {
    return "blocked";
  }
  if (facts.stale) return "stale";
  if (review.status === "in_progress" && review.active_claim) {
    const leaseEnd = Date.parse(review.active_claim.lease_expires_at ?? "");
    if (Number.isFinite(leaseEnd) && leaseEnd <= Number(now)) {
      return review.checkpoint ? "paused" : "pending";
    }
  }
  return persistedStatus(review);
}

function emptySummary() {
  return {
    schemaVersion: AGENT_REVIEW_SCHEMA_VERSION,
    status: "completed",
    requestedMaxConcurrency: DEFAULT_MAX_CONCURRENCY,
    effectiveMaxConcurrency: 0,
    targetTokensPerAgent: 40_000,
    hardLimitTokensPerAgent: 60_000,
    estimatedTranscriptTokens: 0,
    required: 0,
    reviewed: 0,
    pending: 0,
    paused: 0,
    inProgress: 0,
    committing: 0,
    failed: 0,
    blocked: 0,
    stale: 0,
    notRequired: 0,
    changedLinesCount: 0,
    wallDurationMs: 0,
    startedAt: null,
    completedAt: null,
  };
}

export function buildInitialAgentReviewSummary(results = []) {
  const summary = emptySummary();
  for (const result of results ?? []) {
    const review = reviewFromResult(result);
    if (!review) continue;
    const status = result?.derivedStatus ?? deriveReviewStatus({ review, item: result });
    summary.estimatedTranscriptTokens += Number(review.estimated_transcript_tokens) || 0;
    if (review.required) summary.required += 1;
    if (status === "reviewed") {
      summary.reviewed += 1;
      summary.changedLinesCount += Number(review.changed_lines_count) || 0;
    } else if (status === "in_progress") summary.inProgress += 1;
    else if (status === "not_required") summary.notRequired += 1;
    else if (status in { pending: 1, paused: 1, committing: 1, failed: 1, blocked: 1, stale: 1 }) {
      const key = status === "not_required" ? "notRequired" : status;
      summary[key] += 1;
    }
  }
  if (summary.failed || summary.blocked || summary.stale) summary.status = "failed";
  else if (summary.pending || summary.paused || summary.inProgress || summary.committing) summary.status = "pending";
  return summary;
}

export function calculateContextBudget(options = {}) {
  if (options.targetTokens !== undefined || options.hardLimitTokens !== undefined) {
    const target = positiveInteger(options.targetTokens ?? 40_000, "targetTokens");
    const hard = positiveInteger(options.hardLimitTokens ?? 60_000, "hardLimitTokens");
    if (target > hard) throw new ReviewCoordinatorError("targetTokens cannot exceed hardLimitTokens", "REVIEW_INVALID_BUDGET");
    return { targetTokens: target, hardLimitTokens: hard, source: "explicit" };
  }
  if ((options.contextWindow === undefined) !== (options.contextUsed === undefined)) {
    throw new ReviewCoordinatorError("contextWindow and contextUsed must be provided together", "REVIEW_INVALID_BUDGET");
  }
  if (options.contextWindow !== undefined && options.contextUsed !== undefined) {
    const window = positiveInteger(options.contextWindow, "contextWindow");
    const used = nonNegativeInteger(options.contextUsed, "contextUsed");
    const remaining = window - used;
    if (remaining <= 0) throw new ReviewCoordinatorError("No context remains for transcript review", "REVIEW_NO_CONTEXT");
    const hardLimitTokens = Math.min(100_000, Math.floor(remaining * 0.5));
    const targetTokens = Math.min(80_000, Math.floor(remaining * 0.4), hardLimitTokens);
    if (targetTokens < 1 || hardLimitTokens < 1) {
      throw new ReviewCoordinatorError("Context budget is too small for transcript review", "REVIEW_NO_CONTEXT");
    }
    return { targetTokens, hardLimitTokens, source: "dynamic", remainingContextTokens: remaining };
  }
  return { targetTokens: 40_000, hardLimitTokens: 60_000, source: "default" };
}

export function packReviewItems(items, hardLimitTokens) {
  const hard = positiveInteger(hardLimitTokens, "hardLimitTokens");
  const sorted = [...items].sort((a, b) =>
    (Number(b.estimatedTokens) || 0) - (Number(a.estimatedTokens) || 0) ||
    String(a.jsonPath).localeCompare(String(b.jsonPath))
  );
  const buckets = [];
  for (const item of sorted) {
    const tokens = Math.max(0, Number(item.estimatedTokens) || 0);
    let candidates = buckets.filter((bucket) => bucket.estimatedTokens + tokens <= hard);
    candidates = candidates.sort((a, b) => a.estimatedTokens - b.estimatedTokens || a.index - b.index);
    let bucket = candidates[0];
    if (!bucket) {
      bucket = { index: buckets.length, estimatedTokens: 0, oversized: tokens > hard, items: [] };
      buckets.push(bucket);
    }
    bucket.items.push(item);
    bucket.estimatedTokens += tokens;
  }
  return buckets;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ReviewCoordinatorError(`${name} must be a positive integer`, "REVIEW_INVALID_ARGUMENT");
  }
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new ReviewCoordinatorError(`${name} must be a non-negative integer`, "REVIEW_INVALID_ARGUMENT");
  }
  return number;
}

function sanitizeError(error) {
  return String(error ?? "Unknown review error")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, MAX_ERROR_LENGTH);
}

function nowDate(options = {}) {
  const value = typeof options.now === "function" ? options.now() : options.now;
  return value === undefined ? new Date() : new Date(value);
}

function linesOf(text) {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function changedLineCount(source, reviewed) {
  const sourceLines = linesOf(source);
  const reviewedLines = linesOf(reviewed);
  const length = Math.max(sourceLines.length, reviewedLines.length);
  let changed = 0;
  for (let index = 0; index < length; index += 1) {
    if (sourceLines[index] !== reviewedLines[index]) changed += 1;
  }
  return changed;
}

function inferInitialReview(item, txtContent, disableReview = false) {
  if (disableReview) {
    return createInitialAgentReview({
      transcript: item.transcript ?? "",
      txtContent,
      required: false,
      reason: "agent_review_disabled_by_user",
    });
  }
  if (item.status === "transcription_failed") {
    return createInitialAgentReview({
      transcript: item.transcript ?? "",
      txtContent,
      required: true,
      reason: "transcription_failed",
    });
  }
  if (item.transcript && item.transcript_file && txtContent !== null) {
    return createInitialAgentReview({ transcript: item.transcript, txtContent, required: true });
  }
  const reason = item.transcription === null && !item.transcript
    ? "transcription_disabled"
    : "no_speech";
  return createInitialAgentReview({ transcript: item.transcript ?? "", txtContent, required: false, reason });
}

async function readJson(filePath, options = {}) {
  let parsed;
  try {
    if (options.recover !== false) await recoverAtomicFile(filePath);
    parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    throw new ReviewCoordinatorError(`Cannot read JSON ${filePath}: ${error.message}`, "REVIEW_INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReviewCoordinatorError(`JSON root must be an object: ${filePath}`, "REVIEW_INVALID_JSON");
  }
  return parsed;
}

function resolveResultJsonPath(summaryPath, jsonPath) {
  if (!jsonPath) return null;
  return path.resolve(path.isAbsolute(jsonPath) ? jsonPath : path.join(path.dirname(summaryPath), jsonPath));
}

async function loadBatch(summaryPath, options = {}) {
  const absoluteSummaryPath = path.resolve(summaryPath);
  const summary = await readJson(absoluteSummaryPath, options);
  if (!Array.isArray(summary.results)) {
    throw new ReviewCoordinatorError("download-summary.json must contain a results array", "REVIEW_INVALID_SUMMARY");
  }
  if (summary.runId !== undefined) validateRunId(summary.runId);
  const seen = new Set();
  const entries = [];
  for (const result of summary.results) {
    const jsonPath = resolveResultJsonPath(absoluteSummaryPath, result?.jsonPath);
    if (!jsonPath || seen.has(jsonPath)) continue;
    seen.add(jsonPath);
    entries.push({ result, jsonPath });
  }
  return { summaryPath: absoluteSummaryPath, summary, entries };
}

function validateRunId(runId) {
  if (typeof runId !== "string" || !runId || runId.length > 128 ||
      runId === "." || runId === ".." || !/^[A-Za-z0-9._-]+$/u.test(runId)) {
    throw new ReviewCoordinatorError("Batch runId is not a safe path segment", "REVIEW_INVALID_SUMMARY");
  }
  return runId;
}

function validateReviewShape(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    throw new ReviewCoordinatorError("agent_review must be an object", "REVIEW_SCHEMA_INVALID");
  }
  if (review.schema_version !== AGENT_REVIEW_SCHEMA_VERSION) {
    throw new ReviewCoordinatorError(`Unsupported agent_review schema: ${review.schema_version}`, "REVIEW_SCHEMA_INVALID");
  }
  if (typeof review.required !== "boolean" || !Number.isInteger(review.generation) || review.generation < 0) {
    throw new ReviewCoordinatorError("agent_review required/generation is invalid", "REVIEW_SCHEMA_INVALID");
  }
  const statuses = new Set(["pending", "in_progress", "paused", "committing", "reviewed", "failed"]);
  if (!statuses.has(review.status)) {
    throw new ReviewCoordinatorError(`Invalid persisted review status: ${review.status}`, "REVIEW_SCHEMA_INVALID");
  }
  const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  const isDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
  if (!isHash(review.source_transcript_sha256) || !Array.isArray(review.attempt_history)) {
    throw new ReviewCoordinatorError("agent_review source hash or attempt history is invalid", "REVIEW_SCHEMA_INVALID");
  }
  if (!Number.isInteger(review.subagent_failure_count) || review.subagent_failure_count < 0) {
    throw new ReviewCoordinatorError("agent_review subagent failure count is invalid", "REVIEW_SCHEMA_INVALID");
  }
  if (review.review_started_at !== null && !isDate(review.review_started_at)) {
    throw new ReviewCoordinatorError("agent_review review_started_at is invalid", "REVIEW_SCHEMA_INVALID");
  }
  if (review.required && review.reason !== "transcription_failed" && !isHash(review.source_txt_sha256)) {
    throw new ReviewCoordinatorError("Required review is missing its source TXT hash", "REVIEW_SCHEMA_INVALID");
  }
  if (review.checkpoint) {
    const checkpoint = review.checkpoint;
    if (!Number.isInteger(checkpoint.completed_through_line) || checkpoint.completed_through_line < 0 ||
        !Number.isInteger(checkpoint.total_lines) || checkpoint.total_lines < checkpoint.completed_through_line ||
        !Number.isInteger(checkpoint.generation) || checkpoint.generation < 1 ||
        !isHash(checkpoint.work_txt_sha256) || typeof checkpoint.work_file !== "string" || !checkpoint.work_file) {
      throw new ReviewCoordinatorError("agent_review checkpoint is invalid", "REVIEW_SCHEMA_INVALID");
    }
  }
  const claim = review.active_claim;
  if (["in_progress", "committing"].includes(review.status)) {
    if (!claim || typeof claim.claim_id !== "string" || !claim.claim_id ||
        claim.generation !== review.generation || !isHash(claim.claimed_txt_sha256) ||
        typeof claim.work_file !== "string" || !claim.work_file ||
        !isDate(claim.claimed_at) || !isDate(claim.lease_expires_at)) {
      throw new ReviewCoordinatorError("Active review claim is invalid", "REVIEW_SCHEMA_INVALID");
    }
  } else if (claim !== null) {
    throw new ReviewCoordinatorError("Inactive review state cannot retain an active claim", "REVIEW_SCHEMA_INVALID");
  }
  if (review.status === "paused" && !review.checkpoint) {
    throw new ReviewCoordinatorError("Paused review is missing its checkpoint", "REVIEW_SCHEMA_INVALID");
  }
  if (review.status === "committing") {
    const commit = review.commit;
    if (!commit || !isHash(commit.source_sha256) || !isHash(commit.target_sha256) ||
        typeof commit.work_file !== "string" || !commit.work_file ||
        typeof commit.stagePath !== "string" || typeof commit.backupPath !== "string") {
      throw new ReviewCoordinatorError("Committing review metadata is invalid", "REVIEW_SCHEMA_INVALID");
    }
  }
  if (review.status === "reviewed") {
    if (!isHash(review.reviewed_txt_sha256) || !isDate(review.reviewed_at) || review.checkpoint !== null) {
      throw new ReviewCoordinatorError("Reviewed state is missing verified completion metadata", "REVIEW_SCHEMA_INVALID");
    }
  }
}

function validateReviewRunId(review, runId) {
  if (!runId) {
    throw new ReviewCoordinatorError("Batch summary has no runId; run reconcile first", "REVIEW_RECONCILE_REQUIRED");
  }
  if (review.run_id !== runId) {
    throw new ReviewCoordinatorError("Review item belongs to a different batch runId; run reconcile on the intended summary", "REVIEW_BATCH_MISMATCH");
  }
}

function mergeReviewDefaults(existing, initial) {
  const merged = { ...initial, ...existing, schema_version: AGENT_REVIEW_SCHEMA_VERSION };
  merged.attempt_history = trimAttemptHistory(existing?.attempt_history);
  const recordedFailures = merged.attempt_history.filter((attempt) =>
    attempt.role === "subagent" && attempt.result === "failed"
  ).length;
  merged.subagent_failure_count = Math.max(
    Number.isInteger(existing?.subagent_failure_count) ? existing.subagent_failure_count : 0,
    recordedFailures,
  );
  return merged;
}

async function readOptionalText(filePath) {
  if (!filePath) return null;
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function inspectFacts(item, review) {
  let stale = false;
  const currentTranscriptHash = sha256Text(item.transcript ?? "");
  if (review.source_transcript_sha256 !== currentTranscriptHash) stale = true;

  let officialHash = null;
  if (item.transcript_file) {
    try {
      officialHash = await sha256File(item.transcript_file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (review.required && item.transcript_file) {
    const expected = review.status === "reviewed"
      ? review.reviewed_txt_sha256
      : review.status === "committing"
        ? null
        : review.source_txt_sha256;
    if (expected && officialHash !== expected) stale = true;
  }
  if (review.checkpoint?.work_file) {
    try {
      if (await sha256File(review.checkpoint.work_file) !== review.checkpoint.work_txt_sha256) stale = true;
    } catch (error) {
      if (error.code === "ENOENT") stale = true;
      else throw error;
    }
  }
  return { stale, officialHash };
}

function trimAttemptHistory(attempts = []) {
  if (!Array.isArray(attempts)) return [];
  const failed = attempts.filter((attempt) => attempt?.result === "failed");
  const others = attempts.filter((attempt) => attempt?.result !== "failed");
  return [...failed.slice(-MAX_ATTEMPT_HISTORY), ...others.slice(-(MAX_ATTEMPT_HISTORY - Math.min(failed.length, MAX_ATTEMPT_HISTORY)))]
    .sort((a, b) => Date.parse(a?.started_at ?? "") - Date.parse(b?.started_at ?? ""));
}

function appendAttempt(review, attempt) {
  review.attempt_history = trimAttemptHistory([...(review.attempt_history ?? []), attempt]);
}

function finishAttempt(review, claimId, patch) {
  const attempt = [...(review.attempt_history ?? [])].reverse().find((entry) => entry.claim_id === claimId && !entry.ended_at);
  if (attempt) Object.assign(attempt, patch);
}

function validateActiveClaim(item, review, claimId, options = {}) {
  validateReviewShape(review);
  if (review.status !== "in_progress" || !review.active_claim) {
    throw new ReviewCoordinatorError("Review item has no active claim", "REVIEW_CAS_MISMATCH");
  }
  const generation = options.generation ?? review.active_claim.generation;
  if (review.active_claim.claim_id !== claimId || review.active_claim.generation !== Number(generation) || review.generation !== Number(generation)) {
    throw new ReviewCoordinatorError("Claim id or generation no longer matches", "REVIEW_CAS_MISMATCH");
  }
  const leaseEnd = Date.parse(review.active_claim.lease_expires_at ?? "");
  if (!Number.isFinite(leaseEnd) || leaseEnd <= nowDate(options).getTime()) {
    throw new ReviewCoordinatorError("Review claim lease has expired", "REVIEW_LEASE_EXPIRED");
  }
  if (sha256Text(item.transcript ?? "") !== review.source_transcript_sha256) {
    throw new ReviewCoordinatorError("Original transcript changed after claim", "REVIEW_STALE_TRANSCRIPT");
  }
  return review.active_claim;
}

async function validateClaimFiles(item, review, claim, expectedWorkHash = null) {
  const officialHash = await sha256File(item.transcript_file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (officialHash !== claim.claimed_txt_sha256 || officialHash !== review.source_txt_sha256) {
    throw new ReviewCoordinatorError("Official transcript changed after claim", "REVIEW_STALE_TARGET");
  }
  const workHash = await sha256File(claim.work_file);
  if (expectedWorkHash && workHash !== expectedWorkHash) {
    throw new ReviewCoordinatorError("Work transcript hash does not match caller expectation", "REVIEW_STALE_WORK");
  }
  return workHash;
}

function finalizeReviewedState(review, now, targetHash, changedLines, corrections) {
  const claimId = review.active_claim?.claim_id;
  const startedAt = Date.parse(review.review_started_at ?? "");
  review.status = "reviewed";
  review.reviewed_txt_sha256 = targetHash;
  review.reviewed_at = now.toISOString();
  review.duration_ms = Number.isFinite(startedAt) ? Math.max(0, now.getTime() - startedAt) : null;
  review.changed_lines_count = changedLines;
  review.reported_corrections_count = corrections;
  review.error = null;
  review.checkpoint = null;
  review.commit = null;
  finishAttempt(review, claimId, { ended_at: now.toISOString(), result: "reviewed", error: null });
  review.active_claim = null;
}

async function recoverCommitting(item, review, now) {
  const commit = review.commit;
  if (!commit?.target_sha256 || !commit?.source_sha256 || !commit?.work_file || !item.transcript_file) {
    return { recovered: false, stale: true };
  }
  const targetHash = await sha256File(item.transcript_file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (targetHash === commit.target_sha256) {
    await cleanupReplacement(commit);
    await cleanupWorkFile(commit.work_file);
    await cleanupWorkFile(commit.mutable_work_file);
    finalizeReviewedState(review, now, commit.target_sha256, commit.changed_lines_count, commit.reported_corrections_count);
    return { recovered: true, stale: false };
  }
  const workHash = await sha256File(commit.work_file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  const backupHash = commit.backupPath
    ? await sha256File(commit.backupPath).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error))
    : null;
  const sourceRecoverable = targetHash === commit.source_sha256 || (targetHash === null && backupHash === commit.source_sha256);
  if (!sourceRecoverable || workHash !== commit.target_sha256) return { recovered: false, stale: true };
  await replaceFileRecoverably({
    targetPath: item.transcript_file,
    sourcePath: commit.work_file,
    stagePath: commit.stagePath,
    backupPath: commit.backupPath,
    expectedSourceHash: commit.source_sha256,
    expectedTargetHash: commit.target_sha256,
    hashFile: sha256File,
  });
  await cleanupReplacement(commit);
  await cleanupWorkFile(commit.work_file);
  await cleanupWorkFile(commit.mutable_work_file);
  finalizeReviewedState(review, now, commit.target_sha256, commit.changed_lines_count, commit.reported_corrections_count);
  return { recovered: true, stale: false };
}

async function cleanupWorkFile(workFile) {
  if (!workFile) return;
  await fsp.rm(workFile, { force: true }).catch(() => {});
  await fsp.rmdir(path.dirname(workFile)).catch(() => {});
}

async function createCheckpointSnapshot(claim, generation, completedThroughLine, workText) {
  const snapshotPath = path.join(
    path.dirname(claim.work_file),
    `checkpoint-${generation}-${completedThroughLine}-${randomUUID()}.txt`,
  );
  await writeUtf8File(snapshotPath, workText);
  return {
    snapshotPath,
    snapshotHash: await sha256File(snapshotPath),
  };
}

async function cleanupSupersededCheckpoint(checkpointFile, activeWorkFile) {
  if (!checkpointFile || checkpointFile === activeWorkFile) return;
  await cleanupWorkFile(checkpointFile);
}

export async function reconcileReviewItem(jsonPath, options = {}) {
  const absolutePath = path.resolve(jsonPath);
  return withFileLock(absolutePath, async () => {
    const item = await readJson(absolutePath);
    const txtContent = await readOptionalText(item.transcript_file);
    const expectedTxtContent = formatTranscriptTxtContent(item.transcript);
    const inferredSourceTxt = !item.agent_review && txtContent !== null && expectedTxtContent !== null &&
      normalizeTranscriptText(txtContent) !== expectedTxtContent
      ? expectedTxtContent
      : txtContent;
    const initial = inferInitialReview(item, inferredSourceTxt, options.disableReview);
    let review = item.agent_review
      ? mergeReviewDefaults(item.agent_review, initial)
      : initial;

    if (options.disableReview && review.status !== "reviewed") {
      const leaseEnd = Date.parse(review.active_claim?.lease_expires_at ?? "");
      if (review.status === "in_progress" && Number.isFinite(leaseEnd) && leaseEnd > nowDate(options).getTime()) {
        throw new ReviewCoordinatorError("Cannot disable review while a claim lease is active", "REVIEW_ACTIVE_CLAIM");
      }
      review.required = false;
      review.reason = "agent_review_disabled_by_user";
      review.status = "pending";
      review.active_claim = null;
    }
    if (options.runId && review.run_id && review.run_id !== options.runId && review.status === "in_progress") {
      const leaseEnd = Date.parse(review.active_claim?.lease_expires_at ?? "");
      if (Number.isFinite(leaseEnd) && leaseEnd > nowDate(options).getTime()) {
        throw new ReviewCoordinatorError("Cannot move an actively claimed item to another batch", "REVIEW_ACTIVE_CLAIM");
      }
    }
    if (options.runId) review.run_id = options.runId;
    validateReviewShape(review);

    let committingFacts = null;
    if (review.status === "committing") committingFacts = await recoverCommitting(item, review, nowDate(options));
    item.agent_review = review;
    await writeJsonAtomic(absolutePath, item);
    const facts = await inspectFacts(item, review);
    if (committingFacts?.stale) facts.stale = true;
    return {
      jsonPath: absolutePath,
      transcriptFile: item.transcript_file ?? null,
      agent_review: review,
      derivedStatus: deriveReviewStatus({ review, item, now: nowDate(options).getTime(), facts }),
    };
  });
}

async function inspectReviewItem(jsonPath, options = {}) {
  const item = await readJson(jsonPath, { recover: options.recover !== false });
  validateReviewShape(item.agent_review);
  const facts = await inspectFacts(item, item.agent_review);
  return {
    jsonPath,
    transcriptFile: item.transcript_file ?? null,
    agent_review: item.agent_review,
    derivedStatus: deriveReviewStatus({ review: item.agent_review, item, now: nowDate(options).getTime(), facts }),
  };
}

function mergeAggregateSettings(aggregate, previous = {}, options = {}) {
  const requested = options.maxConcurrency ?? previous.requestedMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  aggregate.requestedMaxConcurrency = positiveInteger(requested, "maxConcurrency");
  const reportedEffective = nonNegativeInteger(
    options.effectiveConcurrency ?? previous.effectiveMaxConcurrency ?? 0,
    "effectiveConcurrency",
  );
  aggregate.effectiveMaxConcurrency = Math.min(
    reportedEffective,
    aggregate.required,
    aggregate.requestedMaxConcurrency,
  );
  const hasBudgetInput = options.targetTokens !== undefined ||
    options.hardLimitTokens !== undefined ||
    options.contextWindow !== undefined ||
    options.contextUsed !== undefined;
  const budget = options.budget ?? (hasBudgetInput ? calculateContextBudget(options) : null);
  if (budget) {
    aggregate.targetTokensPerAgent = budget.targetTokens;
    aggregate.hardLimitTokensPerAgent = budget.hardLimitTokens;
  } else {
    aggregate.targetTokensPerAgent = previous.targetTokensPerAgent ?? aggregate.targetTokensPerAgent;
    aggregate.hardLimitTokensPerAgent = previous.hardLimitTokensPerAgent ?? aggregate.hardLimitTokensPerAgent;
  }
  const current = nowDate(options);
  aggregate.startedAt = previous.startedAt ?? (aggregate.required > 0 ? current.toISOString() : null);
  aggregate.completedAt = aggregate.status === "completed"
    ? previous.completedAt ?? current.toISOString()
    : null;
  const startedMs = Date.parse(aggregate.startedAt ?? "");
  const endedMs = Date.parse(aggregate.completedAt ?? current.toISOString());
  aggregate.wallDurationMs = Number.isFinite(startedMs) && Number.isFinite(endedMs)
    ? Math.max(0, endedMs - startedMs)
    : 0;
  return aggregate;
}

export async function reconcileSummary(summaryPath, options = {}) {
  const absoluteSummaryPath = path.resolve(summaryPath);
  return withFileLock(absoluteSummaryPath, async () => {
    const batch = await loadBatch(absoluteSummaryPath);
    const runId = batch.summary.runId ?? randomUUID();
    const items = [];
    for (const entry of batch.entries) {
      items.push(await reconcileReviewItem(entry.jsonPath, { ...options, runId }));
    }
    const aggregate = mergeAggregateSettings(
      buildInitialAgentReviewSummary(items),
      batch.summary.agentReview,
      options,
    );
    batch.summary.runId = runId;
    batch.summary.agentReview = aggregate;
    await writeJsonAtomic(batch.summaryPath, batch.summary);
    return { runId, summaryPath: batch.summaryPath, agentReview: aggregate, items };
  });
}

export async function planReview(summaryPath, options = {}) {
  const batch = await loadBatch(summaryPath, { recover: false });
  if (!batch.summary.runId) {
    throw new ReviewCoordinatorError("Batch summary has no runId; run reconcile first", "REVIEW_RECONCILE_REQUIRED");
  }
  const budget = calculateContextBudget(options);
  const maxConcurrency = positiveInteger(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, "maxConcurrency");
  const inspected = [];
  for (const entry of batch.entries) {
    const item = await inspectReviewItem(entry.jsonPath, { ...options, recover: false });
    validateReviewRunId(item.agent_review, batch.summary.runId);
    inspected.push(item);
  }
  const ready = inspected
    .filter((entry) => ["pending", "paused", "failed"].includes(entry.derivedStatus))
    .map((entry) => ({
      jsonPath: entry.jsonPath,
      transcriptFile: entry.transcriptFile,
      status: entry.derivedStatus,
      estimatedTokens: Number(entry.agent_review.estimated_transcript_tokens) || 0,
      resumeThroughLine: entry.agent_review.checkpoint?.completed_through_line ?? 0,
    }));
  const buckets = packReviewItems(ready, budget.hardLimitTokens);
  return {
    schemaVersion: AGENT_REVIEW_SCHEMA_VERSION,
    runId: batch.summary.runId ?? null,
    summaryPath: batch.summaryPath,
    requestedMaxConcurrency: maxConcurrency,
    maxUsefulConcurrency: Math.min(maxConcurrency, buckets.length),
    targetTokensPerAgent: budget.targetTokens,
    hardLimitTokensPerAgent: budget.hardLimitTokens,
    budgetSource: budget.source,
    totalEstimatedTokens: ready.reduce((sum, item) => sum + item.estimatedTokens, 0),
    buckets,
  };
}

function workRootForItem(outputDir, runId, claimId) {
  return path.join(outputDir, ".temp", "agent-review", runId || "unscoped", claimId);
}

export async function claimReview(jsonPath, options = {}) {
  const absolutePath = path.resolve(jsonPath);
  const batch = await requireBatchMembership(absolutePath, options);
  const reviewer = String(options.reviewer ?? "").trim();
  const role = options.role;
  if (!reviewer) throw new ReviewCoordinatorError("reviewer is required", "REVIEW_INVALID_ARGUMENT");
  if (!new Set(["main", "subagent"]).has(role)) {
    throw new ReviewCoordinatorError("role must be main or subagent", "REVIEW_INVALID_ARGUMENT");
  }
  const leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs");
  return withFileLock(absolutePath, async () => {
    const now = nowDate(options);
    const item = await readJson(absolutePath);
    const review = item.agent_review;
    validateReviewShape(review);
    validateReviewRunId(review, batch.runId);
    const facts = await inspectFacts(item, review);
    const derived = deriveReviewStatus({ review, item, now: now.getTime(), facts });
    if (derived === "stale" || derived === "blocked" || derived === "not_required" || derived === "reviewed" || derived === "committing") {
      throw new ReviewCoordinatorError(`Review item cannot be claimed from state ${derived}`, "REVIEW_NOT_CLAIMABLE");
    }
    const leaseEnd = Date.parse(review.active_claim?.lease_expires_at ?? "");
    if (review.status === "in_progress" && Number.isFinite(leaseEnd) && leaseEnd > now.getTime()) {
      throw new ReviewCoordinatorError("Review item already has an active lease", "REVIEW_ALREADY_CLAIMED");
    }
    if (role === "subagent") {
      const priorSubagentFailures = review.subagent_failure_count;
      if (priorSubagentFailures >= 2) {
        throw new ReviewCoordinatorError("Subagent retry limit reached; main Agent takeover is required", "REVIEW_SUBAGENT_RETRY_EXHAUSTED");
      }
    }
    if (!item.transcript_file || !review.source_txt_sha256) {
      throw new ReviewCoordinatorError("Claimable item must have a source transcript TXT", "REVIEW_BLOCKED");
    }
    const officialHash = await sha256File(item.transcript_file);
    if (officialHash !== review.source_txt_sha256) {
      throw new ReviewCoordinatorError("Official transcript does not match the recorded source hash", "REVIEW_STALE_TARGET");
    }

    if (review.status === "in_progress" && review.active_claim) {
      finishAttempt(review, review.active_claim.claim_id, {
        ended_at: now.toISOString(),
        result: "lease_expired",
        error: null,
      });
    }

    let sourceWork = item.transcript_file;
    let resumeThroughLine = 0;
    if (review.checkpoint?.work_file) {
      const checkpointHash = await sha256File(review.checkpoint.work_file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (checkpointHash !== review.checkpoint.work_txt_sha256) {
        throw new ReviewCoordinatorError("Checkpoint work file is missing or stale", "REVIEW_STALE_CHECKPOINT");
      }
      sourceWork = review.checkpoint.work_file;
      resumeThroughLine = review.checkpoint.completed_through_line;
    }

    const generation = review.generation + 1;
    const claimId = randomUUID();
    const workDir = workRootForItem(batch.outputDir, batch.runId, claimId);
    const workFile = path.join(workDir, "work.txt");
    const normalizedWork = normalizeTranscriptText(await fsp.readFile(sourceWork, "utf8"));
    await fsp.mkdir(workDir, { recursive: true });
    await fsp.writeFile(workFile, normalizedWork, { encoding: "utf8", flag: "wx" });
    const workHash = await sha256File(workFile);
    const totalLines = linesOf(normalizedWork).length;
    review.generation = generation;
    review.review_started_at ??= now.toISOString();
    review.status = "in_progress";
    review.active_claim = {
      claim_id: claimId,
      generation,
      reviewer,
      role,
      claimed_txt_sha256: officialHash,
      claimed_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
      work_file: workFile,
    };
    review.error = null;
    appendAttempt(review, {
      claim_id: claimId,
      generation,
      reviewer,
      role,
      started_at: now.toISOString(),
      ended_at: null,
      result: "in_progress",
      error: null,
    });
    item.agent_review = review;
    await writeJsonAtomic(absolutePath, item);
    return {
      jsonPath: absolutePath,
      claimId,
      generation,
      workFile,
      workTxtSha256: workHash,
      resumeThroughLine,
      totalLines,
      leaseExpiresAt: review.active_claim.lease_expires_at,
    };
  });
}

export async function checkpointReview(jsonPath, claimId, throughLine, options = {}) {
  const absolutePath = path.resolve(jsonPath);
  const batch = await requireBatchMembership(absolutePath, options);
  const completed = nonNegativeInteger(throughLine, "throughLine");
  return withFileLock(absolutePath, async () => {
    const now = nowDate(options);
    const item = await readJson(absolutePath);
    const review = item.agent_review;
    validateReviewRunId(review, batch.runId);
    const claim = validateActiveClaim(item, review, claimId, options);
    await validateClaimFiles(item, review, claim, options.expectedWorkHash);
    const rawWorkText = await fsp.readFile(claim.work_file, "utf8");
    const workText = normalizeTranscriptText(rawWorkText);
    if (workText !== rawWorkText) await fsp.writeFile(claim.work_file, workText, "utf8");
    const sourceText = normalizeTranscriptText(await fsp.readFile(item.transcript_file, "utf8"));
    const totalLines = linesOf(sourceText).length;
    if (linesOf(workText).length !== totalLines) {
      throw new ReviewCoordinatorError("Review work file must preserve one line per source segment", "REVIEW_LINE_COUNT_MISMATCH");
    }
    if (completed > totalLines) {
      throw new ReviewCoordinatorError("throughLine exceeds transcript line count", "REVIEW_INVALID_CHECKPOINT");
    }
    const previousCompleted = review.checkpoint?.generation === review.generation
      ? review.checkpoint.completed_through_line
      : 0;
    if (completed < previousCompleted) {
      throw new ReviewCoordinatorError("throughLine cannot move behind the current checkpoint", "REVIEW_CHECKPOINT_REGRESSION");
    }
    const previousCheckpointFile = review.checkpoint?.work_file ?? null;
    const { snapshotPath, snapshotHash } = await createCheckpointSnapshot(
      claim,
      review.generation,
      completed,
      workText,
    );
    review.checkpoint = {
      completed_through_line: completed,
      total_lines: totalLines,
      work_txt_sha256: snapshotHash,
      work_file: snapshotPath,
      generation: review.generation,
      updated_at: now.toISOString(),
    };
    claim.lease_expires_at = new Date(now.getTime() + positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs")).toISOString();
    item.agent_review = review;
    try {
      await writeJsonAtomic(absolutePath, item);
    } catch (error) {
      await cleanupWorkFile(snapshotPath);
      throw error;
    }
    await cleanupSupersededCheckpoint(previousCheckpointFile, claim.work_file);
    return { jsonPath: absolutePath, claimId, generation: review.generation, checkpoint: review.checkpoint, leaseExpiresAt: claim.lease_expires_at };
  });
}

export async function pauseReview(jsonPath, claimId, options = {}) {
  const absolutePath = path.resolve(jsonPath);
  const batch = await requireBatchMembership(absolutePath, options);
  return withFileLock(absolutePath, async () => {
    const now = nowDate(options);
    const item = await readJson(absolutePath);
    const review = item.agent_review;
    validateReviewRunId(review, batch.runId);
    const claim = validateActiveClaim(item, review, claimId, options);
    await validateClaimFiles(item, review, claim, options.expectedWorkHash);
    const rawWorkText = await fsp.readFile(claim.work_file, "utf8");
    const workText = normalizeTranscriptText(rawWorkText);
    if (workText !== rawWorkText) await fsp.writeFile(claim.work_file, workText, "utf8");
    const sourceText = normalizeTranscriptText(await fsp.readFile(item.transcript_file, "utf8"));
    const totalLines = linesOf(sourceText).length;
    if (linesOf(workText).length !== totalLines) {
      throw new ReviewCoordinatorError("Review work file must preserve source line count", "REVIEW_LINE_COUNT_MISMATCH");
    }
    const completed = options.throughLine === undefined
      ? review.checkpoint?.completed_through_line ?? 0
      : nonNegativeInteger(options.throughLine, "throughLine");
    if (completed > totalLines) throw new ReviewCoordinatorError("throughLine exceeds transcript line count", "REVIEW_INVALID_CHECKPOINT");
    const previousCompleted = review.checkpoint?.generation === review.generation
      ? review.checkpoint.completed_through_line
      : 0;
    if (completed < previousCompleted) {
      throw new ReviewCoordinatorError("throughLine cannot move behind the current checkpoint", "REVIEW_CHECKPOINT_REGRESSION");
    }
    const previousCheckpointFile = review.checkpoint?.work_file ?? null;
    const { snapshotPath, snapshotHash } = await createCheckpointSnapshot(
      claim,
      review.generation,
      completed,
      workText,
    );
    review.checkpoint = {
      completed_through_line: completed,
      total_lines: totalLines,
      work_txt_sha256: snapshotHash,
      work_file: snapshotPath,
      generation: review.generation,
      updated_at: now.toISOString(),
    };
    review.status = "paused";
    finishAttempt(review, claimId, { ended_at: now.toISOString(), result: "paused", error: null });
    review.active_claim = null;
    item.agent_review = review;
    try {
      await writeJsonAtomic(absolutePath, item);
    } catch (error) {
      await cleanupWorkFile(snapshotPath);
      throw error;
    }
    await cleanupSupersededCheckpoint(previousCheckpointFile, claim.work_file);
    return { jsonPath: absolutePath, claimId, generation: review.generation, status: "paused", checkpoint: review.checkpoint };
  });
}

export async function failReview(jsonPath, claimId, errorMessage, options = {}) {
  const absolutePath = path.resolve(jsonPath);
  const batch = await requireBatchMembership(absolutePath, options);
  return withFileLock(absolutePath, async () => {
    const now = nowDate(options);
    const item = await readJson(absolutePath);
    const review = item.agent_review;
    validateReviewRunId(review, batch.runId);
    const claim = validateActiveClaim(item, review, claimId, options);
    await validateClaimFiles(item, review, claim, options.expectedWorkHash);
    const cleaned = sanitizeError(errorMessage);
    if (claim.role === "subagent") review.subagent_failure_count += 1;
    review.status = "failed";
    review.error = cleaned;
    finishAttempt(review, claimId, { ended_at: now.toISOString(), result: "failed", error: cleaned });
    review.active_claim = null;
    item.agent_review = review;
    await writeJsonAtomic(absolutePath, item);
    return { jsonPath: absolutePath, claimId, generation: review.generation, status: "failed", error: cleaned };
  });
}

export async function completeReview(jsonPath, claimId, options = {}) {
  const absolutePath = path.resolve(jsonPath);
  const batch = await requireBatchMembership(absolutePath, options);
  return withFileLock(absolutePath, async () => {
    const now = nowDate(options);
    const item = await readJson(absolutePath);
    const review = item.agent_review;
    validateReviewRunId(review, batch.runId);
    const claim = validateActiveClaim(item, review, claimId, options);
    await validateClaimFiles(item, review, claim, options.expectedWorkHash);
    const sourceText = normalizeTranscriptText(await fsp.readFile(item.transcript_file, "utf8"));
    const rawWorkText = await fsp.readFile(claim.work_file, "utf8");
    const workText = normalizeTranscriptText(rawWorkText);
    if (workText !== rawWorkText) await fsp.writeFile(claim.work_file, workText, "utf8");
    const sourceLines = linesOf(sourceText);
    const workLines = linesOf(workText);
    if (sourceLines.length !== workLines.length) {
      throw new ReviewCoordinatorError("Review work file must preserve source line count", "REVIEW_LINE_COUNT_MISMATCH");
    }
    if (!review.checkpoint || review.checkpoint.completed_through_line !== sourceLines.length) {
      throw new ReviewCoordinatorError("Final checkpoint must cover every transcript line", "REVIEW_INCOMPLETE_CHECKPOINT");
    }
    const targetHash = await sha256File(claim.work_file);
    if (review.checkpoint.generation !== review.generation ||
        review.checkpoint.work_txt_sha256 !== targetHash) {
      throw new ReviewCoordinatorError("Work file changed after the final checkpoint", "REVIEW_STALE_CHECKPOINT");
    }
    if (await sha256File(review.checkpoint.work_file) !== targetHash) {
      throw new ReviewCoordinatorError("Final checkpoint snapshot is missing or stale", "REVIEW_STALE_CHECKPOINT");
    }
    const changedLines = changedLineCount(sourceText, workText);
    const corrections = options.reportedCorrections === undefined || options.reportedCorrections === null
      ? null
      : nonNegativeInteger(options.reportedCorrections, "reportedCorrections");
    const paths = createReplacementPaths(item.transcript_file, claimId);
    review.status = "committing";
    review.commit = {
      ...paths,
      work_file: review.checkpoint.work_file,
      mutable_work_file: claim.work_file,
      source_sha256: review.source_txt_sha256,
      target_sha256: targetHash,
      changed_lines_count: changedLines,
      reported_corrections_count: corrections,
      started_at: now.toISOString(),
    };
    item.agent_review = review;
    await writeJsonAtomic(absolutePath, item);

    await replaceFileRecoverably({
      targetPath: item.transcript_file,
      sourcePath: review.checkpoint.work_file,
      stagePath: paths.stagePath,
      backupPath: paths.backupPath,
      expectedSourceHash: review.source_txt_sha256,
      expectedTargetHash: targetHash,
      hashFile: sha256File,
    });
    await cleanupReplacement(paths);
    await cleanupWorkFile(claim.work_file);
    await cleanupWorkFile(review.checkpoint.work_file);
    finalizeReviewedState(review, nowDate(options), targetHash, changedLines, corrections);
    item.agent_review = review;
    await writeJsonAtomic(absolutePath, item);
    return {
      jsonPath: absolutePath,
      claimId,
      generation: review.generation,
      status: "reviewed",
      reviewedTxtSha256: targetHash,
      changedLinesCount: changedLines,
      reportedCorrectionsCount: corrections,
    };
  });
}

export async function finalizeSummary(summaryPath, options = {}) {
  const absoluteSummaryPath = path.resolve(summaryPath);
  return withFileLock(absoluteSummaryPath, async () => {
    const batch = await loadBatch(absoluteSummaryPath);
    if (!batch.summary.runId) {
      throw new ReviewCoordinatorError("Batch summary has no runId; run reconcile first", "REVIEW_RECONCILE_REQUIRED");
    }
    const inspected = [];
    for (const entry of batch.entries) {
      const item = await inspectReviewItem(entry.jsonPath, options);
      validateReviewRunId(item.agent_review, batch.summary.runId);
      inspected.push(item);
    }
    const aggregate = mergeAggregateSettings(
      buildInitialAgentReviewSummary(inspected),
      batch.summary.agentReview,
      options,
    );
    batch.summary.agentReview = aggregate;
    await writeJsonAtomic(batch.summaryPath, batch.summary);
    const exitCode = aggregate.failed || aggregate.blocked || aggregate.stale
      ? 1
      : aggregate.pending || aggregate.paused || aggregate.inProgress || aggregate.committing
        ? 3
        : 0;
    return { exitCode, summaryPath: batch.summaryPath, agentReview: aggregate, items: inspected };
  });
}

export async function assertItemInSummary(jsonPath, summaryPath) {
  const absoluteSummaryPath = path.resolve(summaryPath);
  return withFileLock(absoluteSummaryPath, async () => {
    const batch = await loadBatch(absoluteSummaryPath);
    const absolutePath = path.resolve(jsonPath);
    if (!batch.entries.some((entry) => entry.jsonPath === absolutePath)) {
      throw new ReviewCoordinatorError("Item JSON is outside the current batch summary", "REVIEW_OUTSIDE_BATCH");
    }
    return {
      runId: batch.summary.runId ?? null,
      outputDir: path.dirname(batch.summaryPath),
      summaryPath: batch.summaryPath,
    };
  });
}

async function requireBatchMembership(jsonPath, options) {
  if (!options.summaryPath) {
    throw new ReviewCoordinatorError("summaryPath is required for review state mutations", "REVIEW_INVALID_ARGUMENT");
  }
  return await assertItemInSummary(jsonPath, options.summaryPath);
}

export { loadBatch as loadReviewBatch };
