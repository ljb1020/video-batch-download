import { PlatformParser } from "./base.js";
import { sanitizeName, itemKey, sleep, settleWithin } from "../utils/common.js";

const URL_PATTERNS = [
  /^https?:\/\/v\.douyin\.com\//i,
  /^https?:\/\/(?:www\.)?douyin\.com\//i,
  /^https?:\/\/(?:www\.)?iesdouyin\.com\//i,
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
    let detailStatus = null;
    let permanentReason = null;
    let detailMeta = null;

    const addCandidate = (candidate) => {
      if (!candidate.url || candidates.some((item) => item.url === candidate.url)) {
        return;
      }
      candidates.push(candidate);
    };

    page.on("response", async (response) => {
      const responseUrl = response.url();
      const headers = response.headers();
      const contentType = headers["content-type"] ?? "";

      // Intercept CDN video responses
      if (/douyinvod\.com/i.test(responseUrl) || contentType.startsWith("video/")) {
        const total = Number(
          headers["content-range"]?.match(/\/(\d+)$/)?.[1] ?? headers["content-length"] ?? 0
        );
        addCandidate({ url: responseUrl, totalBytes: total, source: "media-response" });
      }

      // Intercept detail API
      if (/\/aweme\/v1\/web\/aweme\/detail\//.test(responseUrl)) {
        detailStatus = response.status();
        if (response.ok()) {
          try {
            const json = await response.json();
            this._collectMediaUrls(json, candidates);
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

      // Sort candidates by quality
      candidates.sort((a, b) => this._candidateScore(b) - this._candidateScore(a));
      const mediaStreams = this._selectMediaStreams(candidates);
      if (mediaStreams.length === 0) {
        throw new Error("No valid Douyin media streams found");
      }

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
        mediaStreams: mediaStreams.map((stream) => ({
          ...stream,
          referer: "https://www.douyin.com/",
        })),
      };
    } finally {
      await settleWithin(context.close(), 5_000);
    }
  }

  _extractVideoId(url) {
    return url.match(/\/(?:video|note)\/(\d+)/)?.[1] ?? null;
  }

  _candidateScore(candidate) {
    let bitrate = 0;
    try {
      bitrate = Number(new URL(candidate.url).searchParams.get("br") ?? 0);
    } catch {}
    return (candidate.totalBytes ?? 0) * 10 + bitrate;
  }

  _selectMediaStreams(candidates) {
    const mergedCandidates = candidates.filter((candidate) =>
      !this._isDashVideoUrl(candidate.url) && !this._isDashAudioUrl(candidate.url)
    );
    const dashVideos = candidates.filter((candidate) => this._isDashVideoUrl(candidate.url));
    const dashAudios = candidates.filter((candidate) => this._isDashAudioUrl(candidate.url));
    const best = candidates[0];

    if (best && this._isDashVideoUrl(best.url)) {
      if (dashAudios[0]) return this._dashStreams(best, dashAudios[0]);
      if (mergedCandidates[0]) return [this._mergedStream(mergedCandidates[0])];
      const audio = this._deriveDashAudioCandidate(best);
      if (audio) return this._dashStreams(best, audio);
      const err = new Error("Douyin DASH audio stream not found");
      err.permanent = true;
      throw err;
    }

    if (mergedCandidates[0]) return [this._mergedStream(mergedCandidates[0])];

    if (dashVideos[0]) {
      const audio = dashAudios[0] ?? this._deriveDashAudioCandidate(dashVideos[0]);
      if (audio) return this._dashStreams(dashVideos[0], audio);
      const err = new Error("Douyin DASH audio stream not found");
      err.permanent = true;
      throw err;
    }

    return [];
  }

  _mergedStream(candidate) {
    return {
      url: candidate.url,
      type: "video+audio",
      format: "mp4",
    };
  }

  _dashStreams(video, audio) {
    return [
      {
        url: video.url,
        type: "video",
        format: "mp4",
      },
      {
        url: audio.url,
        type: "audio",
        format: "mp4",
      },
    ];
  }

  _isDashVideoUrl(url) {
    return /media-video-avc1/i.test(url);
  }

  _isDashAudioUrl(url) {
    return /media-audio-mp4a/i.test(url);
  }

  _deriveDashAudioCandidate(videoCandidate) {
    if (!this._isDashVideoUrl(videoCandidate.url)) return null;
    const audioUrl = videoCandidate.url.replace(/media-video-avc1/ig, "media-audio-mp4a");
    if (audioUrl === videoCandidate.url) return null;
    return {
      url: audioUrl,
      totalBytes: 0,
      source: "derived-dash-audio",
    };
  }

  _collectMediaUrls(value, results, depth = 0) {
    if (depth > 12 || value == null) return;
    if (typeof value === "string") {
      if (/^https?:\/\//.test(value) && /(douyinvod\.com|aweme\/v1\/play)/i.test(value)) {
        results.push({
          url: value.replaceAll("\\u0026", "&"),
          totalBytes: 0,
          source: "detail-json",
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) this._collectMediaUrls(child, results, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const child of Object.values(value)) {
        this._collectMediaUrls(child, results, depth + 1);
      }
    }
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
