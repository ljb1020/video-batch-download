# 抖音、B站 & 小红书 批量下载与转写

> 🇺🇸 [English](README.md) | 🇨🇳 中文

批量下载抖音、B站和小红书公开视频并提取文案 —— 完全本地化，无需云 API。

## 功能特性

- 通过 Playwright 浏览器拦截获取视频 CDN URL（不依赖 yt-dlp 或第三方解析 API）
- 支持 **抖音**、**B站（Bilibili）** 和 **小红书** 三大平台
- B站 DASH 格式支持 —— 自动下载并合并分离的视频/音频流
- 通过 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 实现本地语音转文字 —— 无需 API Key，无需联网，完全免费
- 通过 [OpenCC](https://github.com/BYVoid/OpenCC) 自动繁→简中文转换
- 结构化 JSON 元数据（标题、作者、发布时间、播放/点赞/评论/分享/收藏数）
- 保守并行处理 —— 解析可并发，媒体下载与转写默认串行以提高稳定性
- 失败自动重试（指数退避）
- 断点续传：重跑同一命令自动跳过已完成项
- 实时进度输出

## 前置条件

- Node.js 20+
- Python 3.10+
- [ffmpeg](https://ffmpeg.org/)（需要在 PATH 中）

## 安装

### 1. 安装 Node.js 依赖

```bash
npm install
node scripts/setup.mjs
```

`setup.mjs` 验证 Playwright 环境，仅在需要时安装 Chromium。

### 2. 安装 Python 依赖（用于转写）

```bash
pip install -U faster-whisper opencc
```

### 3. 作为 Agent Skill 使用

**方式一：直接跟 AI 说（最省事）**

> "帮我安装这个 skill：https://github.com/ljb1020/video-batch-download"

**方式二：git clone**

```bash
# Linux/macOS
git clone https://github.com/ljb1020/video-batch-download.git ~/.claude/skills/video-batch-download

# Windows
git clone https://github.com/ljb1020/video-batch-download.git %USERPROFILE%\.claude\skills\video-batch-download
```

## 使用方法

### 命令行（CLI）

```bash
# 单个链接（抖音、B站或小红书）
node scripts/download.mjs "https://v.douyin.com/xxxxx"
node scripts/download.mjs "https://www.bilibili.com/video/BVxxxxx"
node scripts/download.mjs "https://www.xiaohongshu.com/explore/xxxxx"

# 多个链接（支持混合平台）
node scripts/download.mjs "url1" "url2" "url3"

# 自定义输出目录
node scripts/download.mjs "url" --output ./my_output

# 从文本文件读取链接
node scripts/download.mjs --input links.txt --output ./video_results

# 跳过转写（仅下载元数据）
node scripts/download.mjs "url" --no-transcribe

# GPU 加速 + 高精度模型
node scripts/download.mjs "url" --device cuda --compute-type float16 --model large-v3
```

### 在 Claude Code 中使用

直接粘贴抖音、B站或小红书链接并要求提取文案：

> "帮我提取这个抖音视频的文案 https://v.douyin.com/xxxxx"
> "提取这个B站视频的语音 https://www.bilibili.com/video/BVxxxxx"
> "下载这个小红书视频 http://xhslink.com/xxxxx"

## 工作原理

```
输入 URL(s)
    ↓
Playwright 浏览器解析 → 提取视频元数据 + 拦截 CDN URL
    ↓
┌─ Worker 1: 下载 MP4 ──┐
├─ Worker 2: 下载 MP4 ──┤  （默认串行，可配置）
└─ Worker 3: 下载 MP4 ──┘
    ↓
（B站 DASH: ffmpeg 合并视频+音频流）
    ↓
ffmpeg 提取音频 → 16kHz mono WAV
    ↓
faster-whisper 语音转文字（模型复用，CUDA 默认保守配置）
    ↓
OpenCC 繁→简中文转换
    ↓
输出：JSON + TXT
```

## 输出结果

每个视频一个独立目录：

```
video_results/
  ├── 2026_06_24_21-30-00_抖音_张三_740123456789/
  │   ├── 2026_06_24_21-30-00_抖音_张三_740123456789.json
  │   └── 2026_06_24_21-30-00_抖音_张三_740123456789_transcript.txt
  ├── 2026_06_24_21-31-00_B站_李四_BV1xx411c7mD/
  │   └── ...
  └── download-summary.json
```

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
    "model": "small",
    "language": "zh",
    "language_probability": 0.98,
    "device": "cpu",
    "compute_type": "int8"
  }
}
```

## CLI 参数

### 下载参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--input <file>` | — | 从 UTF-8 文本文件读取链接 |
| `--output <dir>` | `./video_results` | 输出目录 |
| `--parse-concurrency <n>` | `1` | 并发浏览器解析数 |
| `--download-concurrency <n>` | `1` | 并发下载数（默认串行以提高稳定性） |
| `--max-attempts <n>` | `10` | 每条链接重试次数（0 = 无限重试） |
| `--page-timeout <secs>` | `45` | 页面导航超时 |
| `--media-wait <secs>` | `25` | 等待媒体响应时间 |
| `--download-timeout <secs>` | `900` | 单个文件下载超时 |
| `--headed` | 关闭 | 显示浏览器窗口 |
| `--storage-state <file>` | — | Playwright storage-state JSON |

### 转写参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--no-transcribe` | 关闭 | 跳过 Whisper 转写 |
| `--model <name>` | `small` | Whisper 模型（`small`, `medium`, `large-v3`） |
| `--language <code>` | `auto` | 语言代码，`auto` = 自动检测 |
| `--device <cpu\|cuda>` | `cpu` | 转写设备 |
| `--compute-type <type>` | `int8` | 精度（`int8`, `float16`, `float32`） |
| `--no-simplify` | 关闭 | 跳过繁→简转换 |
| `--ffmpeg-path <path>` | 自动 | ffmpeg 可执行文件路径 |
| `--transcribe-timeout <secs>` | `600` | 单次转写超时 |

## 本工具的特性

- 支持抖音、B站和小红书三大平台的视频下载
- 抖音：拦截 detail API 获取元数据，拦截 CDN 获取视频 URL
- B站：拦截 view/playurl API 获取元数据和流媒体 URL，自动处理 DASH 格式
- 小红书：拦截 feed/note API 获取元数据，拦截 xhscdn.com CDN 获取视频 URL
- 使用 faster-whisper（本地离线）将音频转为文字
- 将繁体中文输出转换为简体中文
- 本地保存结构化 JSON 和纯文本转写

## 本工具不做的事

- 不会向外部服务或 API 发送任何数据
- 不会上传你的媒体或转写内容
- 不会处理私有或需要登录的内容
- 不会进行屏幕文字 OCR（仅限语音转写）

## 限制说明

- 首次使用 Whisper 模型会下载约 500 MB —— 这是正常现象，不是卡住
- CPU 转写：1 分钟音频约 12 秒（GPU：约 0.4 秒）
- 部分视频可能触发验证码 —— 使用 `--headed` 模式
- B站高画质视频需要 ffmpeg 合并 DASH 流
- 小红书仅支持视频笔记，不支持图文笔记

## 参考文档

- [架构与设计说明](references/architecture.md)
- [新平台开发与维护规范](references/platform-development.md)
- [故障排查](references/troubleshooting.md)

## 致谢

感谢 [LINUX DO](https://linux.do/) 社区的开源氛围与佬友反馈。

## 开源协议

[MIT](LICENSE)
