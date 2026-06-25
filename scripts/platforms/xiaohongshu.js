import { PlatformParser } from "./base.js";
import { itemKey, sleep, settleWithin } from "../utils/common.js";

const URL_PATTERNS = [
  /^https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item)\/[\w]+/i,
  /^https?:\/\/(?:www\.)?xiaohongshu\.com\/note\/[\w]+/i,
  /^https?:\/\/xhslink\.com\//i,
];

export class XiaohongshuParser extends PlatformParser {
  static getPlatformName() {
    return "小红书";
  }

  static matchesUrl(url) {
    return URL_PATTERNS.some((pattern) => pattern.test(url));
  }

  async parse(browserManager, url, options) {
    const browser = await browserManager.start();
    const contextOptions = XiaohongshuParser.getBrowserContextOptions(browserManager, options);

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    let feedApiData = null;
    let noteApiData = null;
    let permanentReason = null;

    page.on("response", async (response) => {
      const responseUrl = response.url();

      // Intercept feed API
      if (/\/api\/sns\/web\/v1\/feed/.test(responseUrl) && response.ok()) {
        try {
          const json = await response.json();
          if (json.success && json.data) {
            feedApiData = json.data;
          } else if (!json.success) {
            permanentReason = `Xiaohongshu feed API error: ${json.msg ?? "unknown"}`;
          }
        } catch (e) { console.warn(`[xiaohongshu] failed to parse feed API response: ${e.message}`); }
      }

      // Intercept note API
      if (/\/api\/sns\/web\/v1\/note\/info/.test(responseUrl) && response.ok()) {
        try {
          const json = await response.json();
          if (json.success && json.data) {
            noteApiData = json.data;
          }
        } catch (e) { console.warn(`[xiaohongshu] failed to parse note API response: ${e.message}`); }
      }
    });

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options.pageTimeoutMs,
      });

      // Wait for API responses
      const deadline = Date.now() + options.mediaWaitMs;
      while (Date.now() < deadline) {
        if (feedApiData || noteApiData) break;
        await sleep(250);
      }

      const finalUrl = page.url();
      const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");

      // Check for permanent failures
      if (/该笔记已被删除|违规|无法查看|不存在/u.test(bodyText)) {
        permanentReason = bodyText.match(/该笔记已被删除|违规|无法查看|不存在/u)?.[0];
      }

      // Fallback: extract from __INITIAL_STATE__
      let noteData = this._extractNoteFromApi(feedApiData, noteApiData);
      if (!noteData) {
        const pageState = await page.evaluate(() => {
          const s = window.__INITIAL_STATE__;
          if (!s) return null;

          // __INITIAL_STATE__ 的 note 信息结构可能随版本变化
          // 常见路径: s.note.noteDetailMap[noteId].note 或 s.note.data
          const noteMap = s.note?.noteDetailMap ?? s.note?.data?.noteDetailMap;
          if (noteMap) {
            const firstKey = Object.keys(noteMap)[0];
            const entry = noteMap[firstKey];
            return entry?.note ?? entry ?? null;
          }

          // 直接在 s.note 下
          if (s.note?.note) return s.note.note;

          return null;
        }).catch(() => null);

        if (pageState) {
          noteData = pageState;
        }
      }

      if (!noteData) {
        const reason = permanentReason ?? "No Xiaohongshu note data found";
        const error = new Error(reason);
        error.permanent = Boolean(permanentReason);
        throw error;
      }

      // 判断是否为视频笔记
      const noteType = noteData.type ?? noteData.noteType ?? "";
      const hasVideo = noteType === "video" || noteData.video != null;
      if (!hasVideo) {
        const err = new Error("This is an image/text note, not a video note");
        err.permanent = true;
        throw err;
      }

      // 提取视频 URL
      const videoUrl = this._extractVideoUrl(noteData);
      if (!videoUrl) {
        throw new Error("No video URL found in note data");
      }

      // 提取元数据
      const noteId = noteData.noteId ?? noteData.id ?? this._extractNoteIdFromUrl(finalUrl) ?? itemKey(url);
      const user = noteData.user ?? noteData.author ?? {};

      const author = {
        nickname: user.nickname ?? user.nick_name ?? null,
        uid: user.userId ?? user.user_id ?? null,
        url: user.userId ? `https://www.xiaohongshu.com/user/profile/${user.userId}` : null,
      };

      const createTime = noteData.time ?? noteData.createTime ?? noteData.create_time;
      const postTime = createTime
        ? new Date(typeof createTime === "number" && createTime < 1e12 ? createTime * 1000 : createTime)
            .toISOString().replace("T", " ").slice(0, 19)
        : null;

      const interactInfo = noteData.interactInfo ?? noteData.interact_info ?? {};

      const statistics = {
        like_count: interactInfo.likedCount ?? interactInfo.liked_count ?? null,
        collect_count: interactInfo.collectedCount ?? interactInfo.collected_count ?? null,
        comment_count: interactInfo.commentCount ?? interactInfo.comment_count ?? null,
        share_count: interactInfo.shareCount ?? interactInfo.share_count ?? null,
      };

      const videoInfo = noteData.video ?? {};
      const duration = videoInfo.duration ?? videoInfo.dur ?? null;

      return {
        platform: XiaohongshuParser.getPlatformName(),
        sourceUrl: url,
        canonicalUrl: finalUrl,
        videoId: noteId,
        title: noteData.title ?? noteData.displayTitle ?? "",
        author,
        description: noteData.desc ?? null,
        postTime,
        duration: typeof duration === "number" ? Math.round(duration / 1000) : duration,
        statistics,
        referer: "https://www.xiaohongshu.com/",
        mediaStreams: [
          {
            url: videoUrl,
            type: "video+audio",
            format: "mp4",
            referer: "https://www.xiaohongshu.com/",
          },
        ],
      };
    } finally {
      await settleWithin(context.close(), 5_000);
    }
  }

  /**
   * Extract note data from intercepted API responses.
   */
  _extractNoteFromApi(feedData, noteData) {
    // Direct note API
    if (noteData && typeof noteData === "object") {
      return noteData;
    }

    // Feed API: response.data.items[0].note_card
    if (feedData?.items?.length > 0) {
      const item = feedData.items[0];
      return item.note_card ?? item.noteCard ?? item;
    }

    return null;
  }

  /**
   * Extract video CDN URL from note data.
   */
  _extractVideoUrl(noteData) {
    const video = noteData.video ?? {};
    const media = video.media ?? {};

    // Try stream URLs from video.media.stream (h264/h265)
    const stream = media.stream ?? {};
    const h264 = stream.h264 ?? stream.h265 ?? [];
    if (Array.isArray(h264) && h264.length > 0) {
      const master = h264[0];
      // master.url or master.masterUrl
      const masterUrl = master.masterUrl ?? master.url;
      if (masterUrl && /xhscdn\.com/i.test(masterUrl)) {
        return masterUrl;
      }
    }

    // Try video.consumer.originVideoKey or video.url
    const originKey = video.consumer?.originVideoKey ?? video.originVideoKey;
    if (originKey) {
      // originKey is a relative key, construct CDN URL
      if (/^https?:\/\//.test(originKey)) return originKey;
      return `https://sns-video-bd.xhscdn.com/${originKey.replace(/^\//, "")}`;
    }

    // Try direct URL on the video object
    const directUrl = video.url ?? video.downloadUrl;
    if (directUrl && /xhscdn\.com/i.test(directUrl)) {
      return directUrl;
    }

    // Recursively search for xhscdn.com URLs
    return this._findCdnUrl(noteData);
  }

  /**
   * Deep search for CDN video URLs in the note data.
   */
  _findCdnUrl(obj, depth = 0) {
    if (depth > 10 || obj == null) return null;
    if (typeof obj === "string") {
      if (/^https?:\/\/sns-video-[\w]+\.xhscdn\.com/.test(obj)) return obj;
      return null;
    }
    if (Array.isArray(obj)) {
      for (const child of obj) {
        const found = this._findCdnUrl(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof obj === "object") {
      for (const child of Object.values(obj)) {
        const found = this._findCdnUrl(child, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Extract note ID from the URL.
   */
  _extractNoteIdFromUrl(url) {
    return url.match(/(?:explore|discovery\/item|note)\/([\w]+)/)?.[1] ?? null;
  }
}
