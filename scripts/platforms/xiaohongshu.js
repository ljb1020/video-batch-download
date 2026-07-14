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
    const responseTasks = new Set();
    let closing = false;

    const addMediaCandidate = (candidate) => {
      if (!candidate.url) return;
      const existing = mediaCandidates.find((item) => item.url === candidate.url);
      if (existing) {
        Object.assign(existing, Object.fromEntries(Object.entries(candidate).filter(([, value]) => value != null && value !== 0)));
        return;
      }
      mediaCandidates.push(candidate);
    };

    const handleResponse = (response) => {
      const task = (async () => {
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
        } catch (e) { if (!closing) console.warn(`[xiaohongshu] failed to parse feed API response: ${e.message}`); }
      }

      // Intercept note API
      if (/\/api\/sns\/web\/v1\/note\/info/.test(responseUrl) && response.ok()) {
        try {
          const json = await response.json();
          if (json.success && json.data) {
            noteApiData = json.data;
          }
        } catch (e) { if (!closing) console.warn(`[xiaohongshu] failed to parse note API response: ${e.message}`); }
      }
      })().catch((error) => {
        if (!closing) console.warn(`[xiaohongshu] response handler failed: ${error.message}`);
      });
      responseTasks.add(task);
      task.finally(() => responseTasks.delete(task));
    };
    page.on("response", handleResponse);

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
      let bestMediaCandidate = this._selectBestCdnCandidate(mediaCandidates);

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

      for (const candidate of this._collectNoteMediaCandidates(noteData)) {
        addMediaCandidate(candidate);
      }
      const availableStreams = this._normalizeAvailableStreams(mediaCandidates, "https://www.xiaohongshu.com/");
      bestMediaCandidate = availableStreams[0] ?? bestMediaCandidate;
      const videoUrl = bestMediaCandidate?.url ?? null;

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
      const mediaAlternatives = availableStreams.map((stream) => [{ ...stream }]);

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
        availableStreams,
        qualityAudit: this._buildQualityAudit(availableStreams, availableStreams[0]),
        mediaAlternatives,
        mediaStreams: mediaAlternatives[0],
      };
    } finally {
      closing = true;
      page.off("response", handleResponse);
      await settleWithin(Promise.allSettled([...responseTasks]), 5_000);
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
    return this._collectNoteMediaCandidates(noteData)[0]?.url ?? null;
  }

  _collectNoteMediaCandidates(noteData) {
    const video = noteData?.video ?? {};
    const stream = video.media?.stream ?? {};
    const candidates = [
      ...this._tagStreams(stream.h264, "h264"),
      ...this._tagStreams(stream.h265, "h265"),
      ...this._tagStreams(stream.av1, "av1"),
      ...this._tagStreams(stream.h266, "h266"),
    ].map((item) => ({
      url: this._streamUrl(item),
      width: item.width ?? null,
      height: item.height ?? null,
      fps: item.fps ?? item.frameRate ?? null,
      bitrate: item.avgBitrate ?? item.videoBitrate ?? item.bitrate ?? null,
      totalBytes: item.size ?? item.fileSize ?? null,
      codec: item._codec,
      quality: item.qualityType ?? item.quality ?? item.height ?? null,
      label: item.qualityLabel ?? item.name ?? null,
      source: `note-stream-${item._codec}`,
    }));

    const originKey = video.consumer?.originVideoKey ?? video.originVideoKey;
    if (originKey) {
      candidates.push({
        url: /^https?:\/\//.test(originKey) ? originKey : `https://sns-video-bd.xhscdn.com/${originKey.replace(/^\//, "")}`,
        source: "origin-video-key",
      });
    }

    const directUrl = video.url ?? video.downloadUrl;
    if (directUrl && /xhscdn\.com/i.test(directUrl)) {
      candidates.push({ url: directUrl, source: "direct-video-url" });
    }

    const discoveredUrl = this._findCdnUrl(noteData);
    if (discoveredUrl) candidates.push({ url: discoveredUrl, source: "recursive-note-search" });
    const unique = [...new Map(candidates.filter((item) => item.url).map((item) => [item.url, item])).values()];
    return unique.sort((a, b) => this._compareCandidates(a, b));
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
    scored.sort((a, b) => this._compareCandidates(a.stream, b.stream));
    return scored[0] ?? null;
  }

  _streamScore(stream) {
    const width = Number(stream?.width ?? 0);
    const height = Number(stream?.height ?? 0);
    const pixels = width * height;
    const fps = this._normalizeFps(stream?.fps ?? stream?.frameRate);
    const bitrate = Number(stream?.avgBitrate ?? stream?.videoBitrate ?? 0);
    const size = Number(stream?.size ?? 0);
    const codecScore = /^(?:h264|avc)$/i.test(stream?._codec ?? stream?.codec ?? "") ? 1 : 0;
    return pixels * 1e9 + fps * 1e6 + bitrate + Math.min(size, 1_000_000_000) / 1_000 + codecScore / 100;
  }

  _selectBestCdnCandidate(candidates) {
    const scored = candidates
      .filter((candidate) => this._isVideoCdnUrl(candidate.url))
      .map((candidate) => ({
        candidate,
        score: Number(candidate.totalBytes ?? 0) + (candidate.url.includes("sns-video") ? 1_000 : 0),
      }));
    scored.sort((a, b) => this._compareCandidates(a.candidate, b.candidate));
    return scored[0]?.candidate ?? null;
  }

  _normalizeFps(value) {
    if (typeof value === "string" && value.includes("/")) {
      const [numerator, denominator] = value.split("/").map(Number);
      return denominator ? numerator / denominator : 0;
    }
    const fps = Number(value ?? 0);
    return Number.isFinite(fps) ? fps : 0;
  }

  _compareCandidates(a, b) {
    const differences = [
      Number(b.width ?? 0) * Number(b.height ?? 0) - Number(a.width ?? 0) * Number(a.height ?? 0),
      this._normalizeFps(b.fps ?? b.frameRate) - this._normalizeFps(a.fps ?? a.frameRate),
      Number(b.bitrate ?? b.avgBitrate ?? b.videoBitrate ?? 0) - Number(a.bitrate ?? a.avgBitrate ?? a.videoBitrate ?? 0),
      Number(b.totalBytes ?? b.size ?? b.fileSize ?? 0) - Number(a.totalBytes ?? a.size ?? a.fileSize ?? 0),
      (/^(?:h264|avc)$/i.test(b.codec ?? b._codec ?? "") ? 1 : 0) - (/^(?:h264|avc)$/i.test(a.codec ?? a._codec ?? "") ? 1 : 0),
      (/note-stream/i.test(b.source ?? "") ? 1 : 0) - (/note-stream/i.test(a.source ?? "") ? 1 : 0),
    ];
    return differences.find((difference) => difference !== 0) ?? 0;
  }

  _normalizeAvailableStreams(candidates, referer) {
    const unique = new Map();
    for (const candidate of candidates) {
      if (!candidate?.url || !this._isVideoCdnUrl(candidate.url) || unique.has(candidate.url)) continue;
      const width = Number(candidate.width) || null;
      const height = Number(candidate.height) || null;
      const fps = this._normalizeFps(candidate.fps ?? candidate.frameRate) || null;
      const bitrate = Number(candidate.bitrate ?? candidate.avgBitrate ?? candidate.videoBitrate) || null;
      const totalBytes = Number(candidate.totalBytes ?? candidate.size ?? candidate.fileSize) || null;
      const quality = candidate.quality ?? height;
      const label = candidate.label ?? (width && height ? `${width}x${height}${fps ? `@${fps}` : ""}` : null);
      unique.set(candidate.url, {
        url: candidate.url,
        type: "video+audio",
        format: "mp4",
        width,
        height,
        fps,
        bitrate,
        codec: candidate.codec ?? candidate._codec ?? null,
        quality,
        label,
        source: candidate.source ?? null,
        totalBytes,
        referer,
      });
    }
    return [...unique.values()].sort((a, b) => this._compareCandidates(a, b));
  }

  _buildQualityAudit(availableStreams, selected) {
    const qualities = [...new Set(availableStreams.map((stream) => stream.label ?? stream.quality).filter(Boolean))];
    return {
      advertisedQualities: qualities,
      accessibleQualities: qualities,
      selectedQuality: selected?.label ?? selected?.quality ?? null,
      selectionReason: "highest anonymous stream by resolution, frame rate, bitrate, and size; codec/source only break quality ties",
      limitedBy: null,
    };
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
