# Agent 转录纠正改造方案

状态：方案 v2 已实施，已完成独立稳定性审阅与回归测试；真实长转录前向验证仍需用户单独批准。

## 1. 已确认决策

- 不接入任何外部大模型 API，不要求用户配置 API Key。
- 下载、音频处理、faster-whisper 转录和 OpenCC 转换由本机程序完成。
- TXT 纠正由当前 Agent 宿主中的主 Agent/子 Agent完成；这不是“严格本地模型处理”。
- 全部视频的机器处理结束后才开始 Agent 审阅；第一版不做边转录边审阅。
- JSON 的 `transcript` 和 `segments` 永远保留 faster-whisper 原始值。
- 只保留一个用户可见的 `*_transcript.txt`；允许在 `.temp/agent-review/` 使用不可见的临时工作文件。
- 不新增独立审阅状态文件。单条结果 JSON 保存权威审阅状态，`download-summary.json` 只保存可重建的批次汇总。
- 一个子 Agent顺序处理多个 TXT，按可用上下文和预计转录 token 分桶。
- 在干净且上下文窗口足够的宿主中，期望每个子 Agent承载 70K～80K 正文 token，普通硬上限 100K；实际预算必须动态下调。
- 子 Agent默认请求最大并发数为 3，用户可自行设置；实际并发取决于宿主能力和成功创建的任务数。
- 子 Agent失败后只重试未完成文件一次，再由主 Agent接管。
- 主 Agent接管仍失败或上下文不足时，任务必须报告为未完成或可恢复待续，不能冒充完成。

## 2. 数据处理与宿主能力边界

### 2.1 “本地”口径

允许使用：

> 视频下载、音频提取、Whisper 转录和繁简转换均在本机程序中执行，程序不会主动调用外部转录或纠错 API。启用 Agent 审阅时，TXT 将由当前 Agent 宿主处理，其数据处理位置和隐私规则取决于宿主环境。

禁止继续使用：

> 全部处理完全本地，任何数据都不会发送到外部服务。

如果用户明确要求严格本地、不同意宿主 Agent读取完整 TXT，则停止 Agent 审阅，只交付机器原始 TXT，并明确报告纠正步骤已由用户禁用。

### 2.2 能力分层

项目程序可以保证：

- 生成机器原始 JSON/TXT。
- 限定当前批次文件集合。
- 计算哈希和 token 估算。
- 生成分桶计划。
- 执行 claim、lease、CAS 和状态迁移。
- 创建临时工作副本、checkpoint 和原子提交。
- 从单条 JSON 重建批次审阅汇总。

依赖 Agent 宿主、只能 best-effort 使用：

- 创建子 Agent。
- 提供干净或隔离的子 Agent上下文。
- 提供足够的子 Agent并发槽位。
- 让子 Agent访问同一工作区。
- 中断、取消或判断 Agent活动状态。
- 暴露准确的模型上下文窗口和当前 token 占用。

降级规则：

1. 宿主支持子 Agent且共享工作区：优先并发审阅。
2. 子 Agent创建失败、无共享工作区或无隔离上下文：主 Agent串行审阅。
3. 主 Agent剩余上下文不足：保存 checkpoint，结束本轮，在新的干净 Agent 会话中续审。
4. 无法获得新的干净上下文：报告“可恢复但未完成”，保留全部状态，不继续硬塞上下文。
5. 主 Agent无文件读写能力：明确报告无法执行审阅。

## 3. 两阶段完成语义

### 3.1 机器阶段

现有下载 CLI 的退出码只表达下载、媒体处理和 Whisper 转录结果：

- `0`：本次机器阶段全部完成。
- `1`：存在下载、解析、永久失败或转录失败。
- `2`：CLI 参数或输入错误。

Agent 审阅的 `pending` 不得让下载 CLI 退出 `1`，否则直接使用 CLI 的用户会被误导。

### 3.2 Agent 审阅阶段

`scripts/agent-review.mjs finalize` 使用独立退出语义：

- `0`：全部必需审阅完成，或当前批次没有需要审阅的 TXT。
- `1`：存在 `failed`、`blocked`、`stale` 等不可直接继续的未完成项。
- `2`：参数、schema 或状态损坏。
- `3`：仍有可恢复的 `pending`、`paused` 或有效 `in_progress`，需要下一轮继续。

Skill 最终完成条件：

```text
机器阶段满足用户请求
AND
Agent 审阅阶段 finalize == 0
```

机器阶段完成但审阅尚未完成时，只能报告“机器处理完成、Agent 审阅待续”。

## 4. 当前批次边界

- 禁止扫描输出目录中的所有 JSON 作为当前批次。
- 当前批次唯一清单来自本次 `download-summary.json.results[].jsonPath`。
- `agent-review plan/reconcile/finalize` 必须显式接收本次 summary 路径，并只处理其 results 中的单条 JSON。
- 建议在批次摘要增加 `runId`，用于日志、临时目录和审阅汇总关联。
- 复用输出目录时，历史 JSON、孤儿文件和其他批次不得进入本次审阅计划。
- 单条结果被本次 summary 复用时，可以复用其有效 `reviewed` 状态，但必须重新校验原始转录和正式 TXT 哈希。

## 5. 单条 JSON 审阅 schema

成功生成非空 TXT 时，程序写入初始状态：

```json
{
  "transcript": "faster-whisper 原始转录",
  "segments": [],
  "transcript_file": "D:/.../xxx_transcript.txt",
  "agent_review": {
    "schema_version": 2,
    "required": true,
    "status": "pending",
    "reason": null,
    "source_transcript_sha256": "...",
    "source_txt_sha256": "...",
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
  }
}
```

### 5.1 持久化状态

| 状态 | 含义 |
| --- | --- |
| `pending` | 已生成 TXT，等待领取。 |
| `in_progress` | 存在有效 claim，Agent正在编辑临时工作副本。 |
| `paused` | 已保存 checkpoint，需要新的 Agent/轮次续审。 |
| `committing` | 工作副本已完成，正在以可恢复协议替换正式 TXT。 |
| `reviewed` | 正式 TXT 已完成纠正并通过哈希校验。 |
| `failed` | 审阅尝试失败，等待重试或主 Agent接管。 |

以下状态优先在 `reconcile` 时根据事实派生，不把容易漂移的结论当作唯一事实：

- `blocked`：上游转录失败，没有可审阅 TXT。
- `not_required`：明确禁用转录、无语音或用户禁用 Agent 审阅。
- `stale`：原始转录或正式 TXT 哈希与已记录状态不一致。

### 5.2 特殊结果

- `--no-transcribe`：`required=false`，派生原因 `transcription_disabled`。
- 成功但无语音：`required=false`，派生原因 `no_speech`。
- 用户要求严格本地并禁用 Agent 审阅：`required=false`，派生原因 `agent_review_disabled_by_user`。
- 最终转录失败：`required=true`，派生为 `blocked/transcription_failed`。
- 有非空 TXT：`required=true`，初始 `pending`。

### 5.3 不变量

- `source_transcript_sha256` 基于 JSON 原始 `transcript` 的 UTF-8 值计算。
- `source_txt_sha256` 基于程序首次生成的正式 TXT UTF-8 字节计算。
- 明确规定 TXT 编码为 UTF-8 无 BOM，写入时统一 LF；读取时兼容 CRLF/BOM。
- Agent 审阅不得改变 JSON 中 `transcript` 和 `segments` 的结构和值。
- 不承诺整个 JSON 文件字节级不变，因为状态更新会重新序列化 JSON。
- `error` 必须清洗并限制长度，建议最大 2,000 字符。
- `attempt_history` 记录角色、claim、起止时间和结果，并设置长度上限，避免 JSON 无限增长。

## 6. Claim、lease 与 CAS

### 6.1 Claim

`claim` 必须：

1. 校验当前批次、schema、状态和所有输入文件。
2. 重新计算原始转录、正式 TXT 和 checkpoint 哈希。
3. 使用 CAS 将 `generation += 1`。
4. 生成不可复用的 `claim_id`。
5. 保存 `claimed_txt_sha256`、`claimed_at` 和 `lease_expires_at`。
6. 在 `.temp/agent-review/<runId>/<claim_id>/` 创建唯一工作副本。
7. 返回工作副本路径，不让 Agent直接编辑正式 TXT。

示例：

```json
{
  "status": "in_progress",
  "generation": 3,
  "active_claim": {
    "claim_id": "uuid",
    "generation": 3,
    "reviewer": "review-agent-2",
    "role": "subagent",
    "claimed_txt_sha256": "...",
    "claimed_at": "2026-07-18T13:00:00Z",
    "lease_expires_at": "2026-07-18T14:00:00Z",
    "work_file": "D:/.../.temp/agent-review/.../work.txt"
  }
}
```

### 6.2 Lease

- 默认 lease 由实现阶段根据最大文件量确定，初始建议 60 分钟。
- 每次合法 checkpoint 自动续租。
- lease 过期不等于旧 Agent已停止，只代表新 claim 可以接管。
- 旧 Agent可以继续写自己的旧工作副本，但其 `checkpoint/complete/fail` 必须因 claim/generation 不匹配而被拒绝。
- Node 程序不得宣称自己能判断 Agent是否仍在运行。

### 6.3 CAS

`checkpoint/pause/complete/fail` 必须同时校验：

- 当前 `status`。
- `claim_id`。
- `generation`。
- 原始转录哈希。
- claim 时正式 TXT 哈希。
- 当前工作副本哈希。

任何一项不匹配都拒绝写入，不允许迟到 Agent覆盖新状态。

## 7. 临时工作副本、checkpoint 与提交

### 7.1 编辑规则

- Agent只编辑 claim 返回的工作副本。
- 用户可见的正式 TXT 在整个审阅完成前保持不变。
- 一个正式 TXT 同一时间只能有一个有效 claim。
- 为支持块级恢复，保持一行对应一个 Whisper segment；允许修正行内标点和断句，不随意增删行。
- 单次读取建议 5K～10K token。

### 7.2 Checkpoint

每完成一个块后调用 `checkpoint`，记录：

```json
{
  "completed_through_line": 420,
  "total_lines": 913,
  "work_txt_sha256": "...",
  "work_file": "...",
  "generation": 3,
  "updated_at": "..."
}
```

- checkpoint 必须经过 claim/generation CAS，并把当前 `work.txt` 复制为不可变 snapshot；JSON 指向 snapshot，Agent 后续继续编辑 `work.txt` 不得破坏已确认恢复点。
- 主 Agent或子 Agent需要结束当前上下文时调用 `pause`；`pause` 保留 checkpoint、释放 active claim，并将状态设为 `paused`。
- 新 Agent领取 `paused` 项时，从已验证工作副本复制到新的 claim 目录，并从下一行继续。
- 未通过 checkpoint 的部分不承诺恢复，重新审阅该块。

### 7.3 可恢复提交

完成全部块后：

1. `complete` 校验 claim、工作副本、行数和输入哈希。
2. 计算 `reviewed_txt_sha256`、确定性的 `changed_lines_count`，记录可选的 `reported_corrections_count`。
3. 通过 CAS 将 JSON 状态写成 `committing`，保存不可变最终 checkpoint snapshot、提交元数据和备份路径；可写 `work.txt` 不再作为提交源。
4. 使用同卷唯一临时文件和备份协议替换正式 TXT，不采用“先删除正式文件再 rename”的裸奔方式。
5. 正式 TXT 哈希校验通过后，将 JSON 写成 `reviewed`。
6. 清理工作文件和备份。

崩溃恢复：

- `committing` 且正式 TXT 哈希等于目标哈希：补写 `reviewed`。
- `committing` 且正式 TXT 仍等于源哈希、工作副本有效：重新执行替换。
- 哈希均不匹配：派生为 `stale`，禁止自动覆盖，交主 Agent处理。

Windows 实现必须专项验证长路径、文件占用、rename/replace 失败和断电窗口。

## 8. 动态上下文预算与分桶

### 8.1 预算公式

如果宿主能提供上下文窗口 `W` 和当前已占用估算 `C`：

```text
remaining = W - C
target_transcript = min(80K, floor(remaining * 0.40))
hard_transcript = min(100K, floor(remaining * 0.50))
```

仅当获得干净上下文且 `W >= 200K` 时，才使用 70K～80K 目标。

如果无法确认上下文窗口或当前占用：

```text
默认目标：40K
默认硬上限：60K
```

分块读取不会清空历史，不能把“每块 5K～10K”误当成总上下文控制。

### 8.2 Token 估算

优先使用宿主可用的目标模型 tokenizer；不可用时使用确定性近似：

```text
estimatedTokens = CJK 字符数 + ceil(非 CJK 字符数 / 4)
```

该数值只用于负载分配，不宣称为计费 token。

### 8.3 分桶

1. 按预计 token 从大到小排序 TXT。
2. 将当前 TXT 放入负载最小且不会超过动态 hard limit 的桶。
3. 无桶可容纳时创建新桶。
4. 小批次不为凑目标而制造额外子 Agent。
5. 同一 TXT 不并发分配给多个 Agent。
6. 单 TXT 超过 hard limit 时独占任务，依靠块级 checkpoint 跨干净 Agent/轮次串行续审。

## 9. 执行路径

### 9.1 有子 Agent能力

- 默认请求最多 3 个子 Agent，用户可指定其他值。
- 实际并发：

```text
effective = min(用户请求值或默认 3, 待执行桶数, 实际成功创建且可访问工作区的子 Agent数)
```

- 主 Agent不能让 Node “探测槽位”；按实际 spawn 成功数量调度。
- 优先使用干净、不继承完整对话的子 Agent上下文。
- 每个子 Agent顺序处理自己桶内的多个 TXT。
- 子 Agent只编辑工作副本；JSON 状态只能通过辅助 CLI 更新。
- 子 Agent向主 Agent只返回文件状态、耗时和错误，不返回完整转录正文。

### 9.2 无子 Agent能力

主 Agent串行处理，但设置比干净子 Agent更严格的单轮预算：

```text
main_round_budget = min(30K, floor(remaining_context * 0.25))
```

流程：

1. 只领取当前轮预算内的文件/块。
2. 每完成一块立即 checkpoint。
3. 每完成一个文件立即 commit 并更新单条 JSON。
4. 达到预算或剩余上下文不足时，对当前工作调用 `pause`。
5. `finalize` 返回 `3`，主 Agent报告“审阅可恢复待续”。
6. 用户在新的干净 Agent会话中指向同一 output 和 summary，运行 `reconcile/plan` 后继续。

结论：没有子 Agent时可以稳定续审，但不能保证一个不断膨胀的主 Agent会话一次吃完整个超大批次。

如果宿主既不能创建子 Agent，也无法开启新的干净 Agent会话，则超出单轮预算后必须停止并报告未完成；自动上下文压缩只能作为宿主优化，不能作为 Skill 的正确性保证。

## 10. 重试与主 Agent接管

1. 子 Agent失败后，已经 `reviewed` 的文件不重做。
2. 旧 claim 即使迟到也不能提交正式 TXT。
3. 未完成项使用新的 claim 和干净子 Agent重试一次。
4. 第二次子 Agent失败后，由主 Agent接管。
5. 主 Agent同样受动态上下文预算约束，可以 checkpoint/pause 后在新会话继续。
6. 主 Agent确认无法修复时标记 `failed`，审阅 finalize 返回 `1`。
7. `attempt_history` 区分首次子 Agent、重试子 Agent和主 Agent接管，确保策略可审计。

## 11. 确定性辅助脚本

Agent负责语言判断；机械操作由脚本完成：

- 限定当前批次。
- schema 初始化与迁移。
- 哈希和 token 估算。
- 动态预算参数校验与分桶。
- claim、续租、checkpoint、pause、complete、fail。
- Windows 安全提交与崩溃恢复。
- 单条 JSON 原子更新。
- 批次汇总重建。

已新增：

```text
scripts/agent-review.mjs
scripts/review/coordinator.js
scripts/review/atomic-files.js
test/agent-review.test.js
```

命令职责：

```text
reconcile  显式初始化/迁移 schema，校验 hash，恢复 committing，派生 stale/blocked/not_required
plan       只读生成当前批次分桶计划，不产生隐式状态修改
claim      CAS 领取并创建唯一工作副本
checkpoint 校验 claim 并保存块级进度，同时续租
pause      保存进度、释放 claim，供新上下文续审
complete   校验并以可恢复协议提交正式 TXT
fail       记录本次尝试失败
finalize   从单条 JSON 重建批次汇总并返回审阅阶段退出码
```

实际接口：

```text
node scripts/agent-review.mjs reconcile --summary <download-summary.json> [--disable-review] [--max-concurrency <n>] [--effective-concurrency <n>] [--context-window <n> --context-used <n>] [--target-tokens <n> --hard-limit <n>]
node scripts/agent-review.mjs plan --summary <download-summary.json> [--max-concurrency <n>] [--context-window <n> --context-used <n>] [--target-tokens <n> --hard-limit <n>]
node scripts/agent-review.mjs claim --summary <download-summary.json> --json <file> --reviewer <id> --role <main|subagent> [--lease-ms <n>]
node scripts/agent-review.mjs checkpoint --summary <download-summary.json> --json <file> --claim-id <id> --through-line <n> [--generation <n>] [--expected-work-hash <sha256>] [--lease-ms <n>]
node scripts/agent-review.mjs pause --summary <download-summary.json> --json <file> --claim-id <id> [--through-line <n>] [--generation <n>] [--expected-work-hash <sha256>]
node scripts/agent-review.mjs complete --summary <download-summary.json> --json <file> --claim-id <id> [--reported-corrections <n>] [--generation <n>] [--expected-work-hash <sha256>]
node scripts/agent-review.mjs fail --summary <download-summary.json> --json <file> --claim-id <id> --error <message> [--generation <n>] [--expected-work-hash <sha256>]
node scripts/agent-review.mjs finalize --summary <download-summary.json>
```

`plan` stdout 只输出机器可读 JSON，诊断写 stderr，并且不会持久化宿主实际采用的并发数。宿主创建审阅 Agent 后，应使用与 `plan` 相同的预算参数重新执行 `reconcile`，同时传入 `--max-concurrency` 和 `--effective-concurrency`，把请求值与实际值写回批次汇总。并发参数属于 Agent 编排层，不加入下载 CLI。

## 12. 批次汇总

`download-summary.json.agentReview` 由主 Agent在 reconcile/finalize 阶段重建：

```json
{
  "agentReview": {
    "schemaVersion": 2,
    "status": "completed",
    "requestedMaxConcurrency": 3,
    "effectiveMaxConcurrency": 2,
    "targetTokensPerAgent": 80000,
    "hardLimitTokensPerAgent": 100000,
    "estimatedTranscriptTokens": 184500,
    "required": 8,
    "reviewed": 8,
    "pending": 0,
    "paused": 0,
    "inProgress": 0,
    "failed": 0,
    "blocked": 0,
    "stale": 0,
    "notRequired": 2,
    "changedLinesCount": 37,
    "wallDurationMs": 196000
  }
}
```

- `wallDurationMs` 表示审阅阶段整体墙钟时间，不等于各文件耗时之和。
- 单文件 duration 由 claim/checkpoint/complete 时间自动计算，不由 Agent自报。
- `changedLinesCount` 由源 TXT 与最终 TXT 的确定性 diff 计算。
- `reportedCorrectionsCount` 仅作参考，不作为验收依据。
- 子 Agent不得并发写批次摘要。

## 13. 预计修改范围

| 文件 | 计划修改 |
| --- | --- |
| `scripts/output/writer.js` | 写入初始 `agent_review` schema、原始转录和源 TXT 哈希。 |
| `scripts/pipeline/run-batch.js` | 增加 `runId`，保持机器退出语义，写当前批次结果清单。 |
| `scripts/agent-review.mjs` | 新增审阅协调 CLI。 |
| `scripts/review/coordinator.js` | 批次限定、schema、预算、分桶、状态机和 CAS。 |
| `scripts/review/atomic-files.js` | 工作副本、Windows 安全替换和崩溃恢复。 |
| `SKILL.md` | 更新数据边界、能力降级、主/子 Agent契约和续审流程。 |
| `README.md` / `README_zh.md` | 修正“完全本地”口径，说明两阶段完成与 JSON 字段。 |
| `references/architecture.md` | 更新状态流、claim/lease/CAS、checkpoint 和批次边界。 |
| `references/troubleshooting.md` | 增加 stale、lease 过期、committing 恢复、无子 Agent和上下文不足处理。 |
| `examples/usage.md` / `examples/sample_output.json` | 同步实际工作流和 schema。 |
| `test/agent-review.test.js` | 覆盖状态、竞态、分桶、恢复、Windows 边界和退出码。 |
| 既有相关测试 | 更新 JSON schema 与批次摘要断言。 |

不修改 faster-whisper、平台解析器、下载逻辑或画质选择逻辑。

## 14. 核心测试计划

必须覆盖：

1. 当前 summary 严格限定批次，复用输出目录不会混入历史 JSON。
2. 非空转录、无语音、禁用转录、转录失败和用户禁用 Agent 审阅的正确派生状态。
3. `transcript` 和 `segments` 的结构和值在审阅前后不变。
4. source transcript/source TXT/reviewed TXT 哈希规则。
5. UTF-8 BOM、CRLF、Unicode、中文/ASCII token 估算。
6. 多短文件合桶、动态预算、普通硬上限和超长单文件 checkpoint。
7. 默认请求并发 3、用户覆盖、spawn 失败和主 Agent降级。
8. 重复 claim 被拒绝。
9. lease 过期后旧 Agent迟到 checkpoint/complete 被拒绝。
10. claim 后正式 TXT 或原始转录变化导致 CAS 失败。
11. 半文件崩溃后从最后合法 checkpoint 恢复。
12. pause 后在新的 claim/Agent上下文续审。
13. committing 各崩溃窗口的恢复。
14. Windows 文件占用、rename/replace 失败、长路径和备份回滚。
15. JSON 原子写入失败不留下空文件。
16. 子 Agent失败只重派未完成项一次，随后主 Agent接管。
17. Agent手工修改 JSON 或绕过 CLI 时能被 reconcile 识别。
18. summary 原有字段不被 finalize 丢失。
19. 下载 CLI 与 Agent review CLI 两套退出码。
20. 存在 pending/paused/in_progress/failed/blocked/stale 时 Skill 不报告最终完成。

## 15. 验收标准

- 不要求 API Key，程序不发起模型请求。
- 文档不再把 Agent 审阅宣称为严格本地处理。
- 全部机器处理结束后才启动 Agent审阅。
- 当前批次只来自本次 summary 结果清单。
- 程序保证状态/hash/claim/提交；Agent并发能力明确为宿主 best-effort。
- 默认请求最多 3 个子 Agent，用户可覆盖，实际数量按 spawn 成功结果降级。
- 有子 Agent时按动态上下文预算分桶，一个 Agent处理多个 TXT。
- 无子 Agent时主 Agent按轮次预算审阅，支持 checkpoint 和新会话续审。
- 迟到 Agent不能覆盖新 claim 或正式 TXT。
- 正式 TXT只在完整校验后替换，用户最终仍只看到一个 TXT。
- 单条 JSON 是权威审阅状态，批次汇总可重建。
- 原始 JSON 转录值不变。
- 任一必需审阅项未完成时，最终报告明确显示未完成或可恢复待续。
- 实现、测试、SKILL、README、架构、故障排查和示例口径一致。

## 16. 实施顺序

1. 先实现并验证 batch scope、schema v2、哈希和派生状态。
2. 实现 claim/lease/CAS 和只读 plan。
3. 实现工作副本、checkpoint/pause 和可恢复提交。
4. 实现动态预算、分桶和两阶段 finalize。
5. 更新 writer 与 run summary，但保持机器 CLI 退出语义。
6. 更新 SKILL 的宿主能力矩阵、子 Agent路径和主 Agent分轮续审。
7. 同步 README、架构、故障排查和示例。
8. 运行完整测试、Skill 校验和差异检查。
9. 经用户单独批准后，使用临时 fixture 进行子 Agent与无子 Agent两条路径的前向验证。
