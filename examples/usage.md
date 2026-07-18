# Usage examples

Public links from Douyin, Bilibili, Kuaishou, Xiaohongshu, and Weibo are accepted. For example:

All platforms use the same policy: select the highest quality available without login from the streams the platform actually exposes, then record the selection and any fallback in the JSON output.

```bash
node scripts/download.mjs "https://v.kuaishou.com/xxxxx" --no-transcribe
node scripts/download.mjs "https://video.weibo.com/show?fid=1034:5317814823878730" --no-transcribe
```

## Example: Extract a transcript from one Douyin video

## Input

```bash
node scripts/download.mjs "https://v.douyin.com/iRNBho5/" --output ./douyin_results
```

## Terminal output (stderr)

```
[platforms] loaded 5: bilibili, douyin, kuaishou, weibo, xiaohongshu
[batch] 1 unique URL(s), parse concurrency 1, download concurrency 1, video output item folders, transcribe on (serial, medium, cuda), output ./douyin_results
[1/1] parse attempt 1/10: https://v.douyin.com/iRNBho5/
[1/1] extracting audio...
[1/1] transcribing (medium, cuda/float16)...
[1/1] complete (3829104 bytes, transcribed): douyin_results/2026_06_24_21-30-00_抖音_张三_740123456789/...json
```

After the entire machine batch finishes, an Agent Skill run reviews each required TXT through the review coordinator. It edits only a claimed temporary work copy, corrects context-confirmable recognition errors, leaves uncertain text unchanged, and publishes the single official TXT with `complete`. Raw `transcript` and `segments` in JSON never change.

## Output files

```
douyin_results/
  ├── .temp/
  │   └── 抖音_740123456789_a1b2c3d4e5f6.mp4
  └── 2026_06_24_21-30-00_抖音_张三_740123456789/
      ├── 2026_06_24_21-30-00_抖音_张三_740123456789.mp4
      ├── 2026_06_24_21-30-00_抖音_张三_740123456789.json
      └── 2026_06_24_21-30-00_抖音_张三_740123456789_transcript.txt
```

## Example: Batch processing

```bash
node scripts/download.mjs \
  "https://v.douyin.com/abc123" \
  "https://www.bilibili.com/video/BVxxxxx" \
  "https://video.weibo.com/show?fid=1034:5317814823878730" \
  --output ./my_results
```

Review only the items listed by this run's summary:

```bash
node scripts/agent-review.mjs reconcile --summary ./my_results/download-summary.json
node scripts/agent-review.mjs plan --summary ./my_results/download-summary.json --max-concurrency 3
```

`plan` emits machine-readable buckets. The requested limit defaults to 3 and can be changed by the user, but the Agent host may provide fewer usable slots. Assign one bucket to each available Agent; each Agent processes multiple TXT files sequentially rather than opening one Agent per TXT.

`plan.maxUsefulConcurrency` is only an upper bound. After spawning, record the number of reviewers that actually succeeded before they claim work. Repeat the same requested concurrency and context/explicit budget flags used for `plan` so the durable summary matches the plan:

```bash
node scripts/agent-review.mjs reconcile \
  --summary ./my_results/download-summary.json \
  --max-concurrency 3 \
  --effective-concurrency 2
```

For each assigned item, use the JSON path returned by `plan`:

```bash
node scripts/agent-review.mjs claim \
  --summary ./my_results/download-summary.json \
  --json ./my_results/<item>/<item>.json \
  --reviewer review-agent-1 \
  --role subagent

# Edit only the work_file returned by claim. Keep one line per Whisper segment.
node scripts/agent-review.mjs checkpoint \
  --summary ./my_results/download-summary.json \
  --json ./my_results/<item>/<item>.json \
  --claim-id <claim-id> \
  --through-line 200

node scripts/agent-review.mjs complete \
  --summary ./my_results/download-summary.json \
  --json ./my_results/<item>/<item>.json \
  --claim-id <claim-id> \
  --reported-corrections 6
```

If the current context must end before the file is complete, checkpoint and pause it:

```bash
node scripts/agent-review.mjs pause \
  --summary ./my_results/download-summary.json \
  --json ./my_results/<item>/<item>.json \
  --claim-id <claim-id>
```

A new clean Agent session can run `reconcile/plan`, claim the paused item, and resume from the validated checkpoint. This is also the fallback when the host has no sub-Agent support: the main Agent works in bounded serial rounds instead of loading the full batch into one context.

After all buckets finish:

```bash
node scripts/agent-review.mjs finalize --summary ./my_results/download-summary.json
```

The download command and review finalization are separate phases. Download exit `0` means the machine phase succeeded; `finalize` exit `0` means review completed or was not required. `finalize` exit `3` means work is safely resumable, while `1` means failed/blocked/stale work and `2` means invalid arguments/schema/state.

The program does not call a correction model API. The main/sub-Agents perform language review in the current Agent host, so that host's data handling and privacy rules apply. If strict local-only handling is required, skip Agent review and use the raw machine output.

Record a strict-local/user opt-out explicitly:

```bash
node scripts/agent-review.mjs reconcile \
  --summary ./my_results/download-summary.json \
  --disable-review
node scripts/agent-review.mjs finalize --summary ./my_results/download-summary.json
```

This sets unfinished items to `required=false` with reason `agent_review_disabled_by_user`; it does not claim that the TXT was reviewed.

## Example: Download and transcribe a Weibo video

```bash
node scripts/download.mjs \
  "https://video.weibo.com/show?fid=1034:5317698549383292" \
  --output ./weibo_results
```

The Weibo adapter matches the requested `fid`, selects the highest quality available without login, then uses the same download, track-validation, transcription, and output pipeline as every other platform.

## Example: Temporarily disable platform plugins

```bash
# Repeat the option
node scripts/download.mjs --input links.txt \
  --disable-platform weibo \
  --disable-platform kuaishou

# Or use comma-separated IDs
node scripts/download.mjs --input links.txt \
  --disable-platform weibo,kuaishou
```

Disabled plugins are omitted from the startup list. If a plugin cannot be imported or fails contract validation, startup reports `[platforms] skipped <id>: ...` and continues with the remaining plugins.

## Example: GPU acceleration with high accuracy

```bash
node scripts/download.mjs "https://v.douyin.com/abc123" \
  --device cuda \
  --compute-type float16 \
  --model large-v3
```

## Example: Automatic and explicit CPU fallback

The default `medium + cuda + float16` profile automatically retries with `small + cpu + int8` only for recognized CUDA startup or runtime errors. An explicitly selected model is preserved; explicit `--device` or `--compute-type` values are never overridden. To select CPU yourself:

```bash
node scripts/download.mjs "https://v.douyin.com/abc123" \
  --device cpu \
  --model small
```

Explicit `--device cpu` defaults to `int8` unless `--compute-type` is also provided. If both CUDA and the eligible CPU fallback fail, the item becomes `transcription_failed`, keeps its video and JSON, increments `transcriptionFailed` in the summary, and exits with code `1` so the Agent reports the task as incomplete.

## Example: Skip transcription

```bash
node scripts/download.mjs "url1" "url2" "url3" --no-transcribe
```

## Example: Do not copy videos into result folders

```bash
node scripts/download.mjs "url1" "url2" --no-video-output --output ./my_results
```

The MP4 files remain in `.temp` as reusable cache. Clear it when needed:

```bash
node scripts/download.mjs --clear-temp --output ./my_results
```

This removes reusable media files but preserves `.temp/agent-review/` work needed by paused or in-progress review claims.
