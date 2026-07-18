#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  checkpointReview,
  claimReview,
  completeReview,
  failReview,
  finalizeSummary,
  pauseReview,
  planReview,
  reconcileSummary,
  ReviewCoordinatorError,
} from "./review/coordinator.js";

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") return { command: "help", options: {} };
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new ReviewCoordinatorError(`Unexpected argument: ${token}`, "REVIEW_INVALID_ARGUMENT");
    const key = token.slice(2);
    if (key === "disable-review") {
      options.disableReview = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ReviewCoordinatorError(`Missing value for --${key}`, "REVIEW_INVALID_ARGUMENT");
    }
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function coordinatorOptions(raw) {
  const options = { disableReview: raw.disableReview };
  for (const [source, target] of [
    ["max-concurrency", "maxConcurrency"],
    ["effective-concurrency", "effectiveConcurrency"],
    ["context-window", "contextWindow"],
    ["context-used", "contextUsed"],
    ["target-tokens", "targetTokens"],
    ["hard-limit", "hardLimitTokens"],
    ["lease-ms", "leaseMs"],
    ["generation", "generation"],
    ["through-line", "throughLine"],
    ["reported-corrections", "reportedCorrections"],
  ]) {
    if (raw[source] !== undefined) options[target] = Number(raw[source]);
  }
  if (raw["expected-work-hash"] !== undefined) options.expectedWorkHash = raw["expected-work-hash"];
  else if (raw["work-sha256"] !== undefined) options.expectedWorkHash = raw["work-sha256"];
  return options;
}

function validateCommandOptions(command, raw) {
  const commonMutation = ["summary", "json", "claim-id", "generation", "expected-work-hash", "work-sha256"];
  const allowed = {
    reconcile: ["summary", "disableReview", "max-concurrency", "effective-concurrency", "context-window", "context-used", "target-tokens", "hard-limit"],
    plan: ["summary", "max-concurrency", "context-window", "context-used", "target-tokens", "hard-limit"],
    claim: ["summary", "json", "reviewer", "role", "lease-ms"],
    checkpoint: [...commonMutation, "through-line", "lease-ms"],
    pause: [...commonMutation, "through-line"],
    complete: [...commonMutation, "reported-corrections"],
    fail: [...commonMutation, "error"],
    finalize: ["summary"],
  };
  const commandOptions = new Set(allowed[command] ?? []);
  for (const key of Object.keys(raw)) {
    if (!commandOptions.has(key)) {
      throw new ReviewCoordinatorError(`Unknown option for ${command}: --${key}`, "REVIEW_INVALID_ARGUMENT");
    }
  }
}

function requireOption(options, key) {
  const value = options[key];
  if (value === undefined || value === "") {
    throw new ReviewCoordinatorError(`--${key} is required`, "REVIEW_INVALID_ARGUMENT");
  }
  return value;
}

function usage() {
  return [
    "Usage: node scripts/agent-review.mjs <command> [options]",
    "",
    "Commands:",
    "  reconcile  --summary <download-summary.json> [--disable-review] [--max-concurrency <n>] [--effective-concurrency <n>] [--context-window <n> --context-used <n>] [--target-tokens <n> --hard-limit <n>]",
    "  plan       --summary <download-summary.json> [--max-concurrency <n>] [--context-window <n> --context-used <n>] [--target-tokens <n> --hard-limit <n>]",
    "  claim      --summary <file> --json <file> --reviewer <id> --role <main|subagent> [--lease-ms <n>]",
    "  checkpoint --summary <file> --json <file> --claim-id <id> --through-line <n> [--generation <n>] [--expected-work-hash <sha256>] [--lease-ms <n>]",
    "  pause      --summary <file> --json <file> --claim-id <id> [--through-line <n>] [--generation <n>] [--expected-work-hash <sha256>]",
    "  complete   --summary <file> --json <file> --claim-id <id> [--reported-corrections <n>] [--generation <n>] [--expected-work-hash <sha256>]",
    "  fail       --summary <file> --json <file> --claim-id <id> --error <message> [--generation <n>] [--expected-work-hash <sha256>]",
    "  finalize   --summary <download-summary.json>",
  ].join("\n");
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runAgentReviewCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const { command, options: raw } = parseArguments(argv);
    if (command === "help") {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    validateCommandOptions(command, raw);
    const options = coordinatorOptions(raw);
    let result;
    if (command === "reconcile") {
      result = await reconcileSummary(requireOption(raw, "summary"), options);
    } else if (command === "plan") {
      result = await planReview(requireOption(raw, "summary"), options);
    } else if (command === "claim") {
      const jsonPath = requireOption(raw, "json");
      result = await claimReview(jsonPath, {
        ...options,
        summaryPath: requireOption(raw, "summary"),
        reviewer: requireOption(raw, "reviewer"),
        role: requireOption(raw, "role"),
      });
    } else if (command === "checkpoint") {
      options.summaryPath = requireOption(raw, "summary");
      result = await checkpointReview(
        requireOption(raw, "json"),
        requireOption(raw, "claim-id"),
        options.throughLine ?? requireOption(raw, "through-line"),
        options,
      );
    } else if (command === "pause") {
      options.summaryPath = requireOption(raw, "summary");
      result = await pauseReview(requireOption(raw, "json"), requireOption(raw, "claim-id"), options);
    } else if (command === "complete") {
      options.summaryPath = requireOption(raw, "summary");
      result = await completeReview(requireOption(raw, "json"), requireOption(raw, "claim-id"), options);
    } else if (command === "fail") {
      options.summaryPath = requireOption(raw, "summary");
      result = await failReview(
        requireOption(raw, "json"),
        requireOption(raw, "claim-id"),
        requireOption(raw, "error"),
        options,
      );
    } else if (command === "finalize") {
      result = await finalizeSummary(requireOption(raw, "summary"), options);
    } else {
      throw new ReviewCoordinatorError(`Unknown command: ${command}`, "REVIEW_INVALID_ARGUMENT");
    }
    writeJson(stdout, result);
    return command === "finalize" ? result.exitCode : 0;
  } catch (error) {
    writeJson(stderr, { error: error.message, code: error.code ?? "REVIEW_UNEXPECTED_ERROR" });
    if (error instanceof ReviewCoordinatorError && [
      "REVIEW_INVALID_ARGUMENT",
      "REVIEW_INVALID_BUDGET",
      "REVIEW_NO_CONTEXT",
      "REVIEW_INVALID_JSON",
      "REVIEW_INVALID_SUMMARY",
      "REVIEW_SCHEMA_INVALID",
      "REVIEW_SCHEMA_MISSING",
      "REVIEW_RECONCILE_REQUIRED",
      "REVIEW_BATCH_MISMATCH",
      "REVIEW_OUTSIDE_BATCH",
      "REVIEW_INVALID_CHECKPOINT",
    ].includes(error.code)) return 2;
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runAgentReviewCli(process.argv.slice(2));
}
