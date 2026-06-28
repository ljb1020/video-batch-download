# 新平台开发与维护规范

这份文档用于维护本 skill，而不是给普通用户的使用说明。新增平台、修改解析逻辑、调整 CLI、输出结构或依赖时，先读这里，再动代码。

## 文档分工

- `SKILL.md`：skill 运行入口，说明什么时候使用本 skill，以及运行时的关键边界。
- `README.md` / `README_zh.md`：用户安装、使用和参数说明。
- `references/architecture.md`：架构、技术选型、流水线、并发模型和输出结构。
- `references/platform-development.md`：新增平台、维护约束、文档同步规则和验证清单。
- `references/troubleshooting.md`：安装、浏览器、验证码、重试和大批量任务排查。

## 当前事实源

当文档和代码不一致时，先以这些文件为准，再修正文档：

- CLI 参数和默认值：`scripts/download.mjs`
- 支持平台列表：`scripts/platforms/router.js`
- 平台解析器契约：`scripts/platforms/base.js`
- 平台解析实现：`scripts/platforms/<platform>.js`
- 转写服务行为：`scripts/transcribe_server.py`
- skill 触发规则：`SKILL.md`

## 开发前阅读顺序

新增平台或修改平台解析时，先读：

1. `references/platform-development.md`
2. `references/architecture.md`
3. `scripts/platforms/base.js`
4. 现有相近平台解析器
5. `scripts/platforms/router.js`

修改 CLI、下载、转写、断点续传或输出流程时，先读：

1. `scripts/download.mjs`
2. `references/architecture.md`
3. `SKILL.md`
4. `README.md`
5. `README_zh.md`

## 架构边界

- 平台相关逻辑放在 `scripts/platforms/<platform>.js`。
- URL 匹配和平台启用状态放在 `scripts/platforms/router.js`。
- 通用下载、合并、转写、断点续传和输出逻辑放在 `scripts/download.mjs` 或 `scripts/utils/`。
- 新平台不要把特殊解析逻辑塞进 `scripts/download.mjs`，优先在平台解析器中归一化为 `mediaStreams`。
- 只有多个平台共同需要的能力，才考虑抽到 `scripts/utils/`。

## 新增平台流程

1. 新建 `scripts/platforms/<platform>.js`。
2. 实现或遵守 `PlatformParser` 契约：
   - `static getPlatformName()`
   - `static getSlug()`（可选；需要 ASCII 文件名 slug 时覆盖）
   - `static matchesUrl(url)`
   - `async parse(browserManager, url, options)`
3. 返回统一结构：
   - `platform`
   - `sourceUrl`
   - `canonicalUrl`
   - `videoId`
   - `title`
   - `author`
   - `description`
   - `postTime`
   - `duration`
   - `statistics`
   - `mediaStreams`
   - `referer`（可选；平台默认下载来源）
4. `mediaStreams` 中可按需提供 stream 级 `referer`、`headers`、`quality` 等字段。
5. 在 `scripts/platforms/router.js` 注册解析器。
6. 按本文档的同步矩阵更新文档。
7. 做最小验证，优先 `--no-transcribe`。

## 解析策略

- 优先使用 Playwright response 拦截平台 API 和媒体响应。
- 可以使用页面初始状态作为兜底。
- 少依赖脆弱 DOM 文本。
- CDN URL 可能过期时，失败后应允许重新解析获得新 URL。
- 平台可能返回音视频合流或 DASH 分轨时，解析器应先归一化为 `mediaStreams`。例如抖音 `media-video-avc1` 是纯视频轨，必须搭配音频轨或明确失败，不能标记为 `video+audio`。
- 能识别删除、私密、登录限制、地区限制时，标记为永久失败。
- 不支持的内容类型要明确报错，例如图文笔记、直播、合集等。

## 后续重构记录

- 下载器目前只执行解析器返回的一组 `mediaStreams`。后续如果要系统性提升稳定性，可以引入候选下载计划：解析器返回多个计划，下载器按顺序尝试合流、DASH 双流、平台兜底 URL，并记录每个候选的下载和音轨探测结果。
- 音轨存在性是下载成功条件之一。新增或维护平台时，不要只校验 MP4 容器有效，还要确认需要转写的视频包含 audio stream。

## 不接受的改动

- 不引入第三方在线解析 API。
- 不引入云端转写 API。
- 不上传媒体、转写文本或元数据。
- 不默认处理私密、登录限制或未授权内容。
- 不把 cookie、storage state、账号信息、代理配置、测试链接集合提交进仓库。
- 不提交下载产物、媒体文件、模型缓存或临时目录。
- 不为了单个平台破坏已有平台的统一输出结构。

## 文档同步矩阵

| 变更类型 | 必须同步 |
|---|---|
| 新增或移除支持平台 | `README.md`, `README_zh.md`, `SKILL.md`, `examples/usage.md`, `references/architecture.md`, 本文件 |
| 修改 CLI 参数或默认值 | `scripts/download.mjs`, `README.md`, `README_zh.md`, `SKILL.md`, `examples/usage.md` |
| 修改输出 JSON 结构 | `README.md`, `README_zh.md`, `SKILL.md`, `examples/sample_output.json`, `references/architecture.md` |
| 修改依赖或环境要求 | `package.json`, `package-lock.json`, `requirements.txt`, `README.md`, `README_zh.md`, `SKILL.md` |
| 修改下载、合并或转写流程 | `SKILL.md`, `references/architecture.md`, `README.md`, `README_zh.md` |
| 修改失败、重试或断点续传行为 | `SKILL.md`, `references/architecture.md`, `references/troubleshooting.md`, `README.md`, `README_zh.md` |
| 修改隐私边界或外部服务策略 | `SKILL.md`, `README.md`, `README_zh.md`, `references/architecture.md` |

## 最小验证

- 文档或版本修改：运行 `node scripts/download.mjs --help`，并做关键词搜索。
- 路由或 URL 匹配修改：做 route-level 检查，确认目标 URL 被正确分发。
- 新平台解析器：至少用一个公开视频跑 `--no-transcribe`。
- 下载流程修改：优先用 `--no-transcribe` 验证下载和元数据输出。
- 转写流程修改：再单独验证音频提取和转写。
- 不默认跑大批量下载，除非用户明确要求。

## 提交前检查清单

- [ ] 是否改变支持平台？
- [ ] 是否改变 CLI 参数或默认值？
- [ ] 是否改变输出 JSON 字段？
- [ ] 是否改变依赖或安装方式？
- [ ] 是否影响隐私承诺？
- [ ] 是否影响失败、重试或断点续传？
- [ ] 是否需要更新 `README.md` / `README_zh.md` / `SKILL.md`？
- [ ] 是否需要更新 `references/architecture.md` 或 `references/troubleshooting.md`？
- [ ] 是否做过最小验证？
- [ ] 是否排除了无关工作区改动？
