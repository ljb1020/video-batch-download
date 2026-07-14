import { PlatformParser } from "./base.js";
import { itemKey, sleep, settleWithin } from "../utils/common.js";

const URL_PATTERNS = [
  /^https?:\/\/(?:www\.)?kuaishou\.com\/short-video\//i,
  /^https?:\/\/v\.kuaishou\.com\//i,
  /^https?:\/\/(?:www\.)?kuaishou\.com\/f\//i,
  /^https?:\/\/m\.kuaishou\.com\/(?:v|short-video)\//i,
  /^https?:\/\/(?:www\.)?gifshow\.com\//i,
];

export class KuaishouParser extends PlatformParser {
  static getPlatformName() {
    return "快手";
  }

  static matchesUrl(url) {
    return URL_PATTERNS.some((pattern) => pattern.test(url));
  }

  async parse(browserManager, url, options) {
    const browser = await browserManager.start();
    const contextOptions = KuaishouParser.getBrowserContextOptions(browserManager, options);
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    const mediaCandidates = [];
    const interceptedDetails = new Map();
    let permanentReason = null;
    let riskControlled = false;

    const addMediaCandidate = (candidate) => {
      if (!candidate.url || mediaCandidates.some((item) => item.url === candidate.url)) return;
      mediaCandidates.push(candidate);
    };

    page.on("response", async (response) => {
      const responseUrl = response.url();
      const headers = response.headers();
      const contentType = headers["content-type"] ?? "";

      if (headers["intercept-result"]?.includes("risk-control")) {
        riskControlled = true;
      }

      if (this._isMediaUrl(responseUrl) || contentType.startsWith("video/")) {
        const total = Number(
          headers["content-range"]?.match(/\/(\d+)$/)?.[1] ?? headers["content-length"] ?? 0
        );
        addMediaCandidate({ url: responseUrl, totalBytes: total, source: "media-response" });
      }

      if (/\/graphql(?:[?#]|$)/i.test(responseUrl) && response.ok()) {
        try {
          const json = await response.json();
          const detail = this._extractGraphqlDetail(json);
          const photoId = detail?.photo?.id;
          if (photoId) interceptedDetails.set(String(photoId), detail);
        } catch (error) {
          console.warn(`[kuaishou] failed to parse GraphQL response: ${error.message}`);
        }
      }
    });

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options.pageTimeoutMs,
      });

      const finalUrl = page.url();
      const targetVideoId = this._extractVideoId(finalUrl) ?? this._extractVideoId(url);
      let pageDetail = null;

      const deadline = Date.now() + options.mediaWaitMs;
      while (Date.now() < deadline) {
        if (targetVideoId) {
          pageDetail ??= await this._extractDetailFromPage(page, targetVideoId);
          if (pageDetail || interceptedDetails.has(targetVideoId)) break;
        }
        await sleep(250);
      }

      const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
      if (/该视频已删除|视频不存在|暂无权限|该作品已删除|无法查看/u.test(bodyText)) {
        permanentReason = bodyText.match(/该视频已删除|视频不存在|暂无权限|该作品已删除|无法查看/u)?.[0];
      }

      if (!targetVideoId) {
        throw new Error("Could not determine the target Kuaishou photo ID after redirect");
      }

      const detail = pageDetail ?? interceptedDetails.get(targetVideoId) ?? null;
      if (detail?.photo?.id && String(detail.photo.id) !== targetVideoId) {
        throw new Error(`Kuaishou detail photo ID mismatch: expected ${targetVideoId}, got ${detail.photo.id}`);
      }

      const exactResponseCandidates = mediaCandidates.filter((candidate) =>
        this._candidateMatchesVideoId(candidate.url, targetVideoId)
      );
      const detailCandidates = this._collectDetailMediaCandidates(detail?.photo);
      const candidates = [...detailCandidates, ...exactResponseCandidates];

      if (candidates.length === 0) {
        const challenge = riskControlled || /验证|滑块|captcha|风控/i.test(bodyText);
        const reason = permanentReason ?? (challenge
          ? "Kuaishou verification challenge"
          : `No target media found (photoId: ${targetVideoId})`);
        const error = new Error(reason);
        error.permanent = Boolean(permanentReason);
        throw error;
      }

      candidates.sort((a, b) => this._candidateScore(b) - this._candidateScore(a));
      const selected = candidates[0];
      const rawPageTitle = await page.title().catch(() => "");
      const pageTitle = rawPageTitle.replace(/[-_]快手\s*$/u, "").trim();
      const photo = detail?.photo ?? {};
      const authorData = detail?.author ?? {};
      const caption = photo.caption ?? photo.originCaption ?? pageTitle ?? null;
      const authorId = authorData.id ?? this._extractUserId(finalUrl);

      return {
        platform: KuaishouParser.getPlatformName(),
        sourceUrl: url,
        canonicalUrl: finalUrl,
        videoId: targetVideoId ?? itemKey(url),
        title: caption,
        author: {
          nickname: authorData.name ?? null,
          uid: authorId ? String(authorId) : null,
          url: authorId ? `https://www.kuaishou.com/profile/${authorId}` : null,
        },
        description: photo.originCaption ?? caption,
        postTime: this._formatPostTime(photo.timestamp),
        duration: this._normalizeDuration(photo.duration),
        statistics: {
          view_count: this._normalizeCount(photo.viewCount),
          like_count: this._normalizeCount(photo.realLikeCount ?? photo.likeCount),
          comment_count: this._normalizeCount(photo.commentCount),
          share_count: this._normalizeCount(photo.shareCount),
        },
        referer: finalUrl,
        mediaStreams: [
          {
            url: selected.url,
            type: "video+audio",
            format: "mp4",
            quality: selected.height ?? null,
            referer: finalUrl,
          },
        ],
      };
    } finally {
      await settleWithin(context.close(), 5_000);
    }
  }

  _extractGraphqlDetail(json) {
    const detail = json?.data?.visionVideoDetail;
    if (!detail?.photo?.id) return null;
    return detail;
  }

  async _extractDetailFromPage(page, targetVideoId) {
    return await page.evaluate((photoId) => {
      const state = window.__APOLLO_STATE__?.defaultClient;
      if (!state || typeof state !== "object") return null;

      const resolveRef = (value) => {
        if (!value || typeof value !== "object") return value;
        if (value.type === "json") return value.json;
        if (typeof value.id === "string" && state[value.id]) return state[value.id];
        return value;
      };

      const detailKey = Object.keys(state).find((key) =>
        key.startsWith("$ROOT_QUERY.visionVideoDetail") && key.includes(photoId)
      );
      const detail = detailKey ? state[detailKey] : null;
      const photo = resolveRef(detail?.photo) ?? state[`VisionVideoDetailPhoto:${photoId}`] ?? null;
      if (!photo || String(photo.id) !== String(photoId)) return null;

      return {
        status: detail?.status ?? null,
        type: detail?.type ?? null,
        author: resolveRef(detail?.author) ?? null,
        photo,
      };
    }, targetVideoId).catch(() => null);
  }

  _collectDetailMediaCandidates(photo) {
    if (!photo || typeof photo !== "object") return [];
    const candidates = [];
    const seen = new Set();
    const add = (url, metadata = {}) => {
      if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url) || seen.has(url)) return;
      if (!this._isMediaUrl(url)) return;
      seen.add(url);
      candidates.push({ url, source: "target-detail", ...metadata });
    };

    add(photo.photoUrl, { codec: "h264", priority: 4 });
    this._collectManifestCandidates(photo.videoResource?.json?.h264 ?? photo.videoResource?.h264, add, {
      codec: "h264",
      priority: 3,
    });
    this._collectManifestCandidates(photo.manifest?.json ?? photo.manifest, add, {
      codec: "h264",
      priority: 2,
    });
    add(photo.photoH265Url, { codec: "hevc", priority: 1 });
    this._collectManifestCandidates(photo.manifestH265?.json ?? photo.manifestH265, add, {
      codec: "hevc",
      priority: 0,
    });
    return candidates;
  }

  _collectManifestCandidates(manifest, add, defaults = {}) {
    for (const set of manifest?.adaptationSet ?? []) {
      for (const representation of set?.representation ?? []) {
        add(representation?.url, {
          ...defaults,
          width: representation?.width ?? null,
          height: representation?.height ?? null,
          bitrate: representation?.avgBitrate ?? representation?.maxBitrate ?? 0,
          totalBytes: representation?.fileSize ?? 0,
        });
        for (const backupUrl of representation?.backupUrl ?? []) {
          add(backupUrl, {
            ...defaults,
            width: representation?.width ?? null,
            height: representation?.height ?? null,
            bitrate: representation?.avgBitrate ?? representation?.maxBitrate ?? 0,
            totalBytes: representation?.fileSize ?? 0,
          });
        }
      }
    }
  }

  _extractVideoId(url) {
    return url.match(/\/short-video\/([\w-]+)/i)?.[1]
      ?? url.match(/\/f\/([\w-]+)/i)?.[1]
      ?? url.match(/[?&]photoId=([\w-]+)/i)?.[1]
      ?? null;
  }

  _extractUserId(url) {
    try {
      return new URL(url).searchParams.get("userId");
    } catch {
      return null;
    }
  }

  _isMediaUrl(url) {
    return /^https?:\/\//i.test(url)
      && /(?:\.mp4(?:[?#]|$)|djvod\.ndcimgs\.com|kwaicdn\.com|yximgs\.com|gifshow\.com)/i.test(url);
  }

  _candidateMatchesVideoId(url, videoId) {
    if (!url || !videoId) return false;
    try {
      return decodeURIComponent(url).includes(videoId);
    } catch {
      return url.includes(videoId);
    }
  }

  _candidateScore(candidate) {
    const priority = candidate.priority ?? -1;
    const pixels = Number(candidate.width ?? 0) * Number(candidate.height ?? 0);
    const bitrate = Number(candidate.bitrate ?? 0);
    const bytes = Number(candidate.totalBytes ?? 0);
    return priority * 1e15 + pixels * 1e6 + bitrate * 1e3 + bytes;
  }

  _normalizeDuration(value) {
    const duration = Number(value);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return duration > 1_000 ? Math.round(duration / 100) / 10 : duration;
  }

  _formatPostTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    const millis = timestamp < 1e12 ? timestamp * 1_000 : timestamp;
    return new Date(millis).toISOString().replace("T", " ").slice(0, 19);
  }

  _normalizeCount(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const text = String(value).trim().replace(/,/g, "");
    const match = text.match(/^([\d.]+)\s*([万亿])?$/u);
    if (!match) return value;
    const multiplier = match[2] === "亿" ? 100_000_000 : match[2] === "万" ? 10_000 : 1;
    return Math.round(Number(match[1]) * multiplier);
  }
}
