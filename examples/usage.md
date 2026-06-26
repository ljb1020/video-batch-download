# Example: Extract transcript from a single Douyin video

## Input

```bash
node scripts/download.mjs "https://v.douyin.com/iRNBho5/"
```

## Terminal output (stderr)

```
[batch] 1 unique URL(s), parse concurrency 3, download concurrency 1, transcribe on (concurrency 3, small, cpu), output ./douyin_results
[1/1] parse attempt 1/10: https://v.douyin.com/iRNBho5/
[1/1] extracting audio...
[1/1] transcribing (small, cpu)...
[1/1] complete (3829104 bytes, transcribed): douyin_results/2026_06_24_21-30-00_抖音_张三_740123456789/...json
```

## Output files

```
douyin_results/
  └── 2026_06_24_21-30-00_抖音_张三_740123456789/
      ├── 2026_06_24_21-30-00_抖音_张三_740123456789.json
      └── 2026_06_24_21-30-00_抖音_张三_740123456789_transcript.txt
```

## Example: Batch processing

```bash
node scripts/download.mjs \
  "https://v.douyin.com/abc123" \
  "https://v.douyin.com/def456" \
  "https://v.douyin.com/ghi789" \
  --output ./my_results
```

## Example: GPU acceleration with high accuracy

```bash
node scripts/download.mjs "https://v.douyin.com/abc123" \
  --device cuda \
  --compute-type float16 \
  --model large-v3
```

## Example: Skip transcription

```bash
node scripts/download.mjs "url1" "url2" "url3" --no-transcribe
```
