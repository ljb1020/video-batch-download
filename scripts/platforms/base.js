/**
 * Base class for platform-specific video parsers.
 *
 * Each platform (Douyin, Bilibili, etc.) implements this interface to provide
 * a unified structure for the download pipeline.
 */
export class PlatformParser {
  /**
   * Get the platform display name (e.g., "抖音", "B站")
   * @returns {string}
   */
  static getPlatformName() {
    throw new Error("getPlatformName() not implemented");
  }

  /**
   * Get an ASCII-safe slug for filenames (e.g., "douyin", "bilibili").
   * Defaults to lowercased platform name.
   * @returns {string}
   */
  static getSlug() {
    const slug = this.getPlatformName().toLowerCase().replace(/[^a-z0-9]/g, "");
    return slug || this.getPlatformName();
  }

  /**
   * Check if this parser can handle the given URL
   * @param {string} url
   * @returns {boolean}
   */
  static matchesUrl(url) {
    throw new Error("matchesUrl() not implemented");
  }

  /**
   * Get default browser context options for this platform.
   * @param {import('../utils/browser-manager.js').BrowserManager} browserManager
   * @param {object} options - Parser options
   * @returns {object}
   */
  static getBrowserContextOptions(browserManager, options) {
    return {
      locale: "zh-CN",
      userAgent: browserManager.getUserAgent(),
      viewport: { width: 1280, height: 720 },
      extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9" },
      ...(options.storageState ? { storageState: options.storageState } : {}),
    };
  }

  /**
   * Parse video metadata and media URLs from the given URL.
   *
   * @param {import('../utils/browser-manager.js').BrowserManager} browserManager
   * @param {string} url - Source URL
   * @param {object} options - Parser options (timeouts, etc.)
   * @returns {Promise<ParsedVideo>}
   *
   * @typedef {object} ParsedVideo
   * @property {string} platform - Platform display name
   * @property {string} sourceUrl - Original input URL
   * @property {string} canonicalUrl - Canonical video page URL
   * @property {string} videoId - Platform-specific video ID
   * @property {string} title - Video title
   * @property {object} author - Author info
   * @property {string} author.nickname - Display name
   * @property {string|null} author.uid - Platform user ID
   * @property {string|null} author.url - Author profile URL
   * @property {string|null} description - Video description
   * @property {string|null} postTime - Post time (YYYY-MM-DD HH:MM:SS)
   * @property {number|null} duration - Duration in seconds
   * @property {object} statistics - View/like/comment counts
   * @property {MediaStream[]} mediaStreams - Media URLs
   * @property {string} [referer] - Platform referer URL for downloads
   *
   * @typedef {object} MediaStream
   * @property {string} url - Download URL
   * @property {"video+audio"|"video"|"audio"} type - Stream type
   * @property {"mp4"|"m4s"} format - Container format
   * @property {number} [quality] - Video height (e.g., 1080) if applicable
   * @property {string} [referer] - Override referer for this stream
   * @property {object} [headers] - Extra HTTP headers for this stream
   */
  async parse(browserManager, url, options) {
    throw new Error("parse() not implemented");
  }
}
