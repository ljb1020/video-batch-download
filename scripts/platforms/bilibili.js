import { PlatformParser } from "./base.js";
import { itemKey, sleep, settleWithin } from "../utils/common.js";

const URL_PATTERNS = [
  /^https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[\w]+|av\d+)/i,
  /^https?:\/\/b23\.tv\//i,
];

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
    let permanentReason = null;

    page.on("response", async (response) => {
      const responseUrl = response.url();

      // Intercept view API (metadata)
      if (/\/x\/web-interface\/view/.test(responseUrl) && response.ok()) {
        try {
          const json = await response.json();
          if (json.code === 0 && json.data) {
            viewApiData = json.data;
          } else if (json.code !== 0) {
            permanentReason = `Bilibili API error: code ${json.code}`;
          }
        } catch (e) { console.warn(`[bilibili] failed to parse view API response: ${e.message}`); }
      }

      // Intercept playurl API (video streams)
      if (/\/x\/player\/(wbi\/)?playurl/.test(responseUrl) && response.ok()) {
        try {
          const json = await response.json();
          if (json.code === 0 && json.data) {
            playurlApiData = json.data;
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

      // Check for permanent failures
      if (/视频不存在|已被删除|审核中|仅限港澳台地区/u.test(bodyText)) {
        permanentReason = bodyText.match(/视频不存在|已被删除|审核中|仅限港澳台地区/u)?.[0];
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
        const reason = permanentReason ?? "No Bilibili view API response";
        const error = new Error(reason);
        error.permanent = Boolean(permanentReason);
        throw error;
      }

      if (!playurlApiData) {
        playurlApiData = await this._extractPlayinfoFromPage(page);
      }

      if (!playurlApiData) {
        playurlApiData = await this._fetchPlayurlFallback(page, viewApiData, url);
      }

      if (!playurlApiData) {
        const bvid = viewApiData?.bvid ?? url.match(/(BV[\w]+)/i)?.[1] ?? null;
        const cid = this._resolveCid(viewApiData, url);
        const detail = bvid || cid ? ` (bvid=${bvid ?? "unknown"}, cid=${cid ?? "unknown"})` : "";
        const err = new Error(`No Bilibili playurl data after page intercept and API fallback${detail}`);
        err.permanent = Boolean(permanentReason);
        throw err;
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

      // Parse media streams
      const mediaStreams = this._extractMediaStreams(playurlApiData);

      if (mediaStreams.length === 0) {
        throw new Error("No valid media streams found");
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
        mediaStreams: mediaStreams.map((s) => ({ ...s, referer: "https://www.bilibili.com/" })),
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
      { qn: "80", fnval: "4048" },
      { qn: "80", fnval: "16" },
      { qn: "80", fnval: "0" },
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
    const streams = [];

    // Try DASH format first (most common, higher quality)
    if (playurlData.dash) {
      const dash = playurlData.dash;

      // Get video stream (highest quality by default)
      if (dash.video && dash.video.length > 0) {
        // Sort by quality descending
        const sortedVideo = [...dash.video].sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
        const videoStream = sortedVideo[0];
        const videoUrl = videoStream.baseUrl ?? videoStream.base_url;
        if (videoUrl) {
          streams.push({
            url: videoUrl,
            type: "video",
            format: "m4s",
            quality: videoStream.height ?? null,
          });
        }
      }

      // Get audio stream
      if (dash.audio && dash.audio.length > 0) {
        const audioStream = dash.audio[0];
        const audioUrl = audioStream.baseUrl ?? audioStream.base_url;
        if (audioUrl) {
          streams.push({
            url: audioUrl,
            type: "audio",
            format: "m4s",
          });
        }
      }

      if (streams.length === 2) {
        return streams;
      }
    }

    // Fallback to legacy durl format (single merged MP4, lower quality)
    if (playurlData.durl && playurlData.durl.length > 0) {
      const durl = playurlData.durl[0];
      return [
        {
          url: durl.url,
          type: "video+audio",
          format: "mp4",
        },
      ];
    }

    return [];
  }
}
