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
    const mediaCandidates = [];

    const addMediaCandidate = (candidate) => {
      if (!candidate.url || mediaCandidates.some((item) => item.url === candidate.url)) return;
      mediaCandidates.push(candidate);
    };

    page.on("response", async (response) => {
      const responseUrl = response.url();
      const headers = response.headers();
      const contentType = headers["content-type"] ?? "";

      if (this._isVideoCdnUrl(responseUrl) || contentType.startsWith("video/")) {
        const total = Number(
          headers["content-range"]?.match(/\/(\d+)$/)?.[1] ?? headers["content-length"] ?? 0
        );
        addMediaCandidate({ url: responseUrl, totalBytes: total, source: "media-response" });
      }

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

      const loginRedirect = this._extractLoginRedirect(page.url());
      if (loginRedirect && XiaohongshuParser.matchesUrl(loginRedirect)) {
        await page.goto(loginRedirect, {
          waitUntil: "domcontentloaded",
          timeout: options.pageTimeoutMs,
        });
      }

      const targetNoteId = this._extractNoteIdFromUrl(page.url()) ?? this._extractNoteIdFromUrl(url);

      // Wait for the target note state or media response. Feed APIs may return
      // unrelated cards, so don't stop early just because a feed response exists.
      const deadline = Date.now() + options.mediaWaitMs;
      const startedAt = Date.now();
      while (Date.now() < deadline) {
        if (noteApiData || mediaCandidates.length > 0 || await this._hasPageNoteState(page, targetNoteId)) break;
        if (feedApiData && Date.now() - startedAt > 1_500) break;
        await sleep(250);
      }

      const finalUrl = page.url();
      const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
      for (const candidate of await this._collectRuntimeMediaCandidates(page)) {
        addMediaCandidate(candidate);
      }

      // Check for permanent failures
      if (/该笔记已被删除|违规|无法查看|不存在/u.test(bodyText)) {
        permanentReason = bodyText.match(/该笔记已被删除|违规|无法查看|不存在/u)?.[0];
      }

      const pageState = await this._extractNoteFromPage(page, targetNoteId);
      const apiNote = this._extractNoteFromApi(feedApiData, noteApiData, targetNoteId);
      let noteData = pageState ?? apiNote;
      const bestMediaCandidate = this._selectBestCdnCandidate(mediaCandidates);

      if (!noteData && bestMediaCandidate) {
        noteData = {
          id: targetNoteId ?? itemKey(url),
          type: "video",
          title: await page.title().catch(() => ""),
          video: { url: bestMediaCandidate.url },
        };
      }

      if (!noteData) {
        const reason = permanentReason ?? "No Xiaohongshu note data found";
        const error = new Error(reason);
        error.permanent = Boolean(permanentReason);
        throw error;
      }

      // 提取视频 URL
      const videoUrl = this._extractVideoUrl(noteData) ?? bestMediaCandidate?.url ?? null;

      // 判断是否为视频笔记
      const noteType = noteData.type ?? noteData.noteType ?? "";
      const hasVideo = noteType === "video" || noteData.video != null || Boolean(videoUrl) || this._urlIndicatesVideo(finalUrl);
      if (!hasVideo) {
        const err = new Error("This is an image/text note, not a video note");
        err.permanent = true;
        throw err;
      }

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
        duration: this._normalizeDuration(duration),
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
  _extractNoteFromApi(feedData, noteData, targetNoteId = null) {
    // Direct note API
    if (noteData && typeof noteData === "object" && this._noteMatches(noteData, targetNoteId)) {
      return noteData;
    }

    // Feed API: response.data.items[n].note_card
    if (feedData?.items?.length > 0) {
      const notes = feedData.items
        .map((item) => item.note_card ?? item.noteCard ?? item)
        .filter(Boolean);
      return notes.find((note) => this._noteMatches(note, targetNoteId)) ?? notes[0] ?? null;
    }

    return null;
  }

  _noteMatches(note, targetNoteId) {
    if (!targetNoteId) return true;
    const noteId = note?.noteId ?? note?.note_id ?? note?.id ?? note?.note_id_str ?? null;
    return String(noteId) === String(targetNoteId);
  }

  async _hasPageNoteState(page, targetNoteId) {
    return Boolean(await page.evaluate((noteId) => {
      const s = window.__INITIAL_STATE__;
      if (!s) return false;
      const noteMap = s.note?.noteDetailMap ?? s.note?.data?.noteDetailMap;
      if (noteMap) {
        if (noteId && noteMap[noteId]) return true;
        return Object.keys(noteMap).length > 0;
      }
      return Boolean(s.note?.note);
    }, targetNoteId).catch(() => false));
  }

  async _extractNoteFromPage(page, targetNoteId) {
    return await page.evaluate((noteId) => {
      const s = window.__INITIAL_STATE__;
      if (!s) return null;

      const unwrap = (entry) => entry?.note ?? entry ?? null;
      const noteMap = s.note?.noteDetailMap ?? s.note?.data?.noteDetailMap;
      if (noteMap) {
        if (noteId && noteMap[noteId]) return unwrap(noteMap[noteId]);
        const firstKey = Object.keys(noteMap)[0];
        return firstKey ? unwrap(noteMap[firstKey]) : null;
      }

      if (s.note?.note) return s.note.note;
      return null;
    }, targetNoteId).catch(() => null);
  }

  _extractLoginRedirect(url) {
    try {
      const parsed = new URL(url);
      if (!/xiaohongshu\.com$/i.test(parsed.hostname) && !/\.xiaohongshu\.com$/i.test(parsed.hostname)) return null;
      const redirectPath = parsed.searchParams.get("redirectPath");
      if (!redirectPath) return null;
      const redirect = new URL(redirectPath, parsed.origin);
      return redirect.href;
    } catch {
      return null;
    }
  }

  _urlIndicatesVideo(url) {
    try {
      return new URL(url).searchParams.get("type") === "video";
    } catch {
      return false;
    }
  }

  async _collectRuntimeMediaCandidates(page) {
    return await page.evaluate(() => {
      const candidates = [];
      const push = (url, source, totalBytes = 0) => {
        if (!url || !/^https?:\/\//i.test(url)) return;
        if (!/xhscdn\.com/i.test(url) || !/(\.mp4|m3u8|sns-video)/i.test(url)) return;
        if (candidates.some((item) => item.url === url)) return;
        candidates.push({ url, totalBytes, source });
      };

      for (const entry of performance.getEntriesByType("resource")) {
        push(entry.name, "performance-resource", entry.encodedBodySize || entry.transferSize || 0);
      }

      for (const video of document.querySelectorAll("video")) {
        push(video.currentSrc || video.src, "video-current-src");
      }

      return candidates;
    }).catch(() => []);
  }

  _normalizeDuration(duration) {
    if (duration == null || duration === "") return null;
    const numeric = Number(duration);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    // Xiaohongshu fields vary by source: small values are seconds, large values are milliseconds.
    return numeric >= 1_000 ? Math.round(numeric / 1000) : Math.round(numeric);
  }

  /**
   * Extract video CDN URL from note data.
   */
  _extractVideoUrl(noteData) {
    const video = noteData.video ?? {};
    const media = video.media ?? {};

    // Try stream URLs from video.media.stream. Prefer h264 for broad ffmpeg/device
    // compatibility, then fall back to h265/av1/h266 if needed.
    const stream = media.stream ?? {};
    const candidates = [
      ...this._tagStreams(stream.h264, "h264"),
      ...this._tagStreams(stream.h265, "h265"),
      ...this._tagStreams(stream.av1, "av1"),
      ...this._tagStreams(stream.h266, "h266"),
    ];
    const best = this._selectBestStream(candidates);
    if (best?.url) return best.url;

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

  _tagStreams(streams, codec) {
    return (Array.isArray(streams) ? streams : [])
      .map((stream) => ({ ...stream, _codec: codec }))
      .filter((stream) => this._streamUrl(stream));
  }

  _streamUrl(stream) {
    return stream?.masterUrl ?? stream?.url ?? null;
  }

  _selectBestStream(streams) {
    const scored = streams
      .map((stream) => ({ stream, url: this._streamUrl(stream), score: this._streamScore(stream) }))
      .filter((item) => item.url && /xhscdn\.com/i.test(item.url));
    scored.sort((a, b) => b.score - a.score);
    return scored[0] ?? null;
  }

  _streamScore(stream) {
    const codecScore = { h264: 4, h265: 3, av1: 2, h266: 1 }[stream?._codec] ?? 0;
    const width = Number(stream?.width ?? 0);
    const height = Number(stream?.height ?? 0);
    const pixels = width * height;
    const bitrate = Number(stream?.avgBitrate ?? stream?.videoBitrate ?? 0);
    const size = Number(stream?.size ?? 0);
    return codecScore * 1_000_000_000_000 + pixels * 1_000 + bitrate + Math.min(size, 1_000_000_000) / 1_000;
  }

  _selectBestCdnCandidate(candidates) {
    const scored = candidates
      .filter((candidate) => this._isVideoCdnUrl(candidate.url))
      .map((candidate) => ({
        candidate,
        score: Number(candidate.totalBytes ?? 0) + (candidate.url.includes("sns-video") ? 1_000 : 0),
      }));
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.candidate ?? null;
  }

  _isVideoCdnUrl(url) {
    return /^https?:\/\/[^\s"']*xhscdn\.com\//i.test(url) && /(sns-video|\.mp4|m3u8)/i.test(url);
  }

  /**
   * Deep search for CDN video URLs in the note data.
   */
  _findCdnUrl(obj, depth = 0) {
    if (depth > 10 || obj == null) return null;
    if (typeof obj === "string") {
      if (this._isVideoCdnUrl(obj)) return obj;
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
