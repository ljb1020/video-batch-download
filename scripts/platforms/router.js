import { DouyinParser } from "./douyin.js";
import { BilibiliParser } from "./bilibili.js";
// import { KuaishouParser } from "./kuaishou.js"; // 暂时禁用：快手反爬严格，未登录无法获取元数据
import { XiaohongshuParser } from "./xiaohongshu.js";

const PARSERS = [DouyinParser, BilibiliParser, XiaohongshuParser];

/**
 * Route a URL to the appropriate platform parser.
 * @param {string} url
 * @returns {typeof import('./base.js').PlatformParser | null}
 */
export function routeUrl(url) {
  for (const Parser of PARSERS) {
    if (Parser.matchesUrl(url)) {
      return Parser;
    }
  }
  return null;
}

/**
 * Extract all URLs from text and route them to platform parsers.
 * @param {string} text
 * @returns {Array<{url: string, ParserClass: typeof import('./base.js').PlatformParser}>}
 */
export function extractAndRouteUrls(text) {
  const GENERIC_URL_RE = /https?:\/\/[^\s<>"']+/gi;
  const matches = [...text.matchAll(GENERIC_URL_RE)];
  const urls = matches.map((m) =>
    m[0].replace(/[，。！？；：、,.!?;:)}\]>]+$/u, "")
  );

  const result = [];
  const seen = new Set();

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);

    const ParserClass = routeUrl(url);
    if (ParserClass) {
      result.push({ url, ParserClass });
    }
  }

  return result;
}
