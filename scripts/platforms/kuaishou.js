import { PlatformParser } from "./base.js";
import { sanitizeName, itemKey, sleep, settleWithin } from "../utils/common.js";

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
    const candidates = [];
    let permanentReason = null;

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
      if (/\.(mp4|m3u8)/i.test(responseUrl) || contentType.startsWith("video/")) {
        if (/kwaicdn\.com|kuaishou\.com|djvod\.ndcimgs\.com|yximgs\.com|gifshow\.com/i.test(responseUrl)) {
          const total = Number(
            headers["content-range"]?.match(/\/(\d+)$/)?.[1] ?? headers["content-length"] ?? 0
          );
          addCandidate({ url: responseUrl, totalBytes: total, source: "media-response" });
        }
      }
    });

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options.pageTimeoutMs,
      });

      // 等待页面加载和媒体响应
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

      // 从 URL 提取关键参数
      const videoId = this._extractVideoId(finalUrl) ?? itemKey(url);
      const userId = finalUrl.match(/userId=([^&]+)/)?.[1] ?? null;

      // 检查永久性失败
      const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
      if (/该视频已删除|视频不存在|暂无权限|该作品已删除|无法查看/u.test(bodyText)) {
        permanentReason = bodyText.match(/该视频已删除|视频不存在|暂无权限|该作品已删除|无法查看/u)?.[0];
      }

      if (candidates.length === 0) {
        const challenge = /验证|滑块|captcha/i.test(bodyText);
        const reason = permanentReason ?? (challenge
          ? "Kuaishou verification challenge"
          : `No media response (videoId: ${videoId})`);
        const error = new Error(reason);
        error.permanent = Boolean(permanentReason);
        throw error;
      }

      // Sort candidates by quality
      candidates.sort((a, b) => this._candidateScore(b) - this._candidateScore(a));

      // 快手未登录时显示推荐列表，当前视频元数据有限
      // 从页面标题提取（去掉 "-快手" 后缀）
      const title = pageTitle.replace(/[-_]快手$/, "").trim() || null;

      return {
        platform: KuaishouParser.getPlatformName(),
        sourceUrl: url,
        canonicalUrl: finalUrl,
        videoId,
        title,
        author: {
          nickname: null, // 快手未登录时无法获取作者名
          uid: userId,
          url: userId ? `https://www.kuaishou.com/profile/${userId}` : null,
        },
        description: title, // 描述通常和标题一致
        postTime: null,
        duration: null,
        statistics: {},
        referer: "https://www.kuaishou.com/",
        mediaStreams: [
          {
            url: candidates[0].url,
            type: "video+audio",
            format: "mp4",
            referer: "https://www.kuaishou.com/",
          },
        ],
      };
    } finally {
      await settleWithin(context.close(), 5_000);
    }
  }

  _extractVideoId(url) {
    return url.match(/\/short-video\/([\w-]+)/)?.[1] ?? url.match(/\/f\/([\w-]+)/)?.[1] ?? null;
  }

  _candidateScore(candidate) {
    let qualityBoost = 0;
    try {
      const u = new URL(candidate.url);
      const tag = u.searchParams.get("tag") ?? "";
      if (tag.includes("hd")) qualityBoost += 1000;
      if (tag.includes("hd1")) qualityBoost += 500;
      if (tag.includes("hd2")) qualityBoost += 800;
    } catch {}
    return (candidate.totalBytes ?? 0) * 10 + qualityBoost;
  }
}
