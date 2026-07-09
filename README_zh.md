<p align="center">
  <img src="docs/assets/banner.png" alt="Video Batch Download" width="100%" />
</p>

<h1 align="center">Video Batch Download</h1>

<p align="center">
  <b>公开视频一键下载，本地生成文案和结构化数据。</b>
</p>

<p align="center"><a href="README.md"><img src="docs/assets/lang-en.svg" alt="English" width="88" height="28" /></a>&nbsp;&nbsp;<img src="docs/assets/lang-zh-active.svg" alt="中文" width="88" height="28" /></p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20%2B-brightgreen" alt="Node.js 20+" />
  <img src="https://img.shields.io/badge/Python-3.10%2B-blue" alt="Python 3.10+" />
  <img src="https://img.shields.io/badge/Local--first-No%20Cloud%20API-7c3aed" alt="Local-first" />
  <img src="https://img.shields.io/badge/License-MIT-black" alt="MIT License" />
</p>

## 快速开始

```bash
git clone https://github.com/ljb1020/video-batch-download.git
cd video-batch-download

npm install
node scripts/setup.mjs

pip install -U faster-whisper opencc
```

同时需要系统已安装 [ffmpeg](https://ffmpeg.org/)，并确保可在 `PATH` 中调用。

下载并转写一个视频：

```bash
node scripts/download.mjs "https://v.douyin.com/xxxxx"
```

跳过转写，只下载视频和元数据：

```bash
node scripts/download.mjs "https://v.douyin.com/xxxxx" --no-transcribe
```

## 作为 Agent Skill 使用

直接对你的 AI 助手说：

> 帮我安装这个 skill：https://github.com/ljb1020/video-batch-download

或者手动安装：

```bash
# Linux/macOS
git clone https://github.com/ljb1020/video-batch-download.git ~/.claude/skills/video-batch-download

# Windows
git clone https://github.com/ljb1020/video-batch-download.git %USERPROFILE%\.claude\skills\video-batch-download
```

在 Claude Code 中，直接粘贴公开视频链接并要求下载或提取文案：

> "帮我提取这个抖音视频的文案 https://v.douyin.com/xxxxx"  
> "提取这个B站视频的语音 https://www.bilibili.com/video/BVxxxxx"  
> "下载这个小红书视频 http://xhslink.com/xxxxx"

## 支持平台

| 平台           |      状态 | 说明                         |
| -------------- | --------: | ---------------------------- |
| 抖音           | ✅ 已支持 | 公开视频链接                 |
| B站 / Bilibili | ✅ 已支持 | 支持公开视频，支持 DASH 合并 |
| 小红书         | ✅ 已支持 | 目前支持视频笔记             |
| 更多平台       |    计划中 | 后续可通过平台适配层扩展     |

## 功能特性

- **多平台视频下载**：支持已接入平台的公开视频链接。
- **浏览器拦截提取**：通过 Playwright 捕获媒体地址，不依赖 yt-dlp 或第三方解析 API。
- **本地语音转写**：通过 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 在本地生成文案，不依赖云 API；可选 [OpenCC](https://github.com/BYVoid/OpenCC) 繁→简转换。
- **结构化输出**：保存视频元数据、TXT 文案和 JSON 结果。
- **B站 DASH 支持**：自动下载并通过 ffmpeg 合并分离的视频/音频流。
- **断点续跑**：重复运行时可跳过已完成下载和已有转写结果；失败项支持指数退避重试。
- **Agent Skill 可用**：可作为 Claude / Codex 类助手的 Skill 使用。

## 前置条件

- Node.js 20+
- Python 3.10+
- [ffmpeg](https://ffmpeg.org/)（需要在 `PATH` 中）

默认转写配置为 `medium + cuda + float16 + zh`，更适合具备可用 NVIDIA CUDA 环境的电脑。  
如果你的电脑不支持 CUDA，或默认转写启动失败，建议显式改用：

```bash
--device cpu --compute-type int8 --model small
```

## 安装

### 1. 安装 Node.js 依赖

```bash
npm install
node scripts/setup.mjs
```

`setup.mjs` 会验证 Playwright 环境，并仅在需要时安装 Chromium。

### 2. 安装 Python 依赖（用于转写）

```bash
pip install -U faster-whisper opencc
```

如果只需要下载视频和元数据，可以不装 Python 依赖，并始终加上 `--no-transcribe`。

## 使用方法

### 下载单个视频

```bash
node scripts/download.mjs "https://v.douyin.com/xxxxx"
node scripts/download.mjs "https://www.bilibili.com/video/BVxxxxx"
node scripts/download.mjs "https://www.xiaohongshu.com/explore/xxxxx"
```

### 批量下载多个视频

```bash
# 支持混合平台
node scripts/download.mjs "url1" "url2" "url3"

# 自定义输出目录
node scripts/download.mjs "url" --output ./my_output
```

### 从文本文件读取链接

```bash
node scripts/download.mjs --input links.txt --output ./video_results
```

### 跳过转写

```bash
node scripts/download.mjs "url" --no-transcribe
```

`--no-transcribe` 默认仍会把 MP4 和 JSON 放在同一个视频结果目录中。

### 不将视频放入结果目录

```bash
node scripts/download.mjs "url" --no-video-output
```

最终 MP4 会留在 `<output>/.temp/` 作为可复用缓存，但不会复制到每个视频结果目录。需要释放空间时，可以清理缓存：

```bash
node scripts/download.mjs --clear-temp --output ./video_results
```

### 使用 GPU 转写

```bash
node scripts/download.mjs "url" --device cuda --compute-type float16 --model large-v3
```

### CPU 兼容模式

```bash
node scripts/download.mjs "url" --device cpu --compute-type int8 --model small
```

### 有头模式处理验证码

```bash
node scripts/download.mjs --input links.txt --output ./downloads --headed
```

## 工作流程

```txt
视频链接
    ↓
Playwright 打开页面并捕获媒体地址
    ↓
下载视频 / 音频流到 <output>/.temp 缓存
    ↓
必要时通过 ffmpeg 合并 DASH 流
    ↓
提取音频并通过 faster-whisper 本地转写
    ↓
保存 MP4、元数据 JSON 和 TXT 文案
```

解析与下载默认并发为 `1`，更稳定，可通过 CLI 参数提高。Whisper 模型在进程内加载一次并复用。

## 输出结果

每个视频一个独立目录：

```txt
video_results/
  ├── .temp/                              # 可复用媒体缓存
  │   └── 抖音_740123456789_a1b2c3d4e5f6.mp4
  ├── 2026_06_24_21-30-00_抖音_张三_740123456789/
  │   ├── 2026_06_24_21-30-00_抖音_张三_740123456789.mp4
  │   ├── 2026_06_24_21-30-00_抖音_张三_740123456789.json
  │   └── 2026_06_24_21-30-00_抖音_张三_740123456789_transcript.txt
  ├── 2026_06_24_21-31-00_B站_李四_BV1xx411c7mD/
  │   └── ...
  └── download-summary.json
```

默认情况下，最终 MP4 会复制到每个视频目录，作为用户可见的正式产物。`.temp` 是可复用媒体缓存，用于断点续传、失败重试和后续补处理。如果传入 `--no-video-output`，MP4 只保留在 `.temp`，不会进入视频结果目录；不需要缓存时可用 `--clear-temp` 清理。

使用同一输出目录重跑时，会复用 `download-state.json` 做断点续传。

### JSON 格式

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

## 命令行参数

<details>
<summary>下载参数</summary>

| 参数                         | 默认值            | 说明                               |
| ---------------------------- | ----------------- | ---------------------------------- |
| `--input <file>`             | —                 | 从 UTF-8 文本文件读取链接          |
| `--output <dir>`             | `./video_results` | 输出目录                           |
| `--parse-concurrency <n>`    | `1`               | 并发浏览器解析数                   |
| `--download-concurrency <n>` | `1`               | 并发下载数（默认串行以提高稳定性） |
| `--max-attempts <n>`         | `10`              | 每条链接重试次数（0 = 无限重试）   |
| `--page-timeout <secs>`      | `45`              | 页面导航超时                       |
| `--media-wait <secs>`        | `25`              | 等待媒体响应时间                   |
| `--download-timeout <secs>`  | `900`             | 单个文件下载超时                   |
| `--no-video-output`          | 关闭              | MP4 只保留在 `.temp` 缓存，不复制到每个视频目录 |
| `--clear-temp`               | 关闭              | 删除 `<output>/.temp` 缓存并退出   |
| `--headed`                   | 关闭              | 显示浏览器窗口                     |
| `--storage-state <file>`     | —                 | Playwright storage-state JSON      |

</details>

<details>
<summary>转写参数</summary>

| 参数                          | 默认值    | 说明                                          |
| ----------------------------- | --------- | --------------------------------------------- |
| `--no-transcribe`             | 关闭      | 跳过 Whisper 转写                             |
| `--model <name>`              | `medium`  | Whisper 模型（`small`, `medium`, `large-v3`） |
| `--language <code>`           | `zh`      | 语言代码，`auto` = 自动检测                   |
| `--device <cpu\|cuda>`        | `cuda`    | 转写设备                                      |
| `--compute-type <type>`       | `float16` | 精度（`int8`, `float16`, `float32`）          |
| `--no-simplify`               | 关闭      | 跳过繁→简转换                                 |
| `--ffmpeg-path <path>`        | 自动      | ffmpeg 可执行文件路径                         |
| `--transcribe-timeout <secs>` | `600`     | 单次转写超时                                  |

</details>

## 适用范围与限制

本工具面向公开视频内容和本地处理流程。它会下载公开视频、提取元数据，并可选地在本地进行语音转写。

它不会：

- 上传视频或转写结果到外部服务
- 处理私密内容或强登录内容
- 绕过平台访问控制
- 对画面文字做 OCR

其他实际限制：

- 首次使用 Whisper 模型会下载约 500 MB —— 这是正常现象，不是卡住
- CPU 转写：1 分钟音频约 12 秒（GPU：约 0.4 秒）
- 部分视频可能触发验证码 —— 使用 `--headed` 模式
- B站高画质视频需要 ffmpeg 合并 DASH 流
- 小红书仅支持视频笔记，不支持图文笔记
- 转写仅限语音内容，不包含屏幕文字识别

## 参考文档

- [架构与设计说明](references/architecture.md)
- [新平台开发与维护规范](references/platform-development.md)
- [故障排查](references/troubleshooting.md)

## 致谢

感谢 [LINUX DO](https://linux.do/) 社区的开源氛围与佬友反馈。

## 开源协议

[MIT](LICENSE)
