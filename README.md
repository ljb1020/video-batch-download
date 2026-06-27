# Douyin, Bilibili & Xiaohongshu Batch Download & Transcribe

> [🇺🇸 English](README.md) | [🇨🇳 中文](README_zh.md)

Download public videos from Douyin, Bilibili and Xiaohongshu, extract transcripts — fully locally, no cloud APIs.

## Features

- Browser-based video URL interception via Playwright (no yt-dlp, no third-party APIs)
- Supports **Douyin (抖音)**, **Bilibili (B站)** and **Xiaohongshu (小红书)** platforms
- Bilibili DASH format support — automatically downloads and merges separate video/audio streams
- Local speech-to-text via [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — no API key, no network, fully free
- Automatic Traditional → Simplified Chinese conversion via [OpenCC](https://github.com/BYVoid/OpenCC)
- Structured JSON metadata (title, author, post time, stats)
- Parallel parsing with conservative defaults — media downloads and transcription run serially by default for stability
- Failed items auto-retry with exponential backoff
- Resumable: rerun the same command to skip completed items
- Real-time progress output

## Prerequisites

- Node.js 20+
- Python 3.10+
- [ffmpeg](https://ffmpeg.org/) (must be on PATH)

## Installation

### 1. Install Node.js dependencies

```bash
npm install
node scripts/setup.mjs
```

`setup.mjs` verifies Playwright and installs Chromium only when needed.

### 2. Install Python dependencies (for transcription)

```bash
pip install -U faster-whisper opencc
```

### 3. As an Agent Skill

**Option A: Tell your AI assistant (easiest)**

> "Install this skill: https://github.com/ljb1020/video-batch-download"

**Option B: git clone**

```bash
# Linux/macOS
git clone https://github.com/ljb1020/video-batch-download.git ~/.claude/skills/video-batch-download

# Windows
git clone https://github.com/ljb1020/video-batch-download.git %USERPROFILE%\.claude\skills\video-batch-download
```

## Usage

### CLI

```bash
# Single URL (Douyin, Bilibili, or Xiaohongshu)
node scripts/download.mjs "https://v.douyin.com/xxxxx"
node scripts/download.mjs "https://www.bilibili.com/video/BVxxxxx"
node scripts/download.mjs "https://www.xiaohongshu.com/explore/xxxxx"

# Multiple URLs (mixed platforms supported)
node scripts/download.mjs "url1" "url2" "url3"

# Custom output directory
node scripts/download.mjs "url" --output ./my_output

# From a text file
node scripts/download.mjs --input links.txt --output ./douyin_results

# Skip transcription (download metadata only)
node scripts/download.mjs "url" --no-transcribe

# GPU acceleration with high accuracy
node scripts/download.mjs "url" --device cuda --compute-type float16 --model large-v3
```

### In Claude Code

Paste Douyin, Bilibili or Xiaohongshu links and ask for transcript extraction:

> "帮我提取这个抖音视频的文案 https://v.douyin.com/xxxxx"
> "提取这个B站视频的语音 https://www.bilibili.com/video/BVxxxxx"
> "下载这个小红书视频 http://xhslink.com/xxxxx"

## How it works

```
Input URL(s)
    ↓
Playwright browser → parse video metadata + intercept CDN URL
    ↓
┌─ Worker 1: download MP4 ──┐
├─ Worker 2: download MP4 ──┤  (serial by default, configurable)
└─ Worker 3: download MP4 ──┘
    ↓
(Bilibili DASH: merge video+audio streams with ffmpeg)
    ↓
ffmpeg extract audio → 16kHz mono WAV
    ↓
faster-whisper speech-to-text (model reused, conservative CUDA default)
    ↓
OpenCC Traditional → Simplified Chinese
    ↓
Output: JSON + TXT
```

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
  }
}
```

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

## What this tool does

- Downloads public Douyin videos via browser-based CDN URL interception
- Downloads public Bilibili videos (including DASH format with separate video/audio streams)
- Downloads public Xiaohongshu video notes
- Extracts metadata (title, author, post time, stats) from platform APIs
- Transcribes audio to text using local faster-whisper
- Converts Traditional Chinese output to Simplified Chinese
- Saves structured JSON and plain text transcript locally

## What this tool does NOT do

- Does not send any data to external services or APIs
- Does not upload your media or transcripts
- Does not process private or login-required content
- Does not perform OCR on on-screen text (speech transcription only)

## Limitations

- First Whisper model use downloads ~500 MB — this is normal, not a hang
- CPU transcription: ~12 seconds per minute of audio (GPU: ~0.4 seconds)
- Some videos may require verification challenges — use `--headed` mode
- Bilibili high-quality videos require ffmpeg for DASH stream merging
- Xiaohongshu image/text notes are not supported (video notes only)

## Reference docs

- [Architecture and design](references/architecture.md)
- [Platform development guide](references/platform-development.md)
- [Troubleshooting](references/troubleshooting.md)

## Acknowledgements

Thanks to the [LINUX DO](https://linux.do/) community for its open-source spirit and feedback from fellow members.

## License

[MIT](LICENSE)
