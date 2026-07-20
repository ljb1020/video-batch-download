# Video Batch Download & Transcribe — 架构与设计说明

## 一、需求概述

**输入**：一个或多个抖音/B站/快手/小红书/微博分享链接（可从分享文本中自动提取）
**输出**：每条视频的结构化信息，包含平台名、发帖人、发帖时间、视频标题、视频描述、视频文案（语音转文字）

**支持平台**：
- 抖音（Douyin）— 合流 MP4 或视频/音频分离流，自动合并并校验轨道
- B站（Bilibili）— DASH 多流（视频+音频分离）自动合并，支持播放流兜底
- 快手（Kuaishou）— 按目标作品 ID 读取 Apollo/GraphQL 详情和 H.264 MP4
- 小红书（Xiaohongshu）— 视频笔记单流 MP4，支持目标笔记状态和媒体响应兜底
- 微博（Weibo）— 按目标 `fid`/`oid` 读取组件数据，选择无登录态的最高画质合流 MP4

---

## 二、多平台插件架构设计（v4.0）

### 2.1 整体架构

```
┌─────────────────────────────────────────────┐
│              输入层（文本/URL）               │
└──────────────────┬──────────────────────────┘
                   ↓
┌─────────────────────────────────────────────┐
│        插件发现与隔离（router.js）            │
│                                             │
│  扫描 platforms/*.js 与 <id>/index.js       │
│  → 独立动态 import → 校验插件类契约           │
│  → 跳过 --disable-platform 指定的插件         │
│  → 单插件损坏只记录 skipped，不阻断其他插件   │
└──────────────────┬──────────────────────────┘
                   ↓
┌─────────────────────────────────────────────┐
│          URL 路由与平台解析                  │
│                                             │
│  提取、去重 URL → 逐插件 matchesUrl(url)     │
│  → 实例化匹配的解析器 → parse(...)           │
│  → validateParsedVideo(...)                 │
│                                             │
│  插件类契约：                                │
│  static getPlatformName()                   │
│  static matchesUrl(url)                     │
│  async parse(browserManager, url, options)  │
│                                             │
│  标准结果：ParsedVideo + 画质候选/审计       │
│  平台 API/页面私有字段不得越过此边界          │
└──────────────────┬──────────────────────────┘
                   ↓
┌─────────────────────────────────────────────┐
│      媒体层（media/downloader.js）            │
│                                             │
│  单流 (video+audio) → 下载到 .temp 缓存      │
│                                             │
│  多流 (video + audio) →                     │
│    并行下载 → 视频 copy / 音频 AAC 合并       │
│    清理分轨中间文件，保留合并 MP4 缓存        │
│                                             │
│  完成前探测轨道；默认转写要求音轨              │
│  不确定探测写 mediaHasAudio=null，resume 再测 │
└──────────────────┬──────────────────────────┘
                   ↓
      pipeline 编排 → 转写 → 输出（平台无关）
```

### 2.2 核心模块边界

`scripts/download.mjs` 只是稳定的 CLI 启动入口，不承载业务逻辑。核心依赖方向如下：

```text
download.mjs
  → pipeline/run-batch.js
      ├── cli/options.js
      ├── download-phase.js → platforms + media + core/resume
      ├── transcribe-phase.js → transcription + media/ffmpeg
      └── output/writer.js
```

- `cli/`：参数、帮助文本和输入文件读取。
- `core/`：画质策略版本、临时目录、断点续传判断，以及统一错误模型（`ProcessingError` / `normalizeError` / 失败落盘字段）。
- `media/`：流下载、候选降级、ffmpeg 合并/探测/音频提取和活动进程清理。
- `platforms/`：平台解析；失败统一为 `PlatformError`，永久内容错误通过 `preferPlatformError` 合并，禁止被临时 API 噪声降级。
- `transcription/`：持久化 Python Whisper 服务及请求队列的生命周期。
- `output/`：JSON/TXT、视频副本、失败结果（结构化错误字段）和批次 summary 落盘。
- `pipeline/`：批次状态机；只编排上述能力，不包含平台私有解析规则。

### 2.3 关键设计决策

| 设计点 | 方案 | 理由 |
|---|---|---|
| 插件发现 | 运行时扫描 `platforms/*.js` 和 `platforms/<id>/index.js` | 新增或删除平台不修改核心路由 |
| 平台识别 | 已加载插件依次执行 `matchesUrl()` | URL 规则由平台插件自行维护 |
| 插件 ID | 优先 `static platformId` / `static id`，否则使用文件或目录名 | CLI 禁用和日志使用稳定标识 |
| 故障隔离 | 每个插件独立 import、校验和跳过 | 单个平台损坏不影响其余平台启动 |
| 临时禁用 | `--disable-platform <id>`，可重复或逗号分隔 | 平台故障时无需删代码即可下线 |
| 解析器接口 | 返回 `mediaStreams[]`，可附带 `availableStreams`、`mediaAlternatives`、`qualityAudit` | 兼容单流/多流并支持“无登录态的最高画质”审计与降级 |
| 结果校验 | `validateParsedVideo()` 在下载前验证标准结构 | 平台私有或残缺数据不会泄漏到核心流程 |
| 多流合并 | ffmpeg 视频流 copy、音频转 AAC | 兼顾速度与 MP4 播放兼容性 |
| Bilibili Referer | 下载时设置平台 referer | 符合 B站 CDN 校验要求 |
| 向后兼容 | StateStore 键、输出格式不变 | 旧批次可断点续传 |

---

## 三、平台特定实现

### 3.1 抖音（DouyinParser）

**API / 媒体来源**：
- `/aweme/v1/web/aweme/detail/` — 元数据（标题/作者/统计/时长）
- `douyinvod.com` CDN — 合流或分离媒体 URL
- 页面 runtime fallback — `video.currentSrc` 与 `performance` 中浏览器实际请求过的媒体资源

**选流策略**：
- `media-video-*` 视为纯视频轨，必须搭配 `media-audio-*`
- `media-audio-*` 视为纯音频轨，不能作为 `video+audio` 成功输出
- 优先使用可下载的 `video.currentSrc` 合流 URL；否则使用 video+audio 分离流并通过 ffmpeg 合并

**输出**：
```js
// 合流
mediaStreams: [{
  url: "https://v26.douyinvod.com/...",
  type: "video+audio",
  format: "mp4"
}]

// 分离流
mediaStreams: [
  { url: "https://v26.douyinvod.com/.../media-video-avc1/", type: "video", format: "mp4" },
  { url: "https://v26.douyinvod.com/.../media-audio-und-mp4a/", type: "audio", format: "mp4" }
]
```

### 3.2 B站（BilibiliParser）

**API / 媒体来源**：
- `/x/web-interface/view?bvid=...` — 元数据（标题/作者/统计/时长/描述）
- `/x/player/(wbi/)?playurl?...` — 视频流 URL
- 页面 `window.__playinfo__` — 当 response 监听没捕获到 `playurl` 时作为兜底
- 主动请求 `/x/player/playurl` — 使用 `bvid/aid + cid` 请求 DASH 或 durl fallback

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
1. 并行下载 `video.m4s` 和 `audio.m4s` 到 `.temp`
2. `ffmpeg -i video.m4s -i audio.m4s -c:v copy -c:a aac merged.mp4`
3. 删除分轨中间文件，保留合并后的 `.temp/<media-key>.mp4` 作为缓存
4. 默认将最终 MP4 复制/硬链接到每条视频结果目录；传 `--no-video-output` 时只保留 `.temp` 缓存

### 3.3 快手（KuaishouParser）

**数据来源**：
- 短链接重定向后的 `/short-video/<photoId>` 用于锁定目标作品
- 页面 `window.__APOLLO_STATE__` 中的 `VisionVideoDetailPhoto:<photoId>` 提供详情与 H.264 MP4
- `visionVideoDetail` GraphQL 响应作为客户端渲染场景的补充来源
- 浏览器媒体响应只在 URL 可确认包含目标 `photoId` 时作为兜底，避免误选 `visionShortVideoReco` 推荐流

**输出**：单个带音轨的 H.264 MP4，并包含作者、标题、发布时间、时长、播放量和点赞量等元数据。

### 3.4 小红书（XiaohongshuParser）

**API / 媒体来源**：
- `/api/sns/web/v1/feed` — 笔记元数据候选
- `/api/sns/web/v1/note/info` — 笔记详情兜底
- 页面 `window.__INITIAL_STATE__` — 按 URL 中的目标 noteId 精准读取 `noteDetailMap[noteId]`
- `xhscdn.com` CDN — 视频 URL，包含页面 runtime 和媒体响应兜底

**限制**：
- 仅支持视频笔记，不支持图文笔记
- 登录弹窗不一定代表无法解析；公开笔记可能已经在页面状态和媒体响应中暴露视频数据

**输出**：
```js
mediaStreams: [{
  url: "https://sns-video-*.xhscdn.com/...",
  type: "video+audio",
  format: "mp4"
}]
```

### 3.5 微博（WeiboParser）

**目标识别**：
- 支持 `video.weibo.com/show?fid=1034:<id>` 与 `weibo.com/tv/show/1034:<id>`
- 页面跳转、组件响应和媒体兜底都必须匹配目标 `fid`/`oid`，避免误取推荐视频

**API / 媒体来源**：
- `POST /tv/api/component` 的 `Component_Play_Playinfo` — 作者、正文、发布时间、时长、统计和各清晰度 URL
- 页面 `<video>.currentSrc` / performance resource — 组件接口未捕获时的运行时兜底
- `weibocdn.com` 媒体响应 — 仅接受 `media_id` 与目标视频一致的 MP4

**选流与下载**：
- 将 `//f.video.weibocdn.com/...` 标准化为 HTTPS
- 从清晰度标签或 URL `template=WxH` 提取分辨率，选择无登录态的最高画质合流 MP4
- 下载时使用微博规范视频页作为 Referer
- CDN URL 带短时签名，失败重试时应重新解析；无登录态访客验证可能需要稍后重试或 `--headed`

**输出**：单个 `video+audio` MP4，`videoId` 保留完整的 `1034:<id>`。

---

## 四、整体技术栈

```
┌────────────────────────────────────────────┐
│                 输入层                       │
│ 一个或多个视频分享链接或分享文本（抖音/B站/快手/小红书/微博）│
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
│   模型加载一次，整个批次复用                 │
│   明确的 CUDA 启动/运行错误自动降级到 CPU    │
│                                            │
│   本机运行，程序不调用外部转写 API            │
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
│  - JSON：元数据 + 原始机器转写 + 分段时间戳   │
│  - TXT：机器原稿；批次完成后可由 Agent 审阅   │
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
- **平台扩展性强**：添加新平台只需放入符合 `PlatformParser` 契约的插件，核心路由无需改动

**不选的其他方案**：

| 方案 | 放弃原因 |
|------|---------|
| yt-dlp | 抖音/B站反爬频繁，提取器更新滞后 |
| Douyin_TikTok_Download_API | 依赖第三方在线解析服务，不稳定 |
| 手动解析 API | 需要逆向签名算法（抖音 X-Bogus，B站 wbi），维护成本高 |

### 5.2 B站 DASH 流处理：ffmpeg 合并

**为何这样做**：

- B站高画质视频采用 DASH 格式（视频和音频分离存储）
- 当前实现使用 `-c:v copy -c:a aac`：视频流直接复制，音频转 AAC 以提高 MP4 播放兼容性
- 合并速度快，视频画质不损失，CPU 占用主要来自音频转码

**不选的其他方案**：

| 方案 | 放弃原因 |
|------|---------|
| 只下载低画质合并流 | 画质差（通常 360p），用户体验不好 |
| 重编码合并 | 耗时长、CPU 占用高、有质量损失 |
| MP4Box 等工具 | 额外依赖，ffmpeg 已是转写必需 |

### 5.3 语音转文字：faster-whisper（本地）

**为何转写阶段只选本地模型**：

- 完全免费，无 API 费用
- 转写程序不上传音视频或转录文本
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

### 7.3 失败输出格式

解析、下载或输出失败：

```json
{
  "status": "failed",
  "source_url": "https://v.douyin.com/xxxxx",
  "error": "Douyin verification challenge",
  "error_type": "permanent"
}
```

视频与元数据已输出、但转写最终失败：

```json
{
  "status": "transcription_failed",
  "transcript": null,
  "segments": [],
  "transcription": {
    "model": "small",
    "device": "cpu",
    "compute_type": "int8",
    "fallback_reason": "CUDA runtime error"
  },
  "transcription_error": "CPU fallback transcription failed",
  "video_file": "D:/.../video_results/.../...mp4"
}
```

### 7.4 文件名格式

```
{处理时间（秒级）}_{平台}_{作者}_{video_id}
```

示例：
```
2026_06_24_21-30-00_抖音_张三_740123456789
```

- 处理时间：运行机器的本地年月日时分秒（`YYYY_MM_DD_HH-mm-ss`，非 UTC）
- 平台：抖音
- 作者：原始作者昵称
- video_id：抖音视频 ID
- 附属文件：`{base}.mp4`、`{base}_transcript.txt`
- 失败文件：`{时间}_failed_{平台}_{错误类型}`

---

## 八、详细设计

### 8.1 插件发现、路由与故障隔离

`router.js` 在启动时扫描 `scripts/platforms/*.js`、`*.mjs` 以及 `scripts/platforms/<id>/index.js` / `index.mjs`，排除 `base.js` 和 `router.js`。每个候选模块分别动态导入并验证：

- 默认导出或可识别的命名导出必须是解析器类
- 必须实现 `static getPlatformName()`、`static matchesUrl()` 和实例 `parse()`
- 插件 ID 必须唯一且满足 `[a-z0-9_-]+`；优先读取 `static platformId` / `static id`，否则取文件名或目录名
- `--disable-platform` 在导入前后都按规范化 ID 过滤，可重复传入或使用逗号分隔

成功时输出 `[platforms] loaded N: ...`；单插件导入或契约校验失败时输出 `[platforms] skipped <id>: ...` 并继续。路由阶段某插件的 `matchesUrl()` 抛错也只记录警告，不阻断其他插件匹配。

解析完成后，核心层调用 `validateParsedVideo()`，确保存在必要标识和至少一个合流流或一对视频/音频流，再进入下载阶段。

### 8.2 浏览器拦截机制（平台通用）

Playwright 启动 Chromium 访问视频页面，注册 response 事件监听：

1. **API 拦截**：各平台拦截对应的元数据和流媒体 API 响应
2. **CDN 响应拦截**：记录视频下载 URL
3. **候选排序**：按分辨率和文件大小排序，选择最优质量

### 8.3 转写子进程

Node.js 主进程通过 `spawn` 调用 Python 转写脚本：

```
Node:  spawn("python", ["transcribe_server.py"])
       ───stdin──→  {"wav_path": "...", "model": "medium", ...}
       ←──stdout─── {"segments": [...], "transcript": "...", "meta": {...}}
```

Python 脚本只做转写（faster-whisper + OpenCC），纯函数，输入 WAV 路径，输出 JSON。

默认先尝试 `medium + cuda + float16`。仅当设备和计算精度都未显式指定、当前设备为 CUDA，且错误明确属于 CUDA、cuDNN、cuBLAS、NVIDIA、GPU 或 float16 初始化/运行时问题时，才触发自动降级。未显式指定模型则降级为 `small + cpu + int8`；显式指定模型时保留该模型。任何显式 `--device` 或 `--compute-type` 都不会被覆盖。显式 `--device cpu` 且未指定计算精度时自动使用 `int8`；同时显式指定计算精度则保持用户值。依赖缺失、Python 不可用或模型下载失败不触发降级。

成功结果的 `transcription` 和失败状态中的运行配置统一记录 `model`、`device`、`compute_type`、`fallback_reason`；最终转写失败的 JSON 使用 `status: transcription_failed` 并记录 `transcription_error`。

### 8.4 断点续传

`download-state.json` 记录每个 URL 的处理状态：
- `parsing`：正在解析
- `downloading`：正在下载
- `transcribing`：正在转写
- `completed`：要求的机器处理完成（转写成功，或明确使用 `--no-transcribe`）
- `transcription_failed`：视频和元数据成功，但转写及适用的 CPU 降级最终失败；保留视频和 JSON
- `retrying`：重试中
- `permanent_failure`：永久失败
- `failed`：解析、下载或输出失败

以上是断点状态；单条成功产物 JSON 仍使用 `status: "success"`，最终转写失败的产物 JSON 使用 `status: "transcription_failed"`。

转写调用正常完成但未检测到语音时，状态仍为 `completed`，通过 `transcriptionCompleted` 记录阶段已完成；此时不要求 TXT 存在，避免后续重跑无限重复转写。

重跑时会先检查 `completed` 项所需的 JSON/TXT/MP4 产物是否仍存在；满足当前运行策略时直接跳过，否则复用 `.temp` 缓存或已有视频产物补齐缺失输出。

批次摘要单独统计 `transcriptionFailed`。只要存在 `failed`、`permanent_failure` 或 `transcription_failed`，命令退出码即为 `1`。

### 8.5 输出文件

每个视频默认输出 MP4、JSON（元数据 + 原始机器转写 + 分段时间戳）和 TXT 到同一个结果目录。作为 Agent Skill 使用时，Agent 只编辑 claim 返回的临时工作副本，仅修正上下文可明确确认的识别错误、同音字、术语、标点和断句；不润色、不扩写、不总结、不改变原意，不确定内容原样保留。JSON 的 `transcript` 和 `segments` 不同步修改，也不生成多版本 TXT。程序的 `completed` 只代表机器阶段完成；请求转写时，审阅 finalize 返回 `0` 才满足 Skill 的审阅完成条件。

`.temp` 同时保存最终 MP4 的可复用缓存和 `.temp/agent-review` 审阅工作目录。MP4 缓存用于断点续传和补处理；传 `--no-video-output` 时，MP4 只保留在 `.temp`，不复制到结果目录。WAV 和 DASH 分轨文件属于中间文件，处理完成后清理。`--clear-temp` 只清理媒体缓存并保留审阅断点；手工删除整个 `.temp` 会同时移除两类状态。

### 8.6 Agent 审阅协调与宿主边界

Agent 审阅在整个机器批次结束后启动。当前批次唯一清单来自本次 `download-summary.json.results[].jsonPath`；`reconcile`、`plan` 和 `finalize` 不得扫描输出目录收集历史结果。`runId` 关联批次摘要、临时目录和审阅汇总。

项目程序负责确定性能力：初始化和迁移 `agent_review` schema、计算原始转录/TXT 哈希与 token 估算、按预算分桶、claim/lease/CAS、创建工作副本、checkpoint/pause、可恢复提交、从单条 JSON 重建批次汇总。程序不会调用审阅模型。语言判断依赖当前 Agent 宿主；创建隔离子 Agent、提供并发槽位和共享工作区、获得干净上下文、判断 Agent 活性等都只能 best-effort 使用。

状态流：

```text
pending/paused/failed
       │ claim (generation + 1, unique claim_id, lease)
       ▼
in_progress ──checkpoint──> in_progress
       │ pause                  │ complete
       ▼                        ▼
    paused                 committing ──validated replace──> reviewed
```

- `blocked`、`not_required`、`stale` 优先由 `reconcile` 根据事实派生。
- reviewer 只编辑 `.temp/agent-review/<runId>/<claim_id>/work.txt`。每块完成后，协调器把规范化内容写成不可变 checkpoint snapshot，JSON 指向 snapshot；Agent 可继续编辑 `work.txt` 而不会破坏上一个恢复点。保持一行对应一个 Whisper segment。
- `checkpoint/pause/complete/fail` 必须同时校验状态、claim ID、generation、源哈希、正式 TXT 哈希和工作副本哈希。lease 过期只允许新 claim 接管，旧 Agent 的迟到提交仍会被 CAS 拒绝。
- `complete` 先验证最终 checkpoint snapshot，再进入 `committing`；提交和崩溃恢复只使用该不可变 snapshot，Agent 可写的 `work.txt` 不再参与发布。随后以同卷临时文件和备份协议替换正式 TXT；哈希无法对应时派生 `stale`。
- `attempt_history` 是最多 20 条的有界审计记录；`review_started_at` 和累计 `subagent_failure_count` 单独持久化，因此超长 TXT 多次 pause 后仍保持正确耗时和“子 Agent 只重试一次”策略。

分桶默认请求最多 3 个子 Agent，用户可调整。`plan.maxUsefulConcurrency` 只表示按请求值和桶数计算的理论上限，不宣称宿主已经创建 Agent。主 Agent 按实际 spawn 成功且能访问共享工作区的数量调度，并再次运行 `reconcile`，用 `--max-concurrency`、`--effective-concurrency` 和与 plan 相同的上下文/显式预算参数持久化实际计划。每个子 Agent 顺序审阅一个桶内的多个 TXT；子 Agent 不直接写批次摘要，也不向主 Agent 返回完整转录正文。

上下文预算优先按宿主可用的窗口和已用上下文动态下调；无法确认时使用 40K 目标、60K 硬上限的保守默认。无子 Agent 时，主 Agent 按更小的单轮预算串行处理，checkpoint 后 `pause`，再由新的干净 Agent 会话运行 `reconcile/plan` 续审。无法获得新上下文时保留可恢复状态并报告未完成。

机器阶段与审阅阶段使用两套退出语义：下载 CLI 的 `0/1/2` 只表示机器成功、机器失败、参数/输入错误；`agent-review finalize` 的 `0/1/2/3` 分别表示审阅完成、失败或阻塞、参数/schema/状态错误、可恢复待续。Skill 只有在机器阶段满足用户请求且 finalize 返回 `0` 时才完成。

隐私口径必须拆开说明：下载、ffmpeg、faster-whisper 和 OpenCC 在本机程序中运行，程序不主动调用外部转写或纠正 API；启用 Agent 审阅后，TXT 的处理位置、留存和隐私规则取决于当前 Agent 宿主。严格本地场景运行 `reconcile --disable-review`，将未审阅项记录为 `required=false`、`reason=agent_review_disabled_by_user`，并交付机器原稿。

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
| 平台插件运行时自动发现 | ✅ 已实现 |
| 单插件加载失败隔离与按 ID 禁用 | ✅ 已实现 |
| 统一解析结果运行时校验 | ✅ 已实现 |
| Douyin 浏览器拦截获取 CDN URL | ✅ 已实现 |
| Bilibili 浏览器拦截获取播放 URL | ✅ 已实现 |
| Bilibili DASH 多流自动合并 | ✅ 已实现 |
| Kuaishou 目标作品 Apollo/GraphQL 精确解析 | ✅ 已实现 |
| Weibo 目标 fid/oid 精确解析与“无登录态的最高画质”MP4 | ✅ 已实现 |
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
