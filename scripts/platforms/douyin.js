import { PlatformParser } from "./base.js";
import { sanitizeName, itemKey, sleep, settleWithin } from "../utils/common.js";

const URL_PATTERNS = [
  /^https?:\/\/v\.douyin\.com\//i,
  /^https?:\/\/(?:www\.)?douyin\.com\/(?:video|note)\/\d+/i,
  /^https?:\/\/(?:www\.)?douyin\.com\/share\/(?:video|note)\/\d+/i,
  /^https?:\/\/(?:www\.)?douyin\.com\/discover\?.*\bmodal_id=\d+/i,
  /^https?:\/\/(?:www\.)?iesdouyin\.com\/share\/(?:video|note)\/\d+/i,
];

export class DouyinParser extends PlatformParser {
  static getPlatformName() {
    return "抖音";
  }

  static matchesUrl(url) {
    return URL_PATTERNS.some((pattern) => pattern.test(url));
  }

  async parse(browserManager, url, options) {
    const browser = await browserManager.start();
    const contextOptions = DouyinParser.getBrowserContextOptions(browserManager, options);

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    const candidates = [];
    const advertisedQualities = new Set();
    let detailStatus = null;
    let permanentReason = null;
    let detailMeta = null;

    const addCandidate = (candidate) => {
      const normalized = this._normalizeCandidate(candidate);
      if (!normalized) return;
      const existing = candidates.find((item) => item.url === normalized.url);
      if (!existing) {
        candidates.push(normalized);
        return;
      }
      for (const [key, value] of Object.entries(normalized)) {
        if (value == null || value === "" || value === 0) continue;
        if (existing[key] == null || existing[key] === "" || existing[key] === 0) existing[key] = value;
        if (["width", "height", "fps", "bitrate", "totalBytes"].includes(key)) {
          existing[key] = Math.max(Number(existing[key]) || 0, Number(value) || 0);
        }
      }
    };

    page.on("response", async (response) => {
      const responseUrl = response.url();
      const headers = response.headers();
      const contentType = headers["content-type"] ?? "";

      // Intercept CDN video responses
      if (/douyinvod\.com/i.test(responseUrl) || /^(?:video|audio)\//i.test(contentType)) {
        const total = Number(
          headers["content-range"]?.match(/\/(\d+)$/)?.[1] ?? headers["content-length"] ?? 0
        );
        const explicitType = contentType.startsWith("video/")
          ? (this._isDashVideoUrl(responseUrl) ? "video" : "video+audio")
          : contentType.startsWith("audio/") || this._isDashAudioUrl(responseUrl)
            ? "audio"
            : this._isDashVideoUrl(responseUrl) ? "video" : null;
        // An untyped CDN response may be an image, audio or an unrelated feed
        // resource. Only retain it when the URL itself identifies a DASH role.
        if (explicitType) {
          addCandidate({ url: responseUrl, type: explicitType, totalBytes: total, source: "media-response" });
        }
      }

      // Intercept detail API
      if (/\/aweme\/v1\/web\/aweme\/detail\//.test(responseUrl)) {
        detailStatus = response.status();
        if (response.ok()) {
          try {
            const json = await response.json();
            const detailCandidates = [];
            this._collectMediaUrls(json, detailCandidates);
            for (const candidate of detailCandidates) addCandidate(candidate);
            for (const quality of this._extractAdvertisedQualities(json)) advertisedQualities.add(quality);
            const statusCode = json?.status_code ?? json?.aweme_detail?.status?.is_delete;
            if (statusCode && statusCode !== 0) {
              permanentReason = `Douyin detail status: ${statusCode}`;
            }
            detailMeta = this._extractDetailMeta(json);
          } catch (e) { console.warn(`[douyin] failed to parse detail API response: ${e.message}`); }
        }
      }
    });

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options.pageTimeoutMs,
      });

      // Wait for media responses
      const deadline = Date.now() + options.mediaWaitMs;
      let firstSeenAt = null;
      while (Date.now() < deadline) {
        if (candidates.length > 0) {
          firstSeenAt ??= Date.now();
          if (Date.now() - firstSeenAt >= 2_000) break;
        }
        await sleep(250);
      }

      const finalUrl = page.url();
      const pageTitle = sanitizeName(await page.title().catch(() => ""));
      const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");

      for (const candidate of await this._collectRuntimeMediaCandidates(page)) {
        addCandidate(candidate);
      }

      // Check for permanent failures
      if (/作品不存在|视频不见了|已删除|暂无权限|私密作品/u.test(bodyText)) {
        permanentReason = bodyText.match(/作品不存在|视频不见了|已删除|暂无权限|私密作品/u)?.[0];
      }

      if (candidates.length === 0) {
        const challenge = /验证码|安全验证|完成验证|captcha/i.test(bodyText);
        const reason = permanentReason ?? (challenge
          ? "Douyin verification challenge"
          : `No media response (detail status ${detailStatus ?? "unknown"})`);
        const error = new Error(reason);
        error.permanent = Boolean(permanentReason);
        throw error;
      }

      candidates.sort((a, b) => this._compareCandidates(b, a));
      const mediaAlternatives = this._buildMediaAlternatives(candidates);
      const mediaStreams = mediaAlternatives[0] ?? [];
      if (mediaStreams.length === 0) {
        throw new Error("No valid Douyin media streams found");
      }

      const availableStreams = candidates.map((candidate) => this._publicStream(candidate));
      const selectedVideo = candidates.find((candidate) => candidate.url === mediaStreams[0]?.url);
      const accessibleQualities = [...new Set(
        candidates
          .filter((candidate) => candidate.type !== "audio")
          .map((candidate) => this._qualityLabel(candidate))
          .filter(Boolean)
      )];
      const selectedQuality = selectedVideo ? this._qualityLabel(selectedVideo) : null;

      const videoId = this._extractVideoId(finalUrl) ?? itemKey(url);

      return {
        platform: DouyinParser.getPlatformName(),
        sourceUrl: url,
        canonicalUrl: finalUrl,
        videoId,
        title: pageTitle,
        author: detailMeta?.author ?? { nickname: null, uid: null, url: null },
        description: detailMeta?.description ?? null,
        postTime: detailMeta?.post_time ?? null,
        duration: detailMeta?.duration ?? null,
        statistics: detailMeta?.statistics ?? {},
        referer: "https://www.douyin.com/",
        availableStreams,
        qualityAudit: {
          advertisedQualities: [...advertisedQualities],
          accessibleQualities,
          selectedQuality,
          selectionReason: "highest anonymous stream by resolution, frame rate, bitrate, then size",
        },
        mediaAlternatives,
        mediaStreams,
      };
    } finally {
      await settleWithin(context.close(), 5_000);
    }
  }

  _extractVideoId(url) {
    return url.match(/\/(?:video|note)\/(\d+)/)?.[1] ?? null;
  }

  _compareCandidates(a, b) {
    const score = (candidate) => [
      (candidate.width || 0) * (candidate.height || 0),
      candidate.quality || 0,
      candidate.fps || 0,
      candidate.bitrate || 0,
      candidate.totalBytes || 0,
    ];
    const left = score(a);
    const right = score(b);
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return left[i] - right[i];
    }
    return 0;
  }

  _buildMediaAlternatives(candidates) {
    const mergedCandidates = candidates.filter((candidate) => candidate.type === "video+audio");
    const dashVideos = candidates.filter((candidate) => candidate.type === "video");
    const dashAudios = candidates
      .filter((candidate) => candidate.type === "audio")
      .sort((a, b) => this._compareCandidates(b, a));
    const alternatives = mergedCandidates.map((candidate) => [this._stream(candidate)]);

    for (const video of dashVideos) {
      const audio = dashAudios[0] ?? this._normalizeCandidate(this._deriveDashAudioCandidate(video));
      if (audio) alternatives.push([this._stream(video), this._stream(audio)]);
    }

    return alternatives.sort((left, right) => {
      const leftCandidate = candidates.find((item) => item.url === left[0].url) ?? left[0];
      const rightCandidate = candidates.find((item) => item.url === right[0].url) ?? right[0];
      return this._compareCandidates(rightCandidate, leftCandidate);
    });
  }

  _stream(candidate) {
    return {
      url: candidate.url,
      type: candidate.type,
      format: candidate.format || "mp4",
      ...(candidate.quality ? { quality: candidate.quality } : {}),
      referer: "https://www.douyin.com/",
    };
  }

  _isDashVideoUrl(url) {
    return /media-video-/i.test(url);
  }

  _isDashAudioUrl(url) {
    return /media-audio-/i.test(url);
  }

  _deriveDashAudioCandidate(videoCandidate) {
    if (!this._isDashVideoUrl(videoCandidate.url)) return null;
    const variants = ["media-audio-und-mp4a", "media-audio-mp4a"];
    for (const audioSegment of variants) {
      const audioUrl = videoCandidate.url.replace(/media-video-[^/?]+/i, audioSegment);
      if (audioUrl !== videoCandidate.url) {
        return {
          url: audioUrl,
          totalBytes: 0,
          source: "derived-dash-audio",
        };
      }
    }
    return null;
  }

  async _collectRuntimeMediaCandidates(page) {
    return await page.evaluate(() => {
      const candidates = [];
      const push = (url, source, totalBytes = 0) => {
        if (!url || !/^https?:\/\//i.test(url)) return;
        if (!/(douyinvod\.com|aweme\/v1\/play)/i.test(url)) return;
        if (candidates.some((item) => item.url === url)) return;
        const type = /media-audio-/i.test(url)
          ? "audio"
          : /media-video-/i.test(url) ? "video" : source === "video-current-src" ? "video+audio" : null;
        if (type) candidates.push({ url, type, totalBytes, source });
      };

      for (const video of document.querySelectorAll("video")) {
        push(video.currentSrc || video.src, "video-current-src");
      }

      for (const entry of performance.getEntriesByType("resource")) {
        push(entry.name, "performance-resource", entry.encodedBodySize || entry.transferSize || 0);
      }

      return candidates;
    }).catch(() => []);
  }

  _collectMediaUrls(value, results) {
    const detail = value?.aweme_detail ?? value;
    const video = detail?.video;
    if (!video || typeof video !== "object") return;

    const walk = (node, inherited = {}, path = [], depth = 0) => {
      if (!node || typeof node !== "object" || depth > 12) return;
      // Covers and animated posters can also live on douyinvod.com and even use
      // MP4 containers, but they are not the target video's playable stream.
      if (/cover|poster|thumbnail|avatar/i.test(path.join("."))) return;
      const metadata = {
        width: Number(node.width ?? inherited.width ?? 0),
        height: Number(node.height ?? inherited.height ?? 0),
        fps: Number(node.fps ?? node.FPS ?? node.video_fps ?? inherited.fps ?? 0),
        bitrate: Number(node.bit_rate ?? node.bitrate ?? inherited.bitrate ?? 0),
        codec: node.codec_type ?? node.codec ?? inherited.codec ?? null,
        quality: Number(node.quality_type ?? inherited.quality ?? 0),
        label: node.gear_name ?? node.quality_label ?? node.ratio ?? inherited.label ?? null,
        totalBytes: Number(node.data_size ?? node.file_size ?? inherited.totalBytes ?? 0),
      };
      const urls = Array.isArray(node.url_list) ? node.url_list : [];
      for (const rawUrl of urls) {
        if (typeof rawUrl !== "string") continue;
        const url = rawUrl.replaceAll("\\u0026", "&");
        if (!/^https?:\/\//i.test(url) || !/(douyinvod\.com|aweme\/v1\/play)/i.test(url)) continue;
        const pathText = path.join(".");
        const type = this._isDashAudioUrl(url) || /audio/i.test(pathText)
          ? "audio"
          : this._isDashVideoUrl(url) ? "video" : "video+audio";
        results.push({ url, type, source: "detail-json", ...metadata });
      }
      for (const [key, child] of Object.entries(node)) {
        if (key === "url_list") continue;
        if (Array.isArray(child)) {
          for (const item of child) walk(item, metadata, [...path, key], depth + 1);
        } else if (child && typeof child === "object") {
          walk(child, metadata, [...path, key], depth + 1);
        }
      }
    };
    walk(video, { width: video.width, height: video.height }, ["video"]);
  }

  _extractAdvertisedQualities(value) {
    const video = (value?.aweme_detail ?? value)?.video;
    if (!video || typeof video !== "object") return [];
    const qualities = [];
    for (const entry of video.bit_rate ?? []) {
      const label = entry?.gear_name ?? entry?.quality_label ?? entry?.ratio;
      if (label) qualities.push(String(label));
    }
    return [...new Set(qualities)];
  }

  _normalizeCandidate(candidate) {
    if (!candidate || !/^https?:\/\//i.test(candidate.url ?? "")) return null;
    const url = candidate.url.replaceAll("\\u0026", "&");
    let bitrate = Number(candidate.bitrate ?? 0);
    if (!bitrate) {
      try { bitrate = Number(new URL(url).searchParams.get("br") ?? 0); } catch {}
    }
    const width = Number(candidate.width ?? 0);
    const height = Number(candidate.height ?? 0);
    const type = candidate.type ?? (this._isDashAudioUrl(url)
      ? "audio" : this._isDashVideoUrl(url) ? "video" : null);
    if (!type) return null;
    return {
      url,
      type,
      format: "mp4",
      width,
      height,
      fps: Number(candidate.fps ?? 0),
      bitrate,
      codec: candidate.codec ? String(candidate.codec) : null,
      // Douyin's quality_type is an internal enum, not a vertical resolution.
      // Expose the short edge as the normalized quality whenever dimensions exist.
      quality: width && height ? Math.min(width, height) : Number(candidate.quality ?? 0),
      label: candidate.label ? String(candidate.label) : null,
      source: candidate.source ?? "unknown",
      totalBytes: Number(candidate.totalBytes ?? 0),
      referer: "https://www.douyin.com/",
    };
  }

  _publicStream(candidate) {
    return {
      url: candidate.url,
      type: candidate.type,
      format: candidate.format,
      width: candidate.width || null,
      height: candidate.height || null,
      fps: candidate.fps || null,
      bitrate: candidate.bitrate || null,
      codec: candidate.codec,
      quality: candidate.quality || null,
      label: candidate.label,
      source: candidate.source,
      totalBytes: candidate.totalBytes || null,
      referer: candidate.referer,
    };
  }

  _qualityLabel(candidate) {
    if (candidate.label) return candidate.label;
    if (candidate.width && candidate.height) return `${candidate.width}x${candidate.height}`;
    if (candidate.quality) return `${candidate.quality}P`;
    return candidate.type === "video+audio" ? "muxed" : candidate.type === "video" ? "video" : null;
  }

  _extractDetailMeta(json) {
    const detail = json?.aweme_detail ?? json;
    if (!detail || typeof detail !== "object") return null;

    const author = detail.author ?? {};
    const stats = detail.statistics ?? detail.stats ?? {};
    const createTime = detail.create_time;

    return {
      author: {
        nickname: author.nickname ?? null,
        uid: author.uid ?? author.sec_uid ?? null,
        url: author.sec_uid ? `https://www.douyin.com/user/${author.sec_uid}` : null,
      },
      description: detail.desc ?? null,
      duration: (() => {
        const raw = detail.duration ?? detail.video?.duration ?? null;
        return raw != null ? Math.round(raw / 1000) : null;
      })(),
      post_time: createTime
        ? new Date(createTime * 1000).toISOString().replace("T", " ").slice(0, 19)
        : null,
      statistics: {
        play_count: stats.play_count ?? stats.vv ?? null,
        digg_count: stats.digg_count ?? stats.digg ?? null,
        comment_count: stats.comment_count ?? null,
        share_count: stats.share_count ?? stats.share ?? null,
        collect_count: stats.collect_count ?? null,
      },
    };
  }
}
