# Video Batch Download & Transcribe — 架构与设计说明

## 一、需求概述

**输入**：一个或多个抖音/B站/小红书分享链接（可从分享文本中自动提取）
**输出**：每条视频的结构化信息，包含平台名、发帖人、发帖时间、视频标题、视频描述、视频文案（语音转文字）

**支持平台**：
- 抖音（Douyin）— 单流 MP4
- B站（Bilibili）— DASH 多流（视频+音频分离）自动合并
- 小红书（Xiaohongshu）— 视频笔记单流 MP4

---

## 二、多平台架构设计（v3.1）

### 2.1 整体架构

```
┌─────────────────────────────────────────────┐
│              输入层（文本/URL）               │
└──────────────────┬──────────────────────────┘
                   ↓
┌─────────────────────────────────────────────┐
│           URL 路由（router.js）              │
│                                             │
│  提取所有 URL → 正则匹配 → 分发到平台解析器   │
│                                             │
│  v.douyin.com → DouyinParser                │
│  bilibili.com/video → BilibiliParser        │
│  xiaohongshu.com / xhslink.com → XiaohongshuParser │
└──────────────────┬──────────────────────────┘
                   ↓
┌─────────────────────────────────────────────┐
│        平台解析器（PlatformParser）           │
│                                             │
│  统一接口：parse(url) → {                    │
│    platform, videoId, title, author,       │
│    mediaStreams: [{url, type, format}]     │
│  }                                          │
│                                             │
│  ├─ DouyinParser (抖音)                     │
│  │   拦截 /aweme/v1/web/aweme/detail/      │
│  │   返回单流：[{url, type: "video+audio"}] │
│  │                                          │
│  ├─ BilibiliParser (B站)                    │
│      拦截 /x/web-interface/view (元数据)    │
│      拦截 /x/player/playurl (视频流)        │
│      返回 DASH 双流或单流 fallback           │
│                                             │
│  └─ XiaohongshuParser (小红书)              │
│      拦截 /api/sns/web/v1/feed 或 note/info │
│      返回单流：[{url, type: "video+audio"}] │
└──────────────────┬──────────────────────────┘
                   ↓
┌─────────────────────────────────────────────┐
│         下载器（download.mjs）               │
│                                             │
│  单流 (video+audio) → 直接下载               │
│                                             │
│  多流 (video + audio) →                     │
│    并行下载 → ffmpeg -c copy 合并            │
│    清理中间文件                              │
└──────────────────┬──────────────────────────┘
                   ↓
         （后续流程：转写、输出 — 平台无关）
```

### 2.2 关键设计决策

| 设计点 | 方案 | 理由 |
|---|---|---|
| 平台识别 | URL 正则匹配 → 静态路由 | 简单、快速、无歧义 |
| 解析器接口 | 统一返回 `mediaStreams[]` | 兼容单流/多流，下游无感知 |
| 多流合并 | ffmpeg `-c copy` 无重编码 | 速度快、无质量损失 |
| Bilibili Referer | 下载时设置平台 referer | 符合 B站 CDN 校验要求 |
| 向后兼容 | StateStore 键、输出格式不变 | 旧批次可断点续传 |

---

## 三、平台特定实现

### 3.1 抖音（DouyinParser）

**API 拦截**：
- `/aweme/v1/web/aweme/detail/` — 元数据（标题/作者/统计/时长）
- `douyinvod.com` CDN — 视频 URL

**输出**：
```js
mediaStreams: [{
  url: "https://v26.douyinvod.com/...",
  type: "video+audio",
  format: "mp4"
}]
```

### 3.2 B站（BilibiliParser）

**API 拦截**：
- `/x/web-interface/view?bvid=...` — 元数据（标题/作者/统计/时长/描述）
- `/x/player/(wbi/)?playurl?...` — 视频流 URL

**DASH 格式处理**：
```js
// 高画质（常见）
mediaStreams: [
  { url: "...", type: "video", format: "m4s", quality: 1080 },
  { url: "...", type: "audio", format: "m4s" }
]

// 低画质 fallback（360p）
mediaStreams: [{
  url: "...",
  type: "video+audio",
  format: "mp4"
}]
```

**下载流程**：
1. 并行下载 `video.m4s` 和 `audio.m4s`
2. `ffmpeg -i video.m4s -i audio.m4s -c copy merged.mp4`
3. 删除中间文件，返回合并后的 MP4

### 3.3 小红书（XiaohongshuParser）

**API 拦截**：
- `/api/sns/web/v1/feed` — 笔记元数据
- `/api/sns/web/v1/note/info` — 笔记详情兜底
- `xhscdn.com` CDN — 视频 URL

**限制**：
- 仅支持视频笔记，不支持图文笔记

**输出**：
```js
mediaStreams: [{
  url: "https://sns-video-*.xhscdn.com/...",
  type: "video+audio",
  format: "mp4"
}]
```

---

## 四、整体技术栈

```
┌────────────────────────────────────────────┐
│                 输入层                       │
│  一个或多个视频分享链接或分享文本（支持抖音/B站/小红书）│
└──────────────────┬─────────────────────────┘
                   ▼
┌────────────────────────────────────────────┐
│         Playwright 浏览器拦截               │
│                                            │
│  真实 Chromium 会话访问视频页面              │
│  拦截平台 API 和 CDN 响应                    │
│    → 提取元数据（标题/作者/时间/统计）       │
│  拦截视频流 CDN 响应                         │
│    → 获取视频下载 URL                       │
│                                            │
│  特点：真实浏览器环境，无需 API Key          │
└──────────────────┬─────────────────────────┘
                   ▼
┌────────────────────────────────────────────┐
│            MP4 下载                          │
│                                            │
│  通过 CDN URL 直接下载 MP4 文件              │
│  默认串行下载，可通过参数提高并发，支持断点续传 │
│  失败自动重试（指数退避）                    │
└──────────────────┬─────────────────────────┘
                   ▼
┌────────────────────────────────────────────┐
│          ffmpeg 音频提取                     │
│                                            │
│  从 MP4 提取音频                             │
│  转换为 16kHz mono s16le WAV                │
│  （Whisper 输入格式）                        │
└──────────────────┬─────────────────────────┘
                   ▼
┌────────────────────────────────────────────┐
│            faster-whisper (本地 ASR)         │
│                                            │
│   将音频转写为文字（带时间戳）               │
│   模型加载一次复用，CUDA 默认保守配置        │
│   模型加载一次，整个批次复用                 │
│                                            │
│   完全本地运行，不依赖任何云端服务            │
└──────────────────┬─────────────────────────┘
                   ▼
┌────────────────────────────────────────────┐
│          OpenCC 繁→简转换                    │
│                                            │
│   Whisper 模型训练语料偏繁体，                │
│   自动将转写结果转为简体中文                  │
│   （可通过 --no-simplify 关闭）              │
└──────────────────┬─────────────────────────┘
                   ▼
┌────────────────────────────────────────────┐
│             结构化输出                       │
│                                            │
│  每个视频一个子目录：                        │
│  - JSON：元数据 + 文案 + 分段时间戳          │
│  - TXT：纯文本转写                          │
│  输出 JSON + TXT                               │
└────────────────────────────────────────────┘
```

---

## 五、核心选型理由

### 5.1 视频下载：Playwright 浏览器拦截（通用）

**为何选它**：

- 真实浏览器环境，与用户手动访问行为一致
- 通过拦截平台 API 和 CDN 响应获取视频 URL
- 无需逆向 API 签名算法，维护成本低
- 支持验证码检测，可切换有头模式处理
- **平台扩展性强**：添加新平台只需实现 `PlatformParser` 接口

**不选的其他方案**：

| 方案 | 放弃原因 |
|------|---------|
| yt-dlp | 抖音/B站反爬频繁，提取器更新滞后 |
| Douyin_TikTok_Download_API | 依赖第三方在线解析服务，不稳定 |
| 手动解析 API | 需要逆向签名算法（抖音 X-Bogus，B站 wbi），维护成本高 |

### 5.2 B站 DASH 流处理：ffmpeg 无重编码合并

**为何这样做**：

- B站高画质视频采用 DASH 格式（视频和音频分离存储）
- `ffmpeg -c copy` 直接复制流，无需重新编码
- 速度快（秒级完成）、无质量损失、CPU 占用低

**不选的其他方案**：

| 方案 | 放弃原因 |
|------|---------|
| 只下载低画质合并流 | 画质差（通常 360p），用户体验不好 |
| 重编码合并 | 耗时长、CPU 占用高、有质量损失 |
| MP4Box 等工具 | 额外依赖，ffmpeg 已是转写必需 |

### 5.3 语音转文字：faster-whisper（本地）

**为何只选本地**：

- 完全免费，无 API 费用
- 数据不上传，隐私安全
- 不依赖网络，离线可用
- 有 GPU 时 1h 音频 ≈ 40s，纯 CPU 也只要约 12min

**不选的其他方案**：

| 方案 | 放弃原因 |
|------|---------|
| Groq Whisper API | 用户要求纯本地，不依赖云端 |
| OpenAI Whisper API | $0.36/h，付费且依赖网络 |
| 阿里云 ASR | 付费、需国内认证、依赖网络 |
| 原版 whisper (openai-whisper) | 比 faster-whisper 慢 4-6 倍，内存高 |

### 5.4 简繁转换：OpenCC

**为何加入**：

- Systran faster-whisper 模型训练语料以繁体中文为主，`--language zh` 时输出繁体
- `opencc` 是中文简繁转换的事实标准，通用且零配置
- 可开关（`--no-simplify`），保持灵活性

---

## 六、并发模型

```
URL_1:  [解析]──[下载]──[提取音频]──[转写]──[输出]──[清理]
URL_2:  [解析]──[下载]──[提取音频]──[转写]──[输出]──[清理]
URL_3:      [解析]──[下载]──[提取音频]──[转写]──[输出]──[清理]
...
```

两层并发控制（基于计数信号量）：

| 阶段 | 并发数 | 原因 |
|---|---|---|
| 浏览器解析 | 1 | 平台页面与风控更敏感，默认串行解析更稳定，可通过 `--parse-concurrency` 调整 |
| MP4 下载 | 1 | 默认串行以提高稳定性，可通过 `--download-concurrency` 调整 |

**转写模型复用**：Whisper 转写由持久化 Python 服务处理，启动时加载一次模型，后续音频逐个转写，避免重复加载模型和抢占 CPU/GPU 资源。

**自然流水线**：每个视频独立走下载流程。解析与下载由 Semaphore 控制，转写阶段在下载完成后逐个处理。

### 6.2 转录配置优化

| 参数 | 值 | 说明 |
|------|-----|------|
| beam_size | 5 | 束搜索宽度，保留 5 个候选序列选最优，比贪心解码（beam_size=1）准确率高 10-20% |
| vad_filter | false | 关闭 VAD 语音检测，避免误删轻声、停顿等有效语音 |
| language | zh（推荐） | 明确指定中文，跳过语言检测，避免短音频误判 |

**效果对比**：
- beam_size=1（贪心）：速度快，但容易出现幻觉、同音字错误
- beam_size=5（束搜索）：速度慢 2-3 倍，但准确率显著提升，特别是口语、方言、口音场景

**速度代价**：2 分钟音频约 10s → 25s（CPU），用户通常可接受

---

## 七、输出格式

### 7.1 输出结构

```
./video_results/
  ├── 2026_06_24_21-30-00_抖音_张三_740123456789/
  │   ├── 2026_06_24_21-30-00_抖音_张三_740123456789.json
  │   └── 2026_06_24_21-30-00_抖音_张三_740123456789_transcript.txt
  ├── 2026_06_24_21-31-00_B站_李四_BV1xx411c7mD/
  │   └── ...
  └── download-summary.json
```

### 7.2 单条输出格式

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

### 7.3 失败输出格式

```json
{
  "status": "failed",
  "source_url": "https://v.douyin.com/xxxxx",
  "error": "Douyin verification challenge",
  "error_type": "permanent"
}
```

### 7.4 文件名格式

```
{处理时间（秒级）}_{平台}_{作者}_{video_id}
```

示例：
```
2026_06_24_21_30_00_抖音_张三_740123456789
```

- 处理时间：年月日时分秒
- 平台：抖音
- 作者：原始作者昵称
- video_id：抖音视频 ID
- 附属文件：`{base}_transcript.txt`
- 失败文件：`{时间}_failed_{平台}_{错误类型}`

---

## 八、详细设计

### 8.1 浏览器拦截机制（平台通用）

Playwright 启动 Chromium 访问视频页面，注册 response 事件监听：

1. **API 拦截**：各平台拦截对应的元数据和流媒体 API 响应
2. **CDN 响应拦截**：记录视频下载 URL
3. **候选排序**：按分辨率和文件大小排序，选择最优质量

### 8.2 转写子进程

Node.js 主进程通过 `spawn` 调用 Python 转写脚本：

```
Node:  spawn("python", ["transcribe_server.py"])
       ───stdin──→  {"wav_path": "...", "model": "small", ...}
       ←──stdout─── {"segments": [...], "transcript": "...", "meta": {...}}
```

Python 脚本只做转写（faster-whisper + OpenCC），纯函数，输入 WAV 路径，输出 JSON。

### 8.3 断点续传

`download-state.json` 记录每个 URL 的处理状态：
- `parsing`：正在解析
- `downloading`：正在下载
- `transcribing`：正在转写
- `completed`：完成
- `retrying`：重试中
- `permanent_failure`：永久失败
- `failed`：失败

重跑时自动跳过 `completed` 状态的项。

### 8.4 输出文件

每个视频输出 JSON（元数据 + 文案 + 分段时间戳）和 TXT（纯文本转写），MP4 和 WAV 文件保留在原位。

---

## 九、依赖清单

| 依赖 | 用途 | 安装方式 |
|------|------|---------|
| playwright | 浏览器自动化 | `npm install` |
| faster-whisper | 本地语音转文字 | `pip install faster-whisper` |
| opencc | 繁体→简体中文转换 | `pip install opencc` |
| ffmpeg | 音频提取和转码 | 系统安装，需在 PATH 中 |

---

## 十、实现状态

| 功能 | 状态 |
|------|------|
| 多平台架构（可插拔解析器） | ✅ 已实现 |
| Douyin 浏览器拦截获取 CDN URL | ✅ 已实现 |
| Bilibili 浏览器拦截获取播放 URL | ✅ 已实现 |
| Bilibili DASH 多流自动合并 | ✅ 已实现 |
| Detail API 元数据提取 | ✅ 已实现 |
| MP4 下载（默认 1 并发，可配置） | ✅ 已实现 |
| 失败自动重试（指数退避） | ✅ 已实现 |
| 断点续传 | ✅ 已实现 |
| ffmpeg 音频提取 | ✅ 已实现 |
| faster-whisper 本地转写 | ✅ 已实现 |
| Whisper 模型复用（批次内） | ✅ 已实现 |
| OpenCC 繁→简转换 | ✅ 已实现 |
| Whisper 模型复用与 CUDA 保守默认配置 | ✅ 已实现 |
| 结构化 JSON 输出 | ✅ 已实现 |
| 实时进度输出 | ✅ 已实现 |
| 验证码检测 + 有头模式回退 | ✅ 已实现 |
