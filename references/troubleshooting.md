# Troubleshooting

## Setup fails

- Require Node.js 20 or newer.
- Run `npm install`, then `node scripts/setup.mjs`.
- If Chromium installation is blocked, install Microsoft Edge or Google Chrome. The downloader tries bundled Chromium, Edge, then Chrome.

## Headless parsing repeatedly finds no media

Rerun with `--headed`. Leave the browser open if Douyin presents a verification prompt. Keep `--parse-concurrency` at the default 1, or reduce it back to 1 if you changed it. Do not increase concurrency to fight throttling.

Short share links can expire, redirect to a feed page, or point to a different item over time. If a short link repeatedly reports no media, open it once in a browser and retry with the canonical platform URL, such as `https://www.douyin.com/video/<id>` or `https://www.xiaohongshu.com/explore/<id>`.

## A batch was interrupted

Run the same command with the same output directory. `download-state.json` records completed items, and verified MP4 cache files in `<output>/.temp` are reused. Manually deleting the entire `.temp` directory removes both media cache and `.temp/agent-review` checkpoints, so unfinished media work and Agent review can no longer resume from those files. Use `--clear-temp` to remove only media cache while preserving Agent-review checkpoints; already generated JSON/TXT and item-folder MP4 files are not removed.

If the machine phase finished but Agent review was interrupted, keep `download-summary.json`, per-item JSON files, and `<output>/.temp/agent-review/`. Start from the same summary:

```bash
node scripts/agent-review.mjs reconcile --summary <output>/download-summary.json
node scripts/agent-review.mjs plan --summary <output>/download-summary.json --max-concurrency 3
```

The summary is the current-batch boundary. Do not point review tooling at the output directory or manually add historical JSON files.

## Agent review is pending or paused

`agent-review finalize` exits `3` for resumable `pending`, `paused`, or valid `in_progress` work. This is not a machine-stage failure. Continue the generated plan; do not rerun already reviewed files.

If sub-Agents are unavailable, use the main Agent in bounded rounds. Checkpoint after each block, call `pause` before the context budget is exhausted, then open a clean Agent session and run `reconcile/plan` against the same summary. If the host cannot provide either sub-Agents or a clean continuation context, leave the checkpoint intact and report review as resumable but incomplete.

The default requested limit is 3 sub-Agents, but the user may choose another value. Actual concurrency is the number of successfully created Agents that can access the shared workspace. Assign multiple TXT files sequentially to each Agent bucket; creating one Agent per TXT wastes slots and context.

## A review claim expired or a late reviewer returns

A lease expiry allows a new claim; it does not prove that the old Agent stopped. Let the new reviewer claim the item and continue from the last immutable checkpoint snapshot. The old Agent may still alter its obsolete `work.txt`, but cannot alter the snapshot used for resume/commit; late `checkpoint`, `complete`, or `fail` is rejected by lease and claim/generation CAS. Do not copy old work over the official TXT manually.

## Review reports stale

`stale` means the raw JSON transcript, official TXT, checkpoint, or recorded hashes no longer agree. Common causes are manual TXT/JSON edits, reusing a result JSON after regenerating transcription, or bypassing the review CLI.

Run `reconcile` once more after confirming no reviewer is still writing. If the mismatch remains, inspect the source and reviewed work deliberately; do not auto-overwrite the official TXT. JSON `transcript` and `segments` are the raw faster-whisper record and must not be changed to match a corrected TXT.

## Review was interrupted while committing

Run `reconcile`. If the official TXT already matches the recorded target hash, it completes the `reviewed` transition. If the official TXT still matches the source and the work copy is valid, the recoverable replacement can be retried. If neither hash matches, the item becomes `stale` and requires manual inspection. Keep backup/work files until reconciliation succeeds.

On Windows, an open editor, antivirus scan, long path, or file lock may prevent replacement. Close processes holding the TXT and retry `reconcile` or `complete`; never delete the official TXT first.

## Machine success but the Skill is not complete

The download CLI and Agent review have separate exit codes. Download `0/1/2` means machine success, machine failure, or invalid input/arguments. Review `finalize` returns `0` for complete/not-required, `1` for failed/blocked/stale, `2` for invalid arguments/schema/state, and `3` for resumable work. The Skill is complete only when the requested machine phase succeeds and review finalization returns `0`.

If the user explicitly requires strict local-only handling or declines Agent access to transcripts, run `reconcile --summary <output>/download-summary.json --disable-review`. It records unfinished items as `required=false` with reason `agent_review_disabled_by_user`. Do not describe those TXT files as Agent-reviewed.

## CUDA transcription fails

With the default device and compute profile, recognized CUDA startup or runtime errors automatically retry transcription with `small + cpu + int8`. An explicitly selected `--model` is preserved, while explicit `--device` or `--compute-type` choices are not overridden. Explicit `--device cpu` uses `int8` unless a compute type is also supplied.

If the CPU retry also fails, the item is saved as `transcription_failed`: its video and raw metadata JSON remain available, `transcription_error` records the failure, the batch summary increments `transcriptionFailed`, and the command exits with code `1`. Rerun with the same output directory to reuse the cached video and retry only transcription. Missing Python or faster-whisper, model download failures, and unrelated dependency errors do not trigger CUDA fallback.

If transcription succeeds but detects no speech, the item is `completed` without a TXT file and is reused on later runs.

## A download URL expires

No manual action is required. A failed media transfer causes the item to return to browser parsing and obtain a fresh CDN URL.

## Downloaded file has no video or audio track

The downloader validates the final MP4 before marking an item complete. `has no video track` usually means the platform exposed an audio-only candidate or a stale/partial media URL. `has no audio track` usually means a separated video stream was not paired with its audio stream. Keep the same output directory and rerun so the item can be reparsed; if it repeats for one short link, retry with the canonical URL.

## Permanent failures

Deleted, private, friends-only, login-only, and region-restricted works may never become downloadable. The final JSON summary distinguishes these from retryable network or verification failures.

## Clearing media cache

Use `node scripts/download.mjs --clear-temp --output ./video_results` to delete reusable media cache. It preserves `<output>/.temp/agent-review/` checkpoints and does not delete per-video result folders, JSON/TXT outputs, or MP4 files copied into item folders.

## Large batches

Keep browser parsing at the default 1 concurrent page unless you have verified the target platform remains stable. Downloads and transcription are serial by default for stability. For hundreds of links, split input files into manageable runs while reusing the same output directory and state file.

Agent review begins only after all machine processing for the current summary finishes. Review planning estimates transcript tokens and packs multiple TXT files into Agent buckets. In a clean context of at least 200K, a 70K–80K target and 100K hard ceiling may be appropriate; otherwise budgets are dynamically reduced. When the host cannot report context capacity, plan conservatively around 40K target/60K hard limit. A single oversized TXT must be processed in blocks across checkpoints and clean contexts, not loaded into several Agents concurrently.
