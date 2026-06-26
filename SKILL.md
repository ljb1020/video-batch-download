---
name: video-batch-download
description: "Use this skill when the user provides 抖音 (Douyin), B站 (Bilibili), or 小红书 (Xiaohongshu) video URLs and wants to download videos, extract metadata, transcribe audio with local Whisper, convert Traditional→Simplified Chinese, or get structured transcripts as JSON/TXT."
license: MIT
metadata:
    version: "3.1.0"
---

# Video Batch Download & Transcribe (Douyin, Bilibili & Xiaohongshu)

Download public videos from Douyin, Bilibili and Xiaohongshu, extract transcripts — fully locally, no cloud APIs.

## When to use

- User pastes one or more 抖音, B站, or 小红书 links and wants the spoken content as text
- User says "提取文案", "语音转文字", "下载抖音视频", "下载B站视频", "下载小红书视频", or gives a Douyin/Bilibili/Xiaohongshu URL
- User wants structured metadata (title, author, stats, post time) from Douyin, Bilibili or Xiaohongshu posts
- User wants batch download and/or transcription of videos from Douyin, Bilibili or Xiaohongshu

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

## Workflow

1. **Receive URLs** — User provides one or more Douyin, Bilibili or Xiaohongshu links (or share text containing links). The script auto-extracts valid URLs from any text and routes them to the appropriate platform parser.
2. **Ask for output directory** — If user doesn't specify, default to `./video_results/`.
3. **Run the script** — Parallel pipeline:
    - Parse video metadata via Playwright browser interception (parallel, concurrency 3)
    - Download MP4 via CDN URL (concurrency 1 by default for stability). For Bilibili DASH format, downloads video and audio streams separately and merges with ffmpeg.
    - Extract audio with ffmpeg → transcribe with local faster-whisper (model reused, conservative CUDA default)
    - Convert Traditional Chinese to Simplified via OpenCC
    - Write structured JSON + plain text transcript
4. **Report results** — Real-time progress on stderr + final JSON summary on stdout.

## Usage

### Single URL (or share text with embedded URL)

```bash
node scripts/download.mjs "https://v.douyin.com/xxxxx"
node scripts/download.mjs "https://www.xiaohongshu.com/explore/xxxxx"
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
node scripts/download.mjs "https://v.douyin.com/xxxxx" "https://www.bilibili.com/video/BVxxxxx" "http://xhslink.com/xxxxx"
```

### From a text file

```bash
node scripts/download.mjs --input links.txt --output ./video_results
```

### Skip transcription (download metadata only)

```bash
node scripts/download.mjs "url" --no-transcribe
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

## CLI Options

### Download options

| Parameter | Default | Description |
|---|---|---|
| `--input <file>` | — | Read URLs from a UTF-8 text file |
| `--output <dir>` | `./video_results` | Output directory |
| `--parse-concurrency <n>` | `3` | Concurrent browser parsers |
| `--download-concurrency <n>` | `1` | Concurrent media downloads (serial by default for stability) |
| `--max-attempts <n>` | `10` | Retry attempts per item (0 = infinite) |
| `--page-timeout <secs>` | `45` | Page navigation timeout |
| `--media-wait <secs>` | `25` | Wait for media response after navigation |
| `--download-timeout <secs>` | `900` | Total download timeout per file |
| `--headed` | off | Show browser window |
| `--storage-state <file>` | — | Playwright storage-state JSON |

### Transcription options

| Parameter | Default | Description |
|---|---|---|
| `--no-transcribe` | off | Skip Whisper transcription |
| `--model <name>` | `small` | Whisper model (`small`, `medium`, `large-v3`) |
| `--language <code>` | `auto` | Language code, `auto` = auto-detect |
| `--device <cpu\|cuda>` | `cpu` | Transcription device |
| `--compute-type <type>` | `int8` | Precision (`int8`, `float16`, `float32`) |
| `--no-simplify` | off | Skip Traditional→Simplified conversion |
| `--ffmpeg-path <path>` | auto | Path to ffmpeg executable |
| `--transcribe-timeout <secs>` | `600` | Timeout per transcription |
| `--transcribe-concurrency <n>` | `3` (cpu) / `1` (cuda) | Parallel transcriptions |

## Output format

Each video gets its own subdirectory:

```
video_results/
  ├── 2026_06_24_21-30-00_抖音_张三_740123456789/
  │   ├── 2026_06_24_21-30-00_抖音_张三_740123456789.json
  │   └── 2026_06_24_21-30-00_抖音_张三_740123456789_transcript.txt
  ├── 2026_06_24_21-31-00_B站_李四_BV1xx411c7mD/
  │   └── ...
  └── download-summary.json
```

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
    "model": "small",
    "language": "zh",
    "language_probability": 0.98,
    "device": "cpu",
    "compute_type": "int8"
  },
  "media_info": {
    "width": 1080,
    "height": 1920,
    "resolution": "1080x1920",
    "bitrate_kbps": 2500,
    "duration_secs": 125.5,
    "codec": "h264",
    "format": "mov,mp4,m4a,3gp,3g2,mj2"
  }
}
```

## Important notes

- Supports Douyin (抖音), Bilibili (B站), and Xiaohongshu (小红书) platforms
- Bilibili high-quality videos use DASH format (separate video/audio streams) — automatically merged with ffmpeg
- Xiaohongshu: video notes only; image/text notes are not supported
- First Whisper model use downloads ~500 MB — this is normal, not a hang.
- Whisper model is loaded once per process and reused across all items.
- **Transcription optimization**: beam_size=5 (beam search) and VAD disabled for higher accuracy. Speed is ~2-3x slower than greedy decoding but significantly reduces hallucinations and errors.
- Whisper with `--language zh` may output Traditional Chinese by default; OpenCC auto-converts to Simplified.
- Transcription is speech-only; OCR of on-screen text is not included.
- Rerun with the same output directory to resume from `download-state.json`.

## Security

- All processing is local — no data is sent to external services.
- Only publicly accessible content is processed.

## Boundaries

- Platforms: Douyin (抖音), Bilibili (B站), and Xiaohongshu (小红书).
- Process only publicly accessible content the user is permitted to access.
- Do not use third-party online parsing or transcription APIs.

Read [references/troubleshooting.md](references/troubleshooting.md) only when setup, verification, or repeated retry failures occur.
