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
- 支持平台列表：运行时扫描 `scripts/platforms/*.js` 和 `scripts/platforms/<id>/index.js` 的结果
- 插件发现、禁用和故障隔离：`scripts/platforms/router.js`
- 平台解析器契约：`scripts/platforms/base.js`
- 平台解析实现：`scripts/platforms/<platform>.js` 或 `scripts/platforms/<id>/index.js`
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

- 平台相关逻辑放在 `scripts/platforms/<platform>.js`；复杂插件也可放在 `scripts/platforms/<id>/index.js` 并在同目录拆分私有模块。
- URL 匹配规则由插件自己的 `static matchesUrl()` 维护；不要在核心路由中增加平台分支。
- `scripts/platforms/router.js` 只负责发现、契约校验、禁用、故障隔离和通用路由，不维护静态平台清单。
- 通用下载、合并、转写、断点续传和输出逻辑放在 `scripts/download.mjs` 或 `scripts/utils/`。
- 新平台不要把特殊解析逻辑塞进 `scripts/download.mjs`，优先在平台解析器中归一化为 `mediaStreams`。
- 只有多个平台共同需要的能力，才考虑抽到 `scripts/utils/`。

## 新增平台流程

1. 新建 `scripts/platforms/<platform>.js`；需要多个私有模块时，新建 `scripts/platforms/<id>/index.js`。
2. 实现或遵守 `PlatformParser` 契约：
   - `static platformId` 或 `static id`（可选；默认使用文件名/目录名，建议 ID 使用稳定的小写 ASCII）
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
   - `mediaStreams`（当前选中的无登录态最高画质流组）
   - `availableStreams`（可选；无登录态下的全部候选，用于审计）
   - `mediaAlternatives`（可选；按画质降序排列的可下载流组）
   - `qualityAudit`（可选；宣传档位、实际可用档位、选择结果与原因）
   - `referer`（可选；平台默认下载来源）
4. `mediaStreams` 中可按需提供 stream 级 `referer`、`headers`、`quality` 等字段。
5. 不要修改 `router.js` 注册插件；启动时会自动发现。用启动日志 `[platforms] loaded N: ...` 确认插件 ID 和加载结果。
6. 确认返回值通过 `validateParsedVideo()`：必要字符串字段完整，`mediaStreams` 至少包含一个 `video+audio`，或同时包含 `video` 与 `audio`。
7. 用 `--disable-platform <id>` 验证插件可独立下线；该参数可重复传入，也支持逗号分隔。
8. 按本文档的同步矩阵更新文档。
9. 做最小验证，优先 `--no-transcribe`。

## 插件加载与故障隔离

- loader 扫描 `scripts/platforms` 下的 `.js` / `.mjs` 文件，以及子目录中的 `index.js` / `index.mjs`；`base.js` 和 `router.js` 不作为插件。
- 优先使用模块默认导出的解析器类；也兼容可识别的命名导出。
- 插件类必须提供 `static getPlatformName()`、`static matchesUrl()` 和实例 `parse()`，否则输出 `[platforms] skipped <id>: ...`。
- 插件 ID 优先取 `static platformId` / `static id`，否则取文件名或目录名；ID 必须唯一，以小写字母或数字开头，后续只能包含小写字母、数字、下划线和连字符。
- 单个插件导入失败、契约错误、ID 冲突或 matcher 抛错，不得阻止其他插件加载和匹配。
- 临时停用平台优先使用 `--disable-platform <id>`，无需删除代码，也不要在核心下载流程里加临时判断。

## 解析策略

- 优先使用 Playwright response 拦截平台 API 和媒体响应。
- 可以使用页面初始状态作为兜底。
- 少依赖脆弱 DOM 文本。
- CDN URL 可能过期时，失败后应允许重新解析获得新 URL。
- 平台可能返回音视频合流或 DASH 分轨时，解析器应先归一化为 `mediaStreams`。例如抖音 `media-video-*` 是纯视频轨，必须搭配 `media-audio-*` 或明确失败；`media-audio-*` 不能标记为 `video+audio`。
- 解析器可以结合 response 拦截、页面初始状态和 runtime 媒体资源兜底，但必须优先匹配目标 URL/目标内容 ID，避免拿到推荐流或无关卡片。
- B站这类页面可能播放正常但没有被 response 监听捕获到 `playurl`，应优先尝试页面 `__playinfo__` 和主动 API fallback。
- 小红书这类页面可能显示登录弹窗，但公开笔记数据仍在 `__INITIAL_STATE__` 或媒体响应中；不要只因登录弹窗就放弃。
- 快手详情页同时加载目标作品和推荐流；必须按重定向后的 `photoId` 匹配 Apollo/GraphQL 详情，不能从推荐媒体中直接选择最大文件。
- 微博必须按 URL 的 `fid`/`oid` 匹配 `/tv/api/component` 和 CDN `media_id`；清晰度应按标签或 `template=WxH` 排序，不能依赖接口对象顺序。CDN URL 带短时签名，重试时重新解析。
- 能识别删除、私密、登录限制、地区限制时，标记为永久失败。
- 不支持的内容类型要明确报错，例如图文笔记、直播、合集等。

## 后续重构记录

- 下载器先执行 `mediaStreams`，失败后按 `mediaAlternatives` 的画质顺序降级；每个候选都会检查音视频轨及可用的分辨率、帧率、HDR 预期。新插件应避免把同一 URL 重复放入多个候选组。
- 视频轨和音轨都存在才是下载成功条件。新增或维护平台时，不要只校验 MP4 容器有效，也不要只校验 audio stream；纯音频、纯视频或初始化片段都不能被当作完成视频。

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
| 修改插件发现、契约或隔离行为 | `scripts/platforms/router.js`, `scripts/platforms/base.js`, `references/architecture.md`, 本文件 |
| 修改输出 JSON 结构 | `README.md`, `README_zh.md`, `SKILL.md`, `examples/sample_output.json`, `references/architecture.md` |
| 修改依赖或环境要求 | `package.json`, `package-lock.json`, `requirements.txt`, `README.md`, `README_zh.md`, `SKILL.md` |
| 修改下载、合并或转写流程 | `SKILL.md`, `references/architecture.md`, `README.md`, `README_zh.md` |
| 修改失败、重试或断点续传行为 | `SKILL.md`, `references/architecture.md`, `references/troubleshooting.md`, `README.md`, `README_zh.md` |
| 修改隐私边界或外部服务策略 | `SKILL.md`, `README.md`, `README_zh.md`, `references/architecture.md` |

## 最小验证

- 代码修改：先运行 `npm test`，确认插件发现、路由和统一结果契约测试通过。
- 文档或版本修改：运行 `node scripts/download.mjs --help`，并做关键词搜索。
- 路由或 URL 匹配修改：做 route-level 检查，确认目标 URL 被正确分发，并验证无效插件被跳过后其他插件仍可加载。
- 插件发现修改：覆盖单文件插件、`<id>/index.js` 插件、重复 ID、契约缺失和 `--disable-platform`（重复参数及逗号分隔）。
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
