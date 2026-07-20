import { PlatformError, PlatformParser, preferPlatformError } from "./base.js";
import { sleep, settleWithin } from "../utils/common.js";

const URL_PATTERNS = [
  /^https?:\/\/video\.weibo\.com\/show\?(?:[^#]*&)?fid=1034:\d+(?:[&#]|$)/i,
  /^https?:\/\/(?:www\.)?weibo\.com\/tv\/show\/1034:\d+(?:[/?#]|$)/i,
];

const COMPONENT_API_PATTERN = /\/tv\/api\/component(?:[/?#]|$)/i;
const PERMANENT_ERROR_PATTERN = /视频不存在|视频已删除|内容不存在|内容已删除|暂无权限|无权查看|仅自己可见|抱歉.*(?:不存在|删除)/u;

export class WeiboParser extends PlatformParser {
  static getPlatformName() {
    return "微博";
  }

  static getSlug() {
    return "weibo";
  }

  static matchesUrl(url) {
    return URL_PATTERNS.some((pattern) => pattern.test(url));
  }

  async parse(browserManager, url, options) {
    const targetOid = this._extractOid(url);
    if (!targetOid) {
      throw new PlatformError("Invalid Weibo video URL: missing fid/oid", {
        code: "INVALID_URL",
        category: "content",
        permanent: true,
        retryable: false,
        userMessage: "微博视频链接无效（缺少 fid/oid），已跳过。",
      });
    }

    const browser = await browserManager.start();
    const contextOptions = WeiboParser.getBrowserContextOptions(browserManager, options);
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    const candidates = [];
    let playInfo = null;
    let componentStatus = null;
    let componentError = null;
    let permanentError = null;

    const addCandidate = (candidate) => {
      const normalizedUrl = this._normalizeUrl(candidate?.url);
      if (!normalizedUrl || !this._isWeiboMediaUrl(normalizedUrl)) return;
      if (candidates.some((item) => item.url === normalizedUrl)) return;

      const dimensions = this._extractDimensions(normalizedUrl, candidate?.label);
      candidates.push({
        ...candidate,
        url: normalizedUrl,
        width: Number(candidate?.width ?? dimensions.width ?? 0),
        height: Number(candidate?.height ?? dimensions.height ?? 0),
        quality: Number(candidate?.quality ?? dimensions.quality ?? 0),
      });
    };

    page.on("response", async (response) => {
      const responseUrl = response.url();

      if (COMPONENT_API_PATTERN.test(responseUrl) && response.request().method() === "POST") {
        const requestedOid = this._extractRequestedOid(response.request().postData());
        if (requestedOid !== targetOid) return;

        componentStatus = response.status();
        try {
          const json = await response.json();
          if (String(json?.code) !== "100000") {
            componentError = json?.msg || `Weibo component API code ${json?.code ?? "unknown"}`;
            if (PERMANENT_ERROR_PATTERN.test(componentError)) {
              permanentError = preferPlatformError(permanentError, new PlatformError(componentError, {
                code: /暂无权限|无权查看|仅自己可见/u.test(componentError)
                  ? "CONTENT_PRIVATE"
                  : "CONTENT_DELETED",
                category: "content",
                permanent: true,
                retryable: false,
                userMessage: `微博视频${componentError}，已跳过。`,
              }));
            }
            return;
          }

          const info = json?.data?.Component_Play_Playinfo;
          const responseOid = String(info?.oid ?? info?.id ?? info?.idstr ?? "");
          if (responseOid !== targetOid) return;

          playInfo = info;
          for (const [label, mediaUrl] of Object.entries(info.urls ?? {})) {
            addCandidate({ url: mediaUrl, label, source: "component-api" });
          }
          addCandidate({ url: info.stream_url, label: "stream", source: "component-api-fallback" });
        } catch (error) {
          componentError = `Failed to parse Weibo component response: ${error.message}`;
        }
        return;
      }

      if (!this._isWeiboMediaUrl(responseUrl) || !this._mediaUrlMatchesOid(responseUrl, targetOid)) {
        return;
      }

      const headers = response.headers();
      const totalBytes = Number(
        headers["content-range"]?.match(/\/(\d+)$/)?.[1] ?? headers["content-length"] ?? 0
      );
      addCandidate({ url: responseUrl, totalBytes, source: "media-response" });
    });

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options.pageTimeoutMs,
      });

      const deadline = Date.now() + options.mediaWaitMs;
      let firstSeenAt = null;
      while (Date.now() < deadline) {
        if (playInfo && candidates.length > 0) {
          firstSeenAt ??= Date.now();
          if (Date.now() - firstSeenAt >= 1_000) break;
        }
        await sleep(250);
      }

      const finalUrl = page.url();
      const finalOid = this._extractOid(finalUrl);
      const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
      const pageTitle = await page.title().catch(() => "");

      if (finalOid && finalOid !== targetOid) {
        throw new PlatformError(`Weibo redirected to a different video (${finalOid})`, {
          code: "CONTENT_UNAVAILABLE",
          category: "content",
          permanent: true,
          retryable: false,
          userMessage: "微博跳转到了其他视频，已跳过。",
        });
      }

      const pagePermanentReason = bodyText.match(PERMANENT_ERROR_PATTERN)?.[0] ?? null;
      if (pagePermanentReason) {
        permanentError = preferPlatformError(permanentError, new PlatformError(pagePermanentReason, {
          code: /暂无权限|无权查看|仅自己可见/u.test(pagePermanentReason)
            ? "CONTENT_PRIVATE"
            : "CONTENT_DELETED",
          category: "content",
          permanent: true,
          retryable: false,
          userMessage: `微博视频${pagePermanentReason}，已跳过。`,
        }));
      }

      for (const candidate of await this._collectRuntimeMediaCandidates(page, targetOid)) {
        addCandidate(candidate);
      }

      if (permanentError?.permanent) {
        throw permanentError;
      }

      if (candidates.length === 0) {
        if (permanentError) throw permanentError;
        const challenge = /验证码|安全验证|访问频次|账号登录|请先登录|passport\.weibo/i.test(bodyText + finalUrl);
        if (challenge) {
          throw new PlatformError("Weibo verification/login challenge", {
            code: "VERIFICATION_REQUIRED",
            category: "access",
            retryable: true,
            retryScope: "item",
            userMessage: "微博触发验证码/登录限制，稍后会按重试策略再试。",
            suggestion: "如果反复出现，可使用 --headed 手动验证，或提供 --storage-state 登录态。",
          });
        }
        if (componentError) {
          throw new PlatformError(componentError, {
            code: "PLATFORM_API_ERROR",
            category: "platform",
            retryable: true,
            retryScope: "item",
            userMessage: "微博接口返回异常，稍后会重新解析。",
          });
        }
        throw new PlatformError(
          `No Weibo media found (component status ${componentStatus ?? "unknown"})`,
          {
            code: "MEDIA_DISCOVERY_FAILED",
            category: "platform",
            retryable: true,
            retryScope: "item",
            userMessage: "没有捕获到微博视频媒体地址，稍后会重新解析。",
          }
        );
      }

      candidates.sort((a, b) => this._candidateScore(b) - this._candidateScore(a));
      const best = candidates[0];
      const canonicalUrl = `https://weibo.com/tv/show/${targetOid}`;
      const referer = canonicalUrl;
      const authorId = playInfo?.author_id ?? playInfo?.user?.id ?? null;
      const toStream = (candidate) => ({
        url: candidate.url,
        type: "video+audio",
        format: "mp4",
        width: candidate.width || null,
        height: candidate.height || null,
        quality: candidate.quality || Math.min(candidate.width || 0, candidate.height || 0) || null,
        label: candidate.label ?? null,
        source: candidate.source ?? null,
        totalBytes: candidate.totalBytes || null,
        referer,
      });
      const availableStreams = candidates.map(toStream);
      const mediaAlternatives = availableStreams.map((stream) => [stream]);
      const advertisedQualities = Object.keys(playInfo?.urls ?? {});
      const accessibleQualities = [...new Set(candidates.map((candidate) =>
        candidate.label || (candidate.quality ? `${candidate.quality}P` : null)
      ).filter(Boolean))];

      return {
        platform: WeiboParser.getPlatformName(),
        sourceUrl: url,
        canonicalUrl,
        videoId: targetOid,
        title: playInfo?.text?.trim() || playInfo?.title?.trim() || pageTitle || "",
        author: {
          nickname: playInfo?.nickname ?? playInfo?.author ?? null,
          uid: authorId != null ? String(authorId) : null,
          url: authorId != null ? `https://weibo.com/u/${authorId}` : null,
        },
        description: playInfo?.text?.trim() || null,
        postTime: this._formatPostTime(playInfo?.real_date),
        duration: this._normalizeDuration(playInfo?.duration_time ?? playInfo?.duration),
        statistics: {
          play_count: this._normalizeCount(playInfo?.play_count),
          like_count: this._normalizeCount(playInfo?.attitudes_count),
          comment_count: this._normalizeCount(playInfo?.comments_count),
          share_count: this._normalizeCount(playInfo?.reposts_count),
        },
        referer,
        mediaStreams: [toStream(best)],
        mediaAlternatives,
        availableStreams,
        qualityAudit: {
          advertisedQualities,
          accessibleQualities,
          selectedQuality: best.label || (best.quality ? `${best.quality}P` : null),
          selectionReason: "Highest-resolution muxed MP4 exposed to the anonymous Weibo session",
          limitedBy: null,
        },
      };
    } finally {
      await settleWithin(context.close(), 5_000);
    }
  }

  _extractOid(url) {
    try {
      const parsed = new URL(url);
      const fid = parsed.searchParams.get("fid");
      if (/^1034:\d+$/.test(fid ?? "")) return fid;
      return parsed.pathname.match(/\/tv\/show\/(1034:\d+)(?:\/|$)/i)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  _extractRequestedOid(postData) {
    if (!postData) return null;
    try {
      const form = new URLSearchParams(postData);
      const data = JSON.parse(form.get("data") ?? "{}");
      return String(data?.Component_Play_Playinfo?.oid ?? "") || null;
    } catch {
      return null;
    }
  }

  _normalizeUrl(url) {
    if (typeof url !== "string" || !url.trim()) return null;
    if (url.startsWith("//")) return `https:${url}`;
    if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`;
    return /^https:\/\//i.test(url) ? url : null;
  }

  _isWeiboMediaUrl(url) {
    try {
      const parsed = new URL(url);
      return /(?:^|\.)weibocdn\.com$/i.test(parsed.hostname) && /\.mp4(?:$|[?#])/i.test(url);
    } catch {
      return false;
    }
  }

  _mediaUrlMatchesOid(url, oid) {
    try {
      const mediaId = new URL(url).searchParams.get("media_id");
      return mediaId === oid.split(":").at(-1);
    } catch {
      return false;
    }
  }

  _extractDimensions(url, label = "") {
    let template = "";
    try {
      template = new URL(url).searchParams.get("template") ?? "";
    } catch {}

    const match = template.match(/(\d+)x(\d+)/i);
    const width = Number(match?.[1] ?? 0);
    const height = Number(match?.[2] ?? 0);
    const labelQuality = Number(String(label).match(/(\d{3,4})\s*[pP]/)?.[1] ?? 0);
    return { width, height, quality: labelQuality || Math.min(width, height) || 0 };
  }

  _candidateScore(candidate) {
    const pixels = Number(candidate.width ?? 0) * Number(candidate.height ?? 0);
    const quality = Number(candidate.quality ?? 0);
    const totalBytes = Number(candidate.totalBytes ?? 0);
    const apiPriority = candidate.source === "component-api" ? 1 : 0;
    return pixels * 1e9 + quality * 1e6 + apiPriority * 1e5 + Math.min(totalBytes, 1e12);
  }

  async _collectRuntimeMediaCandidates(page, targetOid) {
    return await page.evaluate((oid) => {
      const mediaId = oid.split(":").pop();
      const candidates = [];
      const push = (url, source) => {
        if (!url || !/^https?:\/\//i.test(url) || !/weibocdn\.com/i.test(url)) return;
        let candidateMediaId = null;
        try { candidateMediaId = new URL(url).searchParams.get("media_id"); } catch {}
        if (candidateMediaId && candidateMediaId !== mediaId) return;
        if (!candidates.some((candidate) => candidate.url === url)) candidates.push({ url, source });
      };

      const videos = [...document.querySelectorAll("video")];
      for (const video of videos) push(video.currentSrc || video.src, "video-current-src");

      for (const entry of performance.getEntriesByType("resource")) {
        let entryMediaId = null;
        try { entryMediaId = new URL(entry.name).searchParams.get("media_id"); } catch {}
        if (entryMediaId === mediaId) push(entry.name, "performance-resource");
      }

      return candidates;
    }, targetOid).catch(() => []);
  }

  _normalizeDuration(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    if (typeof value !== "string") return null;
    const parts = value.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
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

export default WeiboParser;
