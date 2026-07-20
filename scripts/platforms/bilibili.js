import { PlatformError, PlatformParser, preferPlatformError } from "./base.js";
import { itemKey, sleep, settleWithin } from "../utils/common.js";

const URL_PATTERNS = [
  /^https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[\w]+|av\d+)/i,
  /^https?:\/\/b23\.tv\//i,
];

const QUALITY_LABELS = new Map([
  [127, "8K"], [126, "杜比视界"], [125, "HDR"], [120, "4K"],
  [116, "1080P60"], [112, "1080P+"], [80, "1080P"], [74, "720P60"],
  [64, "720P"], [32, "480P"], [16, "360P"], [6, "240P"],
]);

// Only known content/access codes are permanent; rate-limit / risk-control stay retryable.
const PERMANENT_VIEW_API_CODES = new Set([
  -404, // not found
  62002, // 稿件不可见
  62004, // 稿件审核中
]);

export function classifyBilibiliViewApiError(code) {
  if (code == null || Number(code) === 0) return null;
  const numeric = Number(code);
  const permanent = PERMANENT_VIEW_API_CODES.has(numeric);
  return new PlatformError(`Bilibili API error: code ${numeric}`, {
    code: permanent ? "CONTENT_UNAVAILABLE" : "PLATFORM_API_ERROR",
    category: permanent ? "content" : "platform",
    permanent,
    retryable: !permanent,
    retryScope: permanent ? "none" : "item",
    userMessage: permanent
      ? `B站接口返回内容不可用状态 ${numeric}，已跳过。`
      : `B站接口返回异常状态 ${numeric}，稍后会重新解析。`,
  });
}

function numericFps(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const [numerator, denominator = "1"] = value.split("/").map(Number);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? numerator / denominator
    : null;
}

function qualityLabel(quality, formatInfo) {
  return formatInfo?.new_description
    ?? formatInfo?.display_desc
    ?? formatInfo?.description
    ?? QUALITY_LABELS.get(Number(quality))
    ?? (quality != null ? `QN${quality}` : null);
}

export class BilibiliParser extends PlatformParser {
  static getPlatformName() {
    return "B站";
  }

  static matchesUrl(url) {
    return URL_PATTERNS.some((pattern) => pattern.test(url));
  }

  async parse(browserManager, url, options) {
    const browser = await browserManager.start();
    const contextOptions = BilibiliParser.getBrowserContextOptions(browserManager, options);

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    let viewApiData = null;
    let playurlApiData = null;
    const observedPlayurlData = [];
    let permanentError = null;

    page.on("response", async (response) => {
      const responseUrl = response.url();

      // Intercept view API (metadata)
      if (/\/x\/web-interface\/view/.test(responseUrl) && response.ok()) {
        try {
          const json = await response.json();
          if (json.code === 0 && json.data) {
            viewApiData = json.data;
          } else if (json.code !== 0) {
            permanentError = preferPlatformError(permanentError, classifyBilibiliViewApiError(json.code));
          }
        } catch (e) { console.warn(`[bilibili] failed to parse view API response: ${e.message}`); }
      }

      // Intercept playurl API (video streams)
      if (/\/x\/player\/(wbi\/)?playurl/.test(responseUrl) && response.ok()) {
        try {
          const json = await response.json();
          if (json.code === 0 && json.data) {
            playurlApiData = json.data;
            observedPlayurlData.push(json.data);
          }
        } catch (e) { console.warn(`[bilibili] failed to parse playurl API response: ${e.message}`); }
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
        if (viewApiData && playurlApiData) break;
        await sleep(250);
      }

      const finalUrl = page.url();
      const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");

      // Check for permanent failures (preferPlatformError can upgrade over retryable API noise)
      if (/视频不存在|已被删除|审核中|仅限港澳台地区/u.test(bodyText)) {
        const matched = bodyText.match(/视频不存在|已被删除|审核中|仅限港澳台地区/u)?.[0];
        permanentError = preferPlatformError(permanentError, new PlatformError(matched, {
          code: /视频不存在|已被删除/u.test(matched)
            ? "CONTENT_DELETED"
            : "CONTENT_UNAVAILABLE",
          category: "content",
          permanent: true,
          retryable: false,
          userMessage: `B站视频${matched}，已跳过。`,
        }));
      }

      if (permanentError?.permanent) {
        throw permanentError;
      }

      // B站 view API 未登录时只返回 { judge: ... }，缺少核心字段
      // 从页面 __INITIAL_STATE__ 兜底提取元数据
      const hasFullMeta = viewApiData && viewApiData.bvid && viewApiData.title;
      if (!hasFullMeta) {
        const pageState = await page.evaluate(() => {
          const s = window.__INITIAL_STATE__;
          if (!s || !s.videoData) return null;
          const vd = s.videoData;
          return {
            bvid: vd.bvid,
            aid: vd.aid,
            cid: vd.cid,
            pages: vd.pages,
            title: vd.title,
            desc: vd.desc,
            duration: vd.duration,
            pubdate: vd.pubdate,
            stat: vd.stat,
            owner: vd.owner,
          };
        }).catch(() => null);
        if (pageState) {
          viewApiData = { ...(viewApiData ?? {}), ...pageState };
        }
      }

      if (!viewApiData) {
        if (permanentError) throw permanentError;
        throw new PlatformError("No Bilibili view API response", {
          code: "MEDIA_DISCOVERY_FAILED",
          category: "platform",
          retryable: true,
          retryScope: "item",
          userMessage: "没有捕获到B站视频详情，稍后会重新解析。",
        });
      }

      const pagePlayinfo = await this._extractPlayinfoFromPage(page);
      if (pagePlayinfo) {
        observedPlayurlData.push(pagePlayinfo);
        playurlApiData ??= pagePlayinfo;
      }

      // The player may initially request a bandwidth-adaptive, lower quality stream.
      // Always express the highest quality intent and trust the anonymous API response
      // to define what is actually accessible.
      const highestPlayurlData = await this._fetchPlayurlFallback(page, viewApiData, url);
      if (highestPlayurlData) {
        observedPlayurlData.push(highestPlayurlData);
        playurlApiData = highestPlayurlData;
      }

      if (!playurlApiData) {
        if (permanentError) throw permanentError;
        const bvid = viewApiData?.bvid ?? url.match(/(BV[\w]+)/i)?.[1] ?? null;
        const cid = this._resolveCid(viewApiData, url);
        const detail = bvid || cid ? ` (bvid=${bvid ?? "unknown"}, cid=${cid ?? "unknown"})` : "";
        throw new PlatformError(`No Bilibili playurl data after page intercept and API fallback${detail}`, {
          code: "MEDIA_DISCOVERY_FAILED",
          category: "platform",
          retryable: true,
          retryScope: "item",
          userMessage: "没有捕获到B站播放地址，稍后会重新解析。",
        });
      }

      // Extract video ID (bvid or aid, with URL-based fallback)
      const urlBvid = url.match(/(BV[\w]+)/i)?.[1] ?? null;
      const videoId = viewApiData.bvid ?? urlBvid ?? (viewApiData.aid != null ? `av${viewApiData.aid}` : null) ?? itemKey(url);

      // Parse metadata
      const author = {
        nickname: viewApiData.owner?.name ?? null,
        uid: viewApiData.owner?.mid ? String(viewApiData.owner.mid) : null,
        url: viewApiData.owner?.mid
          ? `https://space.bilibili.com/${viewApiData.owner.mid}`
          : null,
      };

      const postTime = viewApiData.pubdate
        ? new Date(viewApiData.pubdate * 1000).toISOString().replace("T", " ").slice(0, 19)
        : null;

      const statistics = {
        view_count: viewApiData.stat?.view ?? null,
        like_count: viewApiData.stat?.like ?? null,
        coin_count: viewApiData.stat?.coin ?? null,
        favorite_count: viewApiData.stat?.favorite ?? null,
        share_count: viewApiData.stat?.share ?? null,
        danmaku_count: viewApiData.stat?.danmaku ?? null,
        reply_count: viewApiData.stat?.reply ?? null,
      };

      const availableStreams = this._extractAvailableStreams(playurlApiData)
        .map((stream) => ({ ...stream, referer: "https://www.bilibili.com/" }));
      const mediaAlternatives = this._buildMediaAlternatives(availableStreams);
      const mediaStreams = mediaAlternatives[0] ?? [];

      if (mediaStreams.length === 0) {
        if (permanentError) throw permanentError;
        throw new PlatformError("No valid media streams found", {
          code: "MEDIA_DISCOVERY_FAILED",
          category: "platform",
          retryable: true,
          retryScope: "item",
          userMessage: "没有找到可用的B站视频流，稍后会重新解析。",
        });
      }

      return {
        platform: BilibiliParser.getPlatformName(),
        sourceUrl: url,
        canonicalUrl: finalUrl,
        videoId,
        title: viewApiData.title ?? "",
        author,
        description: viewApiData.desc ?? null,
        postTime,
        duration: viewApiData.duration ?? null,
        statistics,
        referer: "https://www.bilibili.com/",
        mediaStreams,
        mediaAlternatives,
        availableStreams,
        qualityAudit: this._buildQualityAudit(observedPlayurlData, availableStreams, mediaStreams),
      };
    } finally {
      await settleWithin(context.close(), 5_000);
    }
  }

  _resolveCid(viewApiData, url) {
    const pages = Array.isArray(viewApiData?.pages) ? viewApiData.pages : [];
    let pageNo = 1;
    try {
      const parsedUrl = new URL(url);
      pageNo = Number.parseInt(parsedUrl.searchParams.get("p") ?? "1", 10);
      if (!Number.isInteger(pageNo) || pageNo < 1) pageNo = 1;
    } catch {}

    const requestedPage = pages.find((p) => Number(p?.page) === pageNo) ?? pages[pageNo - 1];
    return requestedPage?.cid ?? viewApiData?.cid ?? pages[0]?.cid ?? null;
  }

  _normalizePlayurlData(json) {
    if (!json) return null;
    const data = json.data ?? json.result ?? null;
    if (!data) return null;
    return this._extractMediaStreams(data).length > 0 ? data : null;
  }

  async _extractPlayinfoFromPage(page) {
    const json = await page.evaluate(() => window.__playinfo__ ?? null).catch(() => null);
    return this._normalizePlayurlData(json);
  }

  async _fetchJsonFromPage(page, requestUrl) {
    return await page.evaluate(async (apiUrl) => {
      const response = await fetch(apiUrl, {
        credentials: "include",
        headers: { Accept: "application/json, text/plain, */*" },
      });
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return { code: -1, message: `Invalid JSON response: ${text.slice(0, 200)}`, httpStatus: response.status };
      }
    }, requestUrl).catch(() => null);
  }

  async _fetchPlayurlFallback(page, viewApiData, url) {
    const bvid = viewApiData?.bvid ?? url.match(/(BV[\w]+)/i)?.[1] ?? null;
    const aid = viewApiData?.aid ?? null;
    const cid = this._resolveCid(viewApiData, url);
    if (!cid || (!bvid && aid == null)) return null;

    const variants = [
      { qn: "127", fnval: "4048" },
      { qn: "127", fnval: "16" },
      { qn: "127", fnval: "0" },
    ];

    for (const variant of variants) {
      const params = new URLSearchParams({
        cid: String(cid),
        qn: variant.qn,
        fnval: variant.fnval,
        fnver: "0",
        fourk: "1",
        otype: "json",
        platform: "pc",
      });
      if (bvid) params.set("bvid", bvid);
      else params.set("avid", String(aid));

      const json = await this._fetchJsonFromPage(
        page,
        `https://api.bilibili.com/x/player/playurl?${params.toString()}`
      );
      const data = this._normalizePlayurlData(json);
      if (data) return data;
    }

    return null;
  }

  _extractMediaStreams(playurlData) {
    return this._buildMediaAlternatives(this._extractAvailableStreams(playurlData))[0] ?? [];
  }

  _extractAvailableStreams(playurlData) {
    const streams = [];
    const formatByQuality = new Map(
      (playurlData?.support_formats ?? []).map((format) => [Number(format.quality), format]),
    );
    const dash = playurlData?.dash;

    for (const video of dash?.video ?? []) {
      const url = video.baseUrl ?? video.base_url;
      if (!url) continue;
      streams.push({
        url,
        type: "video",
        format: "m4s",
        width: video.width ?? null,
        height: video.height ?? null,
        fps: numericFps(video.frameRate ?? video.frame_rate),
        bitrate: video.bandwidth ?? null,
        codec: video.codecs ?? (video.codecid != null ? String(video.codecid) : null),
        quality: video.id ?? null,
        label: qualityLabel(video.id, formatByQuality.get(Number(video.id))),
        source: "dash.video",
        totalBytes: video.size ?? null,
      });
    }

    const audioGroups = [
      [dash?.audio ?? [], "dash.audio"],
      [Array.isArray(dash?.dolby?.audio) ? dash.dolby.audio : dash?.dolby?.audio ? [dash.dolby.audio] : [], "dash.dolby.audio"],
      [Array.isArray(dash?.flac?.audio) ? dash.flac.audio : dash?.flac?.audio ? [dash.flac.audio] : [], "dash.flac.audio"],
    ];
    for (const [audios, source] of audioGroups) {
      for (const audio of audios) {
        const url = audio.baseUrl ?? audio.base_url;
        if (!url) continue;
        streams.push({
          url,
          type: "audio",
          format: "m4s",
          width: null,
          height: null,
          fps: null,
          bitrate: audio.bandwidth ?? null,
          codec: audio.codecs ?? (audio.codecid != null ? String(audio.codecid) : null),
          quality: audio.id ?? null,
          label: source === "dash.flac.audio" ? "Hi-Res无损" : source === "dash.dolby.audio" ? "杜比音频" : null,
          source,
          totalBytes: audio.size ?? null,
        });
      }
    }

    for (const durl of playurlData?.durl ?? []) {
      if (!durl?.url) continue;
      streams.push({
        url: durl.url,
        type: "video+audio",
        format: "mp4",
        width: playurlData.width ?? null,
        height: playurlData.height ?? null,
        fps: numericFps(playurlData.frame_rate),
        bitrate: playurlData.bandwidth ?? null,
        codec: null,
        quality: playurlData.quality ?? null,
        label: qualityLabel(playurlData.quality, formatByQuality.get(Number(playurlData.quality))),
        source: "durl",
        totalBytes: durl.size ?? null,
      });
    }
    return streams;
  }

  _videoRank(stream) {
    return [
      (Number(stream.width) || 0) * (Number(stream.height) || 0),
      Number(stream.quality) || 0,
      Number(stream.fps) || 0,
      Number(stream.bitrate) || 0,
      Number(stream.totalBytes) || 0,
    ];
  }

  _compareVideoStreams(a, b) {
    const rankA = this._videoRank(a);
    const rankB = this._videoRank(b);
    for (let index = 0; index < rankA.length; index += 1) {
      if (rankA[index] !== rankB[index]) return rankB[index] - rankA[index];
    }
    return 0;
  }

  _buildMediaAlternatives(availableStreams) {
    const videos = availableStreams.filter((stream) => stream.type === "video")
      .sort((a, b) => this._compareVideoStreams(a, b));
    const bestAudio = availableStreams.filter((stream) => stream.type === "audio")
      .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
    if (videos.length > 0 && bestAudio) return videos.map((video) => [video, bestAudio]);

    return availableStreams.filter((stream) => stream.type === "video+audio")
      .sort((a, b) => this._compareVideoStreams(a, b))
      .map((stream) => [stream]);
  }

  _buildQualityAudit(playurlDataList, availableStreams, selectedStreams) {
    const advertised = new Map();
    for (const data of playurlDataList) {
      const formats = new Map((data?.support_formats ?? []).map((format) => [Number(format.quality), format]));
      const qualities = new Set([...(data?.accept_quality ?? []), ...formats.keys()]);
      for (const quality of qualities) {
        advertised.set(Number(quality), qualityLabel(quality, formats.get(Number(quality))));
      }
    }

    const accessible = new Map();
    for (const stream of availableStreams.filter((candidate) => candidate.type !== "audio")) {
      accessible.set(Number(stream.quality) || 0, stream.label ?? qualityLabel(stream.quality));
    }
    const advertisedQualities = [...advertised].sort((a, b) => b[0] - a[0]).map(([, label]) => label);
    const accessibleQualities = [...accessible].sort((a, b) => b[0] - a[0]).map(([, label]) => label);
    const selectedVideo = selectedStreams.find((stream) => stream.type !== "audio") ?? null;
    const highestAdvertised = Math.max(0, ...advertised.keys());
    const highestAccessible = Math.max(0, ...accessible.keys());

    return {
      advertisedQualities,
      accessibleQualities,
      selectedQuality: selectedVideo?.label ?? qualityLabel(selectedVideo?.quality),
      selectionReason: selectedVideo
        ? "Selected the highest-quality stream actually returned to the anonymous session; audio uses the highest available bitrate."
        : "No selectable stream was returned.",
      ...(highestAdvertised > highestAccessible ? { limitedBy: "anonymous_platform_access" } : {}),
    };
  }
}
