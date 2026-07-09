<p align="center">
  <img src="docs/assets/banner.png" alt="Video Batch Download" width="100%" />
</p>

<h1 align="center">Video Batch Download</h1>

<p align="center">
  <b>Download public videos into transcripts and structured data.</b>
</p>

<p align="center"><img src="docs/assets/lang-en-active.svg" alt="English" width="88" height="28" />&nbsp;&nbsp;<a href="README_zh.md"><img src="docs/assets/lang-zh.svg" alt="中文" width="88" height="28" /></a></p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20%2B-brightgreen" alt="Node.js 20+" />
  <img src="https://img.shields.io/badge/Python-3.10%2B-blue" alt="Python 3.10+" />
  <img src="https://img.shields.io/badge/Local--first-No%20Cloud%20API-7c3aed" alt="Local-first" />
  <img src="https://img.shields.io/badge/License-MIT-black" alt="MIT License" />
</p>

## Quick Start

```bash
git clone https://github.com/ljb1020/video-batch-download.git
cd video-batch-download

npm install
node scripts/setup.mjs

pip install -U faster-whisper opencc
```

Also requires [ffmpeg](https://ffmpeg.org/) on `PATH`.

Download and transcribe one video:

```bash
node scripts/download.mjs "https://v.douyin.com/xxxxx"
```

Skip transcription (download video and metadata only):

```bash
node scripts/download.mjs "https://v.douyin.com/xxxxx" --no-transcribe
```

## Use as an Agent Skill

Tell your AI assistant:

> Install this skill: https://github.com/ljb1020/video-batch-download

Or install manually:

```bash
# Linux/macOS
git clone https://github.com/ljb1020/video-batch-download.git ~/.claude/skills/video-batch-download

# Windows
git clone https://github.com/ljb1020/video-batch-download.git %USERPROFILE%\.claude\skills\video-batch-download
```

In Claude Code, paste a public video link and ask for download or transcript extraction:

> "帮我提取这个抖音视频的文案 https://v.douyin.com/xxxxx"  
> "提取这个B站视频的语音 https://www.bilibili.com/video/BVxxxxx"  
> "下载这个小红书视频 http://xhslink.com/xxxxx"

## Supported Platforms

| Platform       |       Status | Notes                                      |
| -------------- | -----------: | ------------------------------------------ |
| Douyin         | ✅ Supported | Public video links                         |
| Bilibili       | ✅ Supported | Public videos, DASH merge supported        |
| Xiaohongshu    | ✅ Supported | Video notes only                           |
| More platforms |      Planned | The platform adapter layer can be extended |

## Features

- **Multi-platform video download** — supports public videos from currently integrated platforms.
- **Browser-based extraction** — captures media URLs via Playwright, without yt-dlp or third-party parsing APIs.
- **Local transcription** — uses [faster-whisper](https://github.com/SYSTRAN/faster-whisper) to generate transcripts without cloud APIs; optional Traditional→Simplified conversion via [OpenCC](https://github.com/BYVoid/OpenCC).
- **Structured output** — saves metadata, transcript text, and JSON output locally.
- **Bilibili DASH support** — downloads and merges separated video/audio streams with ffmpeg.
- **Resumable workflow** — reruns can skip completed downloads and existing transcripts; failed items auto-retry with exponential backoff.
- **Agent Skill ready** — can be installed as a Claude/Codex-style assistant skill.

## Prerequisites

- Node.js 20+
- Python 3.10+
- [ffmpeg](https://ffmpeg.org/) (must be on `PATH`)

The default transcription profile is `medium + cuda + float16 + zh`, which works best on machines with a usable NVIDIA CUDA environment.  
If CUDA is unavailable or default transcription startup fails, run with:

```bash
--device cpu --compute-type int8 --model small
```

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

If you only need download and metadata, you can skip Python dependencies and always pass `--no-transcribe`.

## Usage

### Download one video

```bash
node scripts/download.mjs "https://v.douyin.com/xxxxx"
node scripts/download.mjs "https://www.bilibili.com/video/BVxxxxx"
node scripts/download.mjs "https://www.xiaohongshu.com/explore/xxxxx"
```

### Download multiple videos

```bash
# Mixed platforms are supported
node scripts/download.mjs "url1" "url2" "url3"

# Custom output directory
node scripts/download.mjs "url" --output ./my_output
```

### Read links from a file

```bash
node scripts/download.mjs --input links.txt --output ./video_results
```

### Skip transcription

```bash
node scripts/download.mjs "url" --no-transcribe
```

`--no-transcribe` still saves the MP4 next to the JSON by default.

### Do not copy video into item folders

```bash
node scripts/download.mjs "url" --no-video-output
```

The final MP4 stays in `<output>/.temp/` as reusable cache, but is not copied into each video result folder. Clear the cache when you no longer need it:

```bash
node scripts/download.mjs --clear-temp --output ./video_results
```

### Use GPU transcription

```bash
node scripts/download.mjs "url" --device cuda --compute-type float16 --model large-v3
```

### CPU fallback

```bash
node scripts/download.mjs "url" --device cpu --compute-type int8 --model small
```

### Visible browser for verification challenges

```bash
node scripts/download.mjs --input links.txt --output ./downloads --headed
```

## How It Works

```txt
Video URL(s)
    ↓
Playwright opens the page and detects media URLs
    ↓
Download video / audio streams into <output>/.temp cache
    ↓
Merge DASH streams with ffmpeg when needed
    ↓
Extract audio and transcribe with faster-whisper
    ↓
Save MP4, metadata JSON, and TXT transcript locally
```

Parse and download concurrency default to `1` for stability and can be raised with CLI flags. The Whisper model is loaded once per process and reused across items.

## Output

Each video gets its own subdirectory:

```txt
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

By default, the final MP4 is copied into the per-video folder as a user-facing artifact. The `.temp` directory is a reusable media cache for resume/retry workflows. If you pass `--no-video-output`, the MP4 remains only in `.temp`; clear it later with `--clear-temp` when you want to free disk space.

Rerun with the same output directory to resume from `download-state.json`.

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
		"compute_type": "float16"
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

## CLI Options

<details>
<summary>Download options</summary>

| Parameter                    | Default           | Description                                                  |
| ---------------------------- | ----------------- | ------------------------------------------------------------ |
| `--input <file>`             | —                 | Read URLs from a UTF-8 text file                             |
| `--output <dir>`             | `./video_results` | Output directory                                             |
| `--parse-concurrency <n>`    | `1`               | Concurrent browser parsers                                   |
| `--download-concurrency <n>` | `1`               | Concurrent media downloads (serial by default for stability) |
| `--max-attempts <n>`         | `10`              | Retry attempts per item (0 = infinite)                       |
| `--page-timeout <secs>`      | `45`              | Page navigation timeout                                      |
| `--media-wait <secs>`        | `25`              | Wait for media response after navigation                     |
| `--download-timeout <secs>`  | `900`             | Total download timeout per file                              |
| `--no-video-output`          | off               | Keep MP4 only in `.temp` cache instead of copying it into each item folder |
| `--clear-temp`               | off               | Delete `<output>/.temp` cache and exit                       |
| `--headed`                   | off               | Show browser window                                          |
| `--storage-state <file>`     | —                 | Playwright storage-state JSON                                |

</details>

<details>
<summary>Transcription options</summary>

| Parameter                     | Default   | Description                                   |
| ----------------------------- | --------- | --------------------------------------------- |
| `--no-transcribe`             | off       | Skip Whisper transcription                    |
| `--model <name>`              | `medium`  | Whisper model (`small`, `medium`, `large-v3`) |
| `--language <code>`           | `zh`      | Language code, `auto` = auto-detect           |
| `--device <cpu\|cuda>`        | `cuda`    | Transcription device                          |
| `--compute-type <type>`       | `float16` | Precision (`int8`, `float16`, `float32`)      |
| `--no-simplify`               | off       | Skip Traditional→Simplified conversion        |
| `--ffmpeg-path <path>`        | auto      | Path to ffmpeg executable                     |
| `--transcribe-timeout <secs>` | `600`     | Timeout per transcription                     |

</details>

## Scope and Limitations

This tool is designed for public video content and local processing. It downloads public videos, extracts metadata, and optionally transcribes speech locally.

It does not:

- upload media or transcripts to external services
- process private or login-required content
- bypass platform access controls
- perform OCR on visual text

Additional practical limits:

- First Whisper model use downloads ~500 MB — this is normal, not a hang
- CPU transcription: ~12 seconds per minute of audio (GPU: ~0.4 seconds)
- Some videos may require verification challenges — use `--headed` mode
- Bilibili high-quality videos require ffmpeg for DASH stream merging
- Xiaohongshu image/text notes are not supported (video notes only)
- Transcription is speech-only; on-screen text is not captured

## Reference Docs

- [Architecture and design](references/architecture.md)
- [Platform development guide](references/platform-development.md)
- [Troubleshooting](references/troubleshooting.md)

## Acknowledgements

Thanks to the [LINUX DO](https://linux.do/) community for its open-source spirit and feedback from fellow members.

## License

[MIT](LICENSE)
