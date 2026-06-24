---
name: douyin-batch-download
description: Reliably download public Douyin videos from copied share text or URLs in batches, using a real Chromium session to obtain fresh signed media URLs, concurrent downloads, retries, and resumable state. Use when Codex or Claude Code is asked to 下载抖音视频、批量解析抖音分享链接、保存公开视频、重试失败下载，especially for 10–30 or more links.
---

# Douyin batch download

Use the bundled Node.js script. Do not substitute `yt-dlp`, F2, or an unauthenticated third-party parsing API; those paths are currently less reliable than browser interception.

## First run

Run from this skill directory:

```powershell
npm install
node scripts/setup.mjs
```

`setup.mjs` verifies Playwright and installs Chromium only when needed.

## Download

Ask where to save files if the user did not specify a directory. For pasted share text or a few URLs:

```powershell
node scripts/download.mjs --output "D:\Videos\douyin" "paste share text 1" "paste share text 2"
```

For a text file containing any mixture of share text and URLs:

```powershell
node scripts/download.mjs --input links.txt --output "D:\Videos\douyin"
```

Defaults are tuned for ordinary batches: 3 concurrent browser parsers, 6 concurrent downloads, and 10 attempts per item. Keep browser concurrency low even when the batch is large. To wait indefinitely for retryable failures, use `--max-attempts 0`; stop it manually if a link is permanently unavailable.

```powershell
node scripts/download.mjs --input links.txt --output ./downloads --max-attempts 0
```

If repeated verification challenges prevent headless parsing, rerun failed items with a visible browser:

```powershell
node scripts/download.mjs --input links.txt --output ./downloads --headed
```

## Completion contract

- Treat an item as complete only after the MP4 is fully streamed, its byte count is consistent, and an MP4 `ftyp` marker is present.
- Preserve `download-state.json` in the output directory. Rerunning the same command skips verified files and retries unfinished items.
- Do not expose transient CDN URLs as the final result; return saved file paths.
- Report every item as `completed`, `failed`, or `permanent_failure`. Private, deleted, region-restricted, or permission-gated works cannot be guaranteed.
- For more than 30 links, keep `--parse-concurrency` at 2–3. Raise only `--download-concurrency` when bandwidth permits.

Read [references/troubleshooting.md](references/troubleshooting.md) only when setup, verification, or repeated retry failures occur.
