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

After successful transcription, an Agent Skill run must review the existing `*_transcript.txt` in place. It may correct only obvious context-confirmable recognition errors, must leave uncertain text unchanged, and must not modify the raw `transcript` or `segments` stored in JSON or create alternate transcript files.

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
