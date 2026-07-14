# Usage examples

Public links from Douyin, Bilibili, Kuaishou, Xiaohongshu, and Weibo are accepted. For example:

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
[1/1] transcribing (medium, cuda)...
[1/1] complete (3829104 bytes, transcribed): douyin_results/2026_06_24_21-30-00_抖音_张三_740123456789/...json
```

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

The Weibo adapter matches the requested `fid`, selects the highest-quality muxed MP4 exposed by the page, then uses the same download, track-validation, transcription, and output pipeline as every other platform.

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

## Example: CPU fallback for compatibility

```bash
node scripts/download.mjs "https://v.douyin.com/abc123" \
  --device cpu \
  --compute-type int8 \
  --model small
```

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
