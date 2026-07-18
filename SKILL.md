---
name: video-batch-download
description: "Use this skill when the user provides 抖音 (Douyin), B站 (Bilibili), 快手 (Kuaishou), 小红书 (Xiaohongshu), or 微博 (Weibo) video URLs and wants to download videos, extract metadata, transcribe audio with local Whisper, convert Traditional→Simplified Chinese, or get structured transcripts as JSON/TXT."
---

# Video Batch Download & Transcribe (Douyin, Bilibili, Kuaishou, Xiaohongshu & Weibo)

Download public videos from Douyin, Bilibili, Kuaishou, Xiaohongshu and Weibo. Downloading, media processing, Whisper transcription, and OpenCC conversion run locally and do not call model APIs. Optional TXT review is performed by the current Agent host, whose data handling and privacy rules apply.

## When to use

- User pastes one or more 抖音, B站, 快手, 小红书, or 微博 links and wants the spoken content as text
- User says "提取文案", "语音转文字", "下载抖音视频", "下载B站视频", "下载快手视频", "下载小红书视频", "下载微博视频", or gives a supported URL
- User wants structured metadata (title, author, stats, post time) from supported public video posts
- User wants batch download and/or transcription of videos from the supported platforms

## First run

Run from this skill directory:

```bash
npm install
node scripts/setup.mjs
```

`setup.mjs` verifies Playwright and installs Chromium only when needed.

### Python dependencies (for transcription)

```bash
pip install -U faster-whisper opencc
```

Also requires `ffmpeg` on PATH.

Default transcription starts with `medium + cuda + float16 + zh`. If the default device/compute profile hits a recognized CUDA runtime error, the pipeline automatically falls back to `small + cpu + int8`; if the user explicitly selected a model, that model is preserved. Explicit `--device` or `--compute-type` choices are never overridden. Explicit `--device cpu` uses `int8` unless `--compute-type` is also provided. The result records the actual model, device, compute type, and fallback reason.

## Workflow

1. **Receive URLs** — User provides one or more Douyin, Bilibili, Kuaishou, Xiaohongshu or Weibo links (or share text containing links). The script discovers platform plugins at runtime, skips disabled or broken plugins, and routes extracted URLs through each plugin's `matchesUrl()` method.
2. **Ask for output directory** — If user doesn't specify, default to `./video_results/`.
3. **Run the machine pipeline**:
    - Keep `scripts/download.mjs` as a thin CLI entry and delegate orchestration to the modular pipeline
    - Parse video metadata via Playwright browser interception, page state, and runtime media fallbacks; enumerate candidates available without login, rank them by quality, then validate the normalized result (concurrency 1 by default for stability)
    - Download MP4 via CDN URL into `<output>/.temp` cache (concurrency 1 by default for stability). For Bilibili and Douyin separated media streams, downloads video and audio separately and merges with ffmpeg.
    - Validate the final MP4 tracks and expected resolution/frame-rate/HDR; if the top candidate fails, try the next quality candidate available without login
    - Extract audio with ffmpeg → transcribe with local faster-whisper (model reused; recognized CUDA startup or runtime failures automatically fall back to CPU when device/precision were not explicitly selected)
    - Convert Traditional Chinese to Simplified via OpenCC
    - Write MP4 (by default), structured JSON, and plain text transcript into each video result folder
4. **Wait for the whole machine batch to finish, then review TXT files**:
    - Use only the current `download-summary.json.results[].jsonPath` list. Never scan every JSON/TXT in a reused output directory.
    - Run `reconcile`, then `plan`. The program initializes and validates review state, hashes, claims, checkpoints, and temporary work files; it does not call an LLM. Language correction is done by the current main Agent or its sub-Agents.
    - When the host exposes context window `W` and current usage `C`, pass them to `plan` and use `min(80K, floor((W-C)*0.40))` as the target and `min(100K, floor((W-C)*0.50))` as the hard transcript limit. Otherwise keep the deterministic 40K/60K defaults.
    - Default to at most 3 sub-Agents unless the user requests another limit. Treat the limit as a request: actual concurrency depends on host capacity and shared-workspace access. Assign multiple TXT files sequentially to each Agent according to the generated buckets; do not create one Agent per TXT.
    - Treat `plan.maxUsefulConcurrency` as an upper bound, not proof that Agents exist. After spawning reviewers, run `reconcile` again with requested/actual concurrency and the same context or explicit budget flags used by `plan`; do this before reviewers claim work.
    - Make each reviewer use `claim`, edit only the returned temporary work copy, checkpoint after each bounded block, and use `complete` to publish the single official TXT. Never edit the official TXT directly or hand-edit review fields in JSON.
    - Correct only context-confirmable recognition errors, homophones, terminology, punctuation, and sentence boundaries. Do not rewrite, summarize, expand, polish, change meaning/style, or guess uncertain text. Preserve one line per Whisper segment for resumability.
    - Keep JSON `transcript` and `segments` unchanged; they are the raw faster-whisper record. The reviewed `*_transcript.txt` remains the only user-facing transcript.
    - If sub-Agents are unavailable, review serially with `main_round_budget = min(30K, floor(remaining_context*0.25))`. Checkpoint every block, call `pause` before the budget is exhausted, and continue from the same summary in a new clean Agent session. If neither sub-Agents nor a clean continuation context is available, report resumable incomplete work.
    - Retry unfinished sub-Agent work once with a fresh claim, then let the main Agent take over. Late or expired claims must not overwrite newer work.
5. **Finalize and report both phases** — Run `finalize` after review. Do not report the Skill task complete until the machine phase satisfies the request and review `finalize` exits `0`. Report machine completion with review still pending as a resumable partial result.

### Agent review commands

```bash
node scripts/agent-review.mjs reconcile --summary <output>/download-summary.json
# Strict-local/user opt-out instead:
node scripts/agent-review.mjs reconcile --summary <output>/download-summary.json --disable-review
node scripts/agent-review.mjs plan --summary <output>/download-summary.json --max-concurrency 3
# If W/C are known: add --context-window <W> --context-used <C>.
# After spawning, persist requested/actual concurrency and repeat the same budget flags used by plan:
node scripts/agent-review.mjs reconcile --summary <output>/download-summary.json --max-concurrency <requested> --effective-concurrency <actual>
node scripts/agent-review.mjs claim --summary <summary.json> --json <item.json> --reviewer <id> --role <main|subagent>
node scripts/agent-review.mjs checkpoint --summary <summary.json> --json <item.json> --claim-id <id> --through-line <n>
node scripts/agent-review.mjs pause --summary <summary.json> --json <item.json> --claim-id <id>
node scripts/agent-review.mjs complete --summary <summary.json> --json <item.json> --claim-id <id> --reported-corrections <n>
node scripts/agent-review.mjs fail --summary <summary.json> --json <item.json> --claim-id <id> --error <message>
node scripts/agent-review.mjs finalize --summary <output>/download-summary.json
```

Use `plan` output for orchestration. A reviewer should return only file status, timing, and errors to the coordinator, never the full transcript text.

## Usage

### Single URL (or share text with embedded URL)

```bash
node scripts/download.mjs "https://v.douyin.com/xxxxx"
node scripts/download.mjs "https://www.bilibili.com/video/BVxxxxx"
node scripts/download.mjs "https://v.kuaishou.com/xxxxx"
node scripts/download.mjs "https://www.xiaohongshu.com/explore/xxxxx"
node scripts/download.mjs "https://video.weibo.com/show?fid=1034:5317814823878730"
```

### Multiple URLs

```bash
node scripts/download.mjs "url1" "url2" "url3"
```

### Custom output directory

```bash
node scripts/download.mjs "url" --output ./my_output
```

### Mixed platforms

```bash
node scripts/download.mjs "https://v.douyin.com/xxxxx" "https://www.bilibili.com/video/BVxxxxx" "https://v.kuaishou.com/xxxxx" "http://xhslink.com/xxxxx" "https://video.weibo.com/show?fid=1034:5317814823878730"
```

### From a text file

```bash
node scripts/download.mjs --input links.txt --output ./video_results
```

### Skip transcription (download video and metadata only)

```bash
node scripts/download.mjs "url" --no-transcribe
```

### Do not copy video into item folders

```bash
node scripts/download.mjs "url" --no-video-output
```

The final MP4 stays in `<output>/.temp/` as reusable cache. Clear media cache when it is no longer needed; this preserves `<output>/.temp/agent-review/` checkpoints:

```bash
node scripts/download.mjs --clear-temp --output ./video_results
```

### GPU acceleration with high accuracy

```bash
node scripts/download.mjs "url" --device cuda --compute-type float16 --model large-v3
```

### Indefinite retry for flaky links

```bash
node scripts/download.mjs --input links.txt --output ./downloads --max-attempts 0
```

### Visible browser for verification challenges

```bash
node scripts/download.mjs --input links.txt --output ./downloads --headed
```

### Temporarily disable platform plugins

```bash
node scripts/download.mjs --input links.txt --disable-platform weibo
node scripts/download.mjs --input links.txt --disable-platform weibo,kuaishou
```

`--disable-platform <id>` may be repeated and accepts comma-separated IDs. Other plugins continue loading when one plugin is disabled, missing, or invalid.

## CLI Options

### Download options

| Parameter | Default | Description |
|---|---|---|
| `--input <file>` | — | Read URLs from a UTF-8 text file |
| `--output <dir>` | `./video_results` | Output directory |
| `--parse-concurrency <n>` | `1` | Concurrent browser parsers |
| `--download-concurrency <n>` | `1` | Concurrent media downloads (serial by default for stability) |
| `--max-attempts <n>` | `10` | Retry attempts per item (0 = infinite) |
| `--page-timeout <secs>` | `45` | Page navigation timeout |
| `--media-wait <secs>` | `25` | Wait for media response after navigation |
| `--download-timeout <secs>` | `900` | Total download timeout per file |
| `--no-video-output` | off | Keep MP4 only in `.temp` cache instead of copying it into item folders |
| `--clear-temp` | off | Delete media cache, preserve Agent-review checkpoints, and exit |
| `--headed` | off | Show browser window |
| `--storage-state <file>` | — | Playwright storage-state JSON |
| `--disable-platform <id>` | — | Disable plugin ID(s); repeat or use comma-separated IDs |

### Transcription options

| Parameter | Default | Description |
|---|---|---|
| `--no-transcribe` | off | Skip Whisper transcription |
| `--model <name>` | `medium` | Whisper model (`small`, `medium`, `large-v3`) |
| `--language <code>` | `zh` | Language code, `auto` = auto-detect |
| `--device <cpu\|cuda>` | `cuda` | Transcription device; explicit `cpu` defaults compute type to `int8` |
| `--compute-type <type>` | `float16` | Precision (`int8`, `float16`, `float32`); an explicit value disables automatic fallback |
| `--no-simplify` | off | Skip Traditional→Simplified conversion |
| `--ffmpeg-path <path>` | auto | Path to ffmpeg executable |
| `--transcribe-timeout <secs>` | `600` | Timeout per transcription |

## Output format

Each video gets its own subdirectory:

```
video_results/
  ├── .temp/                              # reusable media cache
  │   └── 抖音_740123456789_a1b2c3d4e5f6.mp4
  ├── 2026_06_24_21-30-00_抖音_张三_740123456789/
  │   ├── 2026_06_24_21-30-00_抖音_张三_740123456789.mp4
  │   ├── 2026_06_24_21-30-00_抖音_张三_740123456789.json
  │   └── 2026_06_24_21-30-00_抖音_张三_740123456789_transcript.txt
  ├── 2026_06_24_21-31-00_B站_李四_BV1xx411c7mD/
  │   └── ...
  └── download-summary.json
```

By default, the final MP4 is copied into the per-video folder. The `.temp` directory is a reusable cache for resume/retry workflows. With `--no-video-output`, MP4 files stay only in `.temp` and are not copied into result folders.

Folder and file timestamps use the machine's local time in `YYYY_MM_DD_HH-mm-ss` format, not UTC.

The JSON `transcript` and `segments` preserve the raw faster-whisper output. Agent review edits a claimed temporary work copy and publishes it over the single user-facing `*_transcript.txt` only after validation; no alternate user-facing transcript files are created.

### Processing status vs. Skill completion

- `completed`: the program finished the requested machine processing (transcription succeeded, or transcription was explicitly skipped with `--no-transcribe`).
- `transcription_failed`: video and metadata succeeded, but both the requested transcription attempt and any eligible CPU fallback failed. The video and JSON are preserved, the batch summary increments `transcriptionFailed`, and the command exits with code `1`.
- `failed`: parsing, downloading, or output generation failed and may be retried.
- `permanent_failure`: the content is unavailable, invalid, or otherwise not retryable.

These are `download-state.json` machine states; a successful per-item output JSON retains `status: "success"`. The download CLI exits `0` for a successful machine phase, `1` for machine failures, and `2` for input/argument errors. Pending Agent review does not change those exit codes.

Review completion is separate: `agent-review finalize` exits `0` when all required reviews are complete or none are required, `1` for failed/blocked/stale work, `2` for invalid arguments/schema/state, and `3` for resumable pending/paused/in-progress work. `transcription_failed` has no TXT to edit but blocks overall Skill completion.

A successful transcription that detects no speech remains `completed` and produces no TXT, so no Agent review is required for that item.

### JSON format

```json
{
  "status": "success",
  "source_url": "https://v.douyin.com/xxxxx",
  "canonical_url": "https://www.douyin.com/video/740123456789",
  "video_id": "740123456789",
  "platform": "抖音",
  "content_type": "video",
  "title": "今天给大家分享一个技巧",
  "description": "这个视频教大家怎么用 AI 提高效率 #AI #效率",
  "author": {
    "nickname": "张三",
    "uid": "MS4wLjABAAAA...",
    "url": "https://www.douyin.com/user/xxx"
  },
  "post_time": "2026-06-20 14:30:00",
  "duration": 125,
  "stats": {
    "play_count": 1000,
    "digg_count": 1234,
    "comment_count": 56,
    "share_count": 78,
    "collect_count": 90
  },
  "transcript": "大家好，今天给大家分享一个非常好用的AI工具...",
  "segments": [
    {
      "start": 0.0,
      "end": 2.5,
      "text": "大家好，今天...",
      "simplified": true
    }
  ],
  "transcript_source": "faster-whisper",
  "transcription": {
    "model": "medium",
    "language": "zh",
    "language_probability": 0.98,
    "device": "cuda",
    "compute_type": "float16",
    "fallback_reason": null
  },
  "transcription_error": null,
  "agent_review": {
    "schema_version": 2,
    "required": true,
    "status": "pending",
    "reason": null,
    "source_transcript_sha256": "<sha256>",
    "source_txt_sha256": "<sha256>",
    "reviewed_txt_sha256": null,
    "estimated_transcript_tokens": 6820,
    "generation": 0,
    "review_started_at": null,
    "subagent_failure_count": 0,
    "active_claim": null,
    "checkpoint": null,
    "attempt_history": [],
    "reviewed_at": null,
    "duration_ms": null,
    "changed_lines_count": null,
    "reported_corrections_count": null,
    "error": null
  },
  "quality": {
    "access_mode": "anonymous",
    "selection_version": "anonymous-best-v1",
    "available_streams": [
      {"type": "video+audio", "resolution": "1080x1920", "quality": 1080}
    ],
    "selected_streams": [
      {"type": "video+audio", "resolution": "1080x1920", "quality": 1080}
    ],
    "audit": {
      "accessibleQualities": ["1080P", "720P"],
      "selectedQuality": "1080P",
      "selectionReason": "Highest quality available without login"
    }
  },
  "media_info": {
    "width": 1080,
    "height": 1920,
    "resolution": "1080x1920",
    "bitrate_kbps": 2500,
    "duration_secs": 125.5,
    "codec": "h264",
    "format": "mov,mp4,m4a,3gp,3g2,mj2"
  },
  "output_file": "D:/.../video_results/.../...json",
  "transcript_file": "D:/.../video_results/.../..._transcript.txt",
  "video_file": "D:/.../video_results/.../...mp4",
  "video_output": true,
  "cache_video_file": "D:/.../video_results/.temp/抖音_740123456789_a1b2c3d4e5f6.mp4"
}
```

## Important notes

- Supports Douyin (抖音), Bilibili (B站), Kuaishou (快手), Xiaohongshu (小红书), and Weibo (微博) platforms
- “Highest quality available without login” means the best stream actually accessible without an account session. It does not bypass signed-in/member restrictions or claim upload-original quality.
- Output JSON records sanitized available/selected streams, the selector version, advertised versus accessible qualities, and fallback reasons.
- Bilibili high-quality videos use DASH format (separate video/audio streams) — automatically merged with ffmpeg; selection still means the highest quality available without login and accepts only streams the service actually returns.
- Douyin may expose merged MP4 or separated `media-video-*` / `media-audio-*` streams; audio-only resources are never treated as completed videos.
- Xiaohongshu: video notes only; image/text notes are not supported. Login overlays may still expose public video-note state, so parser checks the target note state and media responses before failing.
- Kuaishou resolves short links, matches Apollo/GraphQL detail data by the target photo ID, and rejects unrelated recommendation media.
- Weibo matches the target `fid`/`oid`, prefers `/tv/api/component` metadata and the highest quality available without login, and falls back to matching page/CDN media. Visitor checks without login or expiring CDN URLs may require a retry or `--headed` mode.
- Platform plugins are discovered from `scripts/platforms/*.js` and `scripts/platforms/<id>/index.js`; a single plugin load failure is reported and isolated.
- Downloaded or merged MP4 files must contain both video and audio tracks; otherwise the item is retried instead of producing a misleading success.
- Short share links can expire or redirect to unrelated feed pages; if that happens, use the canonical platform URL when available.
- First Whisper model use downloads ~500 MB — this is normal, not a hang.
- Whisper model is loaded once per process and reused across all items.
- **Transcription optimization**: beam_size=5 (beam search) and VAD disabled for higher accuracy. Speed is ~2-3x slower than greedy decoding but significantly reduces hallucinations and errors.
- Whisper with `--language zh` may output Traditional Chinese by default; OpenCC auto-converts to Simplified.
- Transcription is speech-only; OCR of on-screen text is not included.
- Rerun with the same output directory to resume from `download-state.json`.

## Security

- Downloading, ffmpeg processing, faster-whisper transcription, and OpenCC conversion run on the local machine; the program does not call external transcription or correction APIs.
- When Agent review is enabled, transcript text is processed by the current Agent host. Its execution location, retention, and privacy policy apply. If the user requires strict local-only handling or declines Agent access to the TXT, run `reconcile --disable-review`; it records `required=false` with reason `agent_review_disabled_by_user`, and the result must be reported as review disabled.
- Only publicly accessible content is processed.

## Boundaries

- Platforms: Douyin (抖音), Bilibili (B站), Kuaishou (快手), Xiaohongshu (小红书), and Weibo (微博).
- Process only publicly accessible content the user is permitted to access.
- Do not use third-party online parsing or transcription APIs.

Read [references/troubleshooting.md](references/troubleshooting.md) only when setup, verification, or repeated retry failures occur.
Read [references/architecture.md](references/architecture.md) when coordinating review claims, context budgets, checkpoints, recovery, or batch boundaries.
