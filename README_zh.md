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

## 支持平台

| 平台           |      状态 | 说明                                 |
| -------------- | --------: | ------------------------------------ |
| 抖音           | ✅ 已支持 | 公开视频；支持合流/分离流下载与合并  |
| B站 / Bilibili | ✅ 已支持 | 公开视频；支持 DASH 合并与播放流兜底 |
| 快手           | ✅ 已支持 | 公开视频；按作品 ID 精确读取页面详情 |
| 小红书         | ✅ 已支持 | 公开视频笔记；支持笔记定位与媒体兜底 |
| 微博           | ✅ 已支持 | 公开视频；自动选择无登录态的最高画质合流 MP4 |
| 更多平台       | 🚧 计划中 | 可通过平台适配层继续扩展             |

## 功能特性

- **多平台视频下载**：支持已接入平台的公开视频链接。
- **浏览器拦截提取**：通过 Playwright 捕获媒体地址，不依赖 yt-dlp 或第三方解析 API。
- **本地语音转写**：通过 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 在本地生成文案，不依赖云 API；可选 [OpenCC](https://github.com/BYVoid/OpenCC) 繁→简转换。
- **结构化输出与可续审纠正**：JSON 保存机器原始转写，TXT 作为唯一用户文案；全部机器转写结束后，Agent 可领取临时工作副本、分块 checkpoint，并在校验通过后发布纠正后的 TXT，原始 JSON 转录保持不变。
- **无登录态的最高画质**：枚举无登录态实际可访问的候选流，按画质选择最高档，并记录选择依据与降级原因。
- **分离流支持**：B站和抖音遇到视频/音频分离媒体流时，会自动下载并通过 ffmpeg 合并。
- **运行时兜底**：结合平台 API、页面状态和浏览器实际观察到的媒体响应，提高 B站/抖音/快手/小红书/微博稳定性。
- **可插拔平台适配器**：运行时自动发现平台插件、校验统一契约；单个插件损坏不会拖垮其他平台。
- **媒体轨道校验**：最终 MP4 必须含视频轨；默认转写时还要求可用音轨（`--no-transcribe` 可跳过音轨要求）。
- **成品画质校验**：通过 ffprobe 核对分辨率、帧率、编码和 HDR；最高候选失效时按画质顺序降级。
- **断点续跑**：重复运行时可跳过已完成下载和已有转写结果；失败项支持指数退避重试。
- **Agent Skill 可用**：可作为 Claude / Codex 类助手的 Skill 使用。

## 适用范围与限制

本工具面向公开视频内容。视频下载、媒体处理、faster-whisper 转写和 OpenCC 转换均由本机程序执行，程序不会调用外部模型 API。

可选的 TXT 纠正由当前宿主中的主 Agent 或子 Agent 执行，不是 Node/Python 程序内部的模型调用。因此，转录文本的数据处理位置、留存与隐私规则取决于当前 Agent 宿主。若要求严格本地、不同意 Agent 读取 TXT，应禁用 Agent 审阅，只使用机器原始 TXT/JSON。

它不会：

- 内置视频/转录上传或第三方解析、转写、纠正 API 调用（可选 Agent 审阅遵循上面的宿主边界）
- 处理私密内容或强登录内容
- 绕过平台访问控制
- 对画面文字做 OCR

其他实际限制：

- 首次使用 Whisper 模型会下载约 500 MB —— 这是正常现象，不是卡住
- CPU 转写：1 分钟音频约 12 秒（GPU：约 0.4 秒）
- 部分视频可能触发验证码 —— 使用 `--headed` 模式
- B站高画质视频需要 ffmpeg 合并 DASH 流
- “无登录态的最高画质”指平台在不登录账号时实际开放的最高档，不代表登录后、会员专享或上传原片画质；例如 B站无登录态页面可能只开放 480P
- 抖音可能返回视频/音频分离流；纯音频资源会被拒绝，不会误存为视频
- 小红书仅支持视频笔记，不支持图文笔记；公开视频笔记即使出现登录弹窗，也可能通过页面状态和媒体响应解析
- 快手按重定向后的作品 ID 匹配 Apollo/GraphQL 详情，避免误下载推荐流；风控页面需要稍后重试或使用有头模式
- 微博支持公开的 `video.weibo.com/show?fid=1034:...` 和 `weibo.com/tv/show/1034:...` 视频；无登录态访客验证或短时有效的 CDN 地址可能需要重试或使用有头模式
- 短分享链接可能过期或跳转到无关推荐页；可用时优先使用平台规范 URL
- 转写仅限语音内容，不包含屏幕文字识别

## 前置条件

- Node.js 20+
- Python 3.10+
- [ffmpeg](https://ffmpeg.org/)（需要在 `PATH` 中）

默认转写先尝试 `medium + cuda + float16 + zh`。仅当默认设备/计算精度配置遇到明确的 CUDA 运行时错误，才会自动降级到 `small + cpu + int8`；用户显式指定过 `--model` 时会保留该模型，显式指定的 `--device` 或 `--compute-type` 则绝不会被自动覆盖。只显式传入 `--device cpu` 时，计算精度自动使用 `int8`；若同时指定 `--compute-type`，则保持用户值。输出会记录实际配置和降级原因。

## 安装

### 作为 Agent Skill 安装

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
> "下载这个快手视频 https://v.kuaishou.com/xxxxx"
> "下载并转写这个微博视频 https://video.weibo.com/show?fid=1034:5317814823878730"

### 作为命令行工具安装

```bash
git clone https://github.com/ljb1020/video-batch-download.git
cd video-batch-download

npm install
node scripts/setup.mjs

pip install -U faster-whisper opencc
```

`setup.mjs` 会验证 Playwright 环境，并仅在需要时安装 Chromium。

如果只需要下载视频和元数据，可以不装 Python 依赖，并始终加上 `--no-transcribe`。

## 快速开始

下载并转写一个视频：

```bash
node scripts/download.mjs "https://v.douyin.com/xxxxx"
```

跳过转写，只下载视频和元数据：

```bash
node scripts/download.mjs "https://v.douyin.com/xxxxx" --no-transcribe
```

## 使用方法

### 下载单个视频

```bash
node scripts/download.mjs "https://v.douyin.com/xxxxx"
node scripts/download.mjs "https://www.bilibili.com/video/BVxxxxx"
node scripts/download.mjs "https://v.kuaishou.com/xxxxx"
node scripts/download.mjs "https://www.xiaohongshu.com/explore/xxxxx"
node scripts/download.mjs "https://video.weibo.com/show?fid=1034:5317814823878730"
```

### 批量下载多个视频

```bash
# 支持混合平台
node scripts/download.mjs "https://v.douyin.com/xxxxx" "https://www.bilibili.com/video/BVxxxxx" "https://v.kuaishou.com/xxxxx" "http://xhslink.com/xxxxx" "https://video.weibo.com/show?fid=1034:5317814823878730"

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

### 临时禁用平台插件

```bash
node scripts/download.mjs --input links.txt --disable-platform weibo
node scripts/download.mjs --input links.txt --disable-platform weibo,kuaishou
```

`--disable-platform <id>` 可以重复传入，也支持逗号分隔。插件被禁用、缺失或加载失败时，其余平台插件仍可正常工作。

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

默认情况下，最终 MP4 会复制到每个视频目录，作为用户可见的正式产物。`.temp` 同时保存可复用媒体缓存和可续审的 Agent 工作副本。如果传入 `--no-video-output`，MP4 只保留在 `.temp`；`--clear-temp` 只清媒体缓存，保留 `.temp/agent-review` checkpoint。

使用同一输出目录重跑时，会复用 `download-state.json` 做断点续传。

目录和文件名中的时间使用运行机器的本地时间，格式为 `YYYY_MM_DD_HH-mm-ss`，不再使用 UTC。

JSON 的 `transcript` 和 `segments` 始终保留 faster-whisper 的机器原始结果，Agent 审阅不得修改。审阅者只编辑 claim 返回的临时工作副本，只修正能结合标题、描述、术语和上下文明确判断的识别错误、同音字、术语、标点和断句；不润色、不扩写、不总结、不改变原意或说话风格，不确定内容保持原样。校验完成后才覆盖唯一的用户可见 `*_transcript.txt`，不生成 raw/corrected/polished 等多版本文案。

### 全批次机器处理后的 Agent 审阅

只有当前批次的全部机器处理结束后才开始 Agent 审阅。当前批次严格由 `download-summary.json.results[].jsonPath` 定义；复用输出目录时，不扫描或混入历史 JSON/TXT。

```bash
node scripts/agent-review.mjs reconcile --summary ./video_results/download-summary.json
node scripts/agent-review.mjs plan --summary ./video_results/download-summary.json --max-concurrency 3
# 创建审阅 Agent 后，回写请求/实际并发数，并重复 plan 使用的预算参数：
node scripts/agent-review.mjs reconcile --summary ./video_results/download-summary.json --max-concurrency 3 --effective-concurrency 2
# 审阅者对分配项使用 claim/checkpoint/pause/complete 或 fail。
node scripts/agent-review.mjs finalize --summary ./video_results/download-summary.json
```

默认请求最多 3 个子 Agent，用户可以设置其他值；实际并发受宿主槽位和共享工作区能力限制。每个 Agent 按分桶顺序处理多个 TXT，不是一条 TXT 开一个 Agent。程序只负责批次范围、哈希、token 估算、claim、checkpoint 和提交等确定性协调，不会调用审阅模型。

没有子 Agent 能力时，主 Agent 按受限上下文预算分轮串行审阅：每块完成后 checkpoint，在上下文耗尽前 `pause`，随后在新的干净 Agent 会话中指向同一 summary 续审。若宿主既不能创建子 Agent，也无法提供新的干净会话，必须报告“机器阶段完成、审阅可恢复但未完成”，不能冒充全部完成。

严格本地或用户明确禁用审阅时，运行 `reconcile --summary ./video_results/download-summary.json --disable-review`。它会把尚未 reviewed 的项目记录为 `required=false`、`reason=agent_review_disabled_by_user`；最终必须明确报告纠正功能已禁用。

### 程序状态与 Agent 审阅

| 状态 | 含义 |
| --- | --- |
| `completed` | 程序已完成要求的机器处理：转写成功，或用户明确传入 `--no-transcribe`。 |
| `transcription_failed` | 视频和元数据成功，但转写及适用的 CPU 自动降级最终仍失败；视频和 JSON 继续保留。 |
| `failed` | 解析、下载或输出失败，可按错误情况重试。 |
| `permanent_failure` | 内容无效、不可用或其它不可重试错误（已删除、私密、图文作品等）。 |

这些是 `download-state.json` 中的机器状态；单条成功产物 JSON 仍使用 `status: "success"`。失败 JSON 与 `transcription_failed` 条目还会写入结构化字段，如 `error_code`、`error_category`、`error_stage`、`retryable`、`permanent`、`user_message`，以及可选的 `technical_error` / `suggestion`。`transcription_error` 始终是技术错误串；面向用户的中文说明在 `user_message`。下载 CLI 的退出码只表达机器阶段：`0` 表示机器阶段成功，`1` 表示存在机器失败，`2` 表示参数或输入错误。Agent 审阅仍为 `pending` 不会改变下载 CLI 退出码。

审阅阶段有独立完成语义：`agent-review finalize` 返回 `0` 表示所有必需审阅完成或无需审阅，`1` 表示存在 failed/blocked/stale，`2` 表示参数、schema 或状态损坏，`3` 表示 pending/paused/有效 in-progress 等可恢复待续状态。只有机器阶段满足用户请求且审阅 finalize 返回 `0`，整个 Skill 任务才算完成。

如果转写正常完成但检测不到语音，该条目仍为 `completed` 且不生成 TXT；后续重跑会复用这一结果，不会无限重复转写。

### JSON 格式

<details>
<summary>JSON 示例</summary>

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
	"error_code": null,
	"error_category": null,
	"error_stage": null,
	"retryable": null,
	"permanent": null,
	"user_message": null,
	"technical_error": null,
	"suggestion": null,
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
	"quality": {
		"access_mode": "anonymous",
		"selection_version": "anonymous-best-v1",
		"available_streams": [
			{"type": "video+audio", "resolution": "1080x1920", "quality": 1080}
		],
		"selected_streams": [
			{"type": "video+audio", "resolution": "1080x1920", "quality": 1080}
		],
		"audit": {
			"accessibleQualities": ["1080P", "720P"],
			"selectedQuality": "1080P",
			"selectionReason": "无登录态的最高画质"
		}
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

</details>

## 命令行参数

<details>
<summary>下载参数</summary>

| 参数                         | 默认值            | 说明                               |
| ---------------------------- | ----------------- | ---------------------------------- |
| `--input <file>`             | —                 | 从 UTF-8 文本文件读取链接          |
| `--output <dir>`             | `./video_results` | 输出目录                           |
| `--parse-concurrency <n>`    | `1`               | 并发浏览器解析数                   |
| `--download-concurrency <n>` | `1`               | 并发下载数（默认串行以提高稳定性） |
| `--max-attempts <n>`         | `3`               | 每条可重试链接的尝试次数；永久失败不会重试（0 = 无限重试） |
| `--page-timeout <secs>`      | `45`              | 页面导航超时                       |
| `--media-wait <secs>`        | `25`              | 等待媒体响应时间                   |
| `--download-timeout <secs>`  | `900`             | 单个文件下载超时                   |
| `--no-video-output`          | 关闭              | MP4 只保留在 `.temp` 缓存，不复制到每个视频目录 |
| `--clear-temp`               | 关闭              | 删除媒体缓存、保留 Agent 审阅 checkpoint 并退出 |
| `--headed`                   | 关闭              | 显示浏览器窗口                     |
| `--storage-state <file>`     | —                 | Playwright storage-state JSON      |
| `--disable-platform <id>`    | —                 | 禁用插件 ID；可重复传入或用逗号分隔 |

</details>

<details>
<summary>转写参数</summary>

| 参数                          | 默认值    | 说明                                          |
| ----------------------------- | --------- | --------------------------------------------- |
| `--no-transcribe`             | 关闭      | 跳过 Whisper 转写                             |
| `--model <name>`              | `medium`  | Whisper 模型（`small`, `medium`, `large-v3`） |
| `--language <code>`           | `zh`      | 语言代码，`auto` = 自动检测                   |
| `--device <cpu\|cuda>`        | `cuda`    | 转写设备；显式使用 `cpu` 时计算精度默认改为 `int8` |
| `--compute-type <type>`       | `float16` | 精度（`int8`, `float16`, `float32`）；显式指定后不触发自动降级 |
| `--no-simplify`               | 关闭      | 跳过繁→简转换                                 |
| `--ffmpeg-path <path>`        | 自动      | ffmpeg 可执行文件路径                         |
| `--transcribe-timeout <secs>` | `600`     | 单次转写超时                                  |

</details>

## 工作流程

```txt
视频链接
    ↓
薄 CLI 入口将任务交给模块化批次 pipeline
    ↓
自动发现平台插件，跳过被禁用或损坏的插件
    ↓
通过 `matchesUrl()` 路由，并校验解析器的标准化输出
    ↓
Playwright 打开页面并捕获媒体地址
    ↓
下载视频 / 音频流到 <output>/.temp 缓存
    ↓
必要时通过 ffmpeg 合并 DASH 流，并在接受文件前探测音视频轨
    ↓
未使用 `--no-transcribe` 时，下载/续传会按转写需要门控音轨
    ↓
提取音频并通过 faster-whisper 本地转写（超时等错误阶段内重试，耗尽后终态不可再重试）
    ↓
保存 MP4、元数据 JSON（失败时含结构化错误字段）和 TXT 文案
```

解析与下载默认并发为 `1`，更稳定，可通过 CLI 参数提高。Whisper 模型在进程内加载一次并复用。平台插件抛出 `PlatformError`（`ProcessingError` 子类）；永久内容失败不会被后续临时接口噪声降级。

## 运行测试

修改平台插件、路由或统一输出契约后，运行：

```bash
npm test
```

测试覆盖 CLI 参数、入口行为、缓存与断点续传兼容、插件发现与故障隔离、URL 路由、平台解析结果标准化，以及各平台“无登录态的最高画质”选择；不会下载真实视频。

## 参考文档

- [架构与设计说明](references/architecture.md)
- [新平台开发与维护规范](references/platform-development.md)
- [故障排查](references/troubleshooting.md)

## 致谢

感谢 [LINUX DO](https://linux.do/) 社区的开源氛围与佬友反馈。

## 开源协议

[MIT](LICENSE)
