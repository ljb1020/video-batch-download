# Troubleshooting

## Setup fails

- Require Node.js 20 or newer.
- Run `npm install`, then `node scripts/setup.mjs`.
- If Chromium installation is blocked, install Microsoft Edge or Google Chrome. The downloader tries bundled Chromium, Edge, then Chrome.

## Headless parsing repeatedly finds no media

Rerun with `--headed`. Leave the browser open if Douyin presents a verification prompt. Keep `--parse-concurrency` at the default 1, or reduce it back to 1 if you changed it. Do not increase concurrency to fight throttling.

## A batch was interrupted

Run the same command with the same output directory. `download-state.json` records completed items, and verified MP4 cache files in `<output>/.temp` are reused. Deleting `.temp` does not remove already generated JSON/TXT or item-folder MP4 files, but it prevents cache-based resume/retry for missing video artifacts.

## A download URL expires

No manual action is required. A failed media transfer causes the item to return to browser parsing and obtain a fresh CDN URL.

## Permanent failures

Deleted, private, friends-only, login-only, and region-restricted works may never become downloadable. The final JSON summary distinguishes these from retryable network or verification failures.

## Clearing media cache

Use `node scripts/download.mjs --clear-temp --output ./video_results` to delete `<output>/.temp`. This only clears reusable media cache; it does not delete per-video result folders, JSON/TXT outputs, or MP4 files copied into item folders.

## Large batches

Keep browser parsing at the default 1 concurrent page unless you have verified the target platform remains stable. Downloads and transcription are serial by default for stability. For hundreds of links, split input files into manageable runs while reusing the same output directory and state file.
