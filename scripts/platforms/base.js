import { ProcessingError } from "../core/errors.js";

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

/**
 * A platform-scoped failure with stable retry semantics for the core pipeline.
 */
export class PlatformError extends ProcessingError {
  constructor(message, {
    code = "PLATFORM_ERROR",
    category = "platform",
    stage = "parse",
    permanent = false,
    retryable,
    retryScope = "item",
    userMessage = null,
    suggestion = null,
    details = null,
    cause,
  } = {}) {
    super(message, {
      code,
      category,
      stage,
      permanent,
      retryable,
      retryScope,
      userMessage,
      suggestion,
      details,
      cause,
    });
    this.name = "PlatformError";
  }
}

/**
 * Merge platform errors without demoting a permanent failure to a retryable one.
 * When both are permanent, prefer unsupported/content over generic API errors.
 */
export function preferPlatformError(current, next) {
  if (!next) return current;
  if (!current) return next;
  if (current.permanent && !next.permanent) return current;
  if (!current.permanent && next.permanent) return next;

  if (current.permanent && next.permanent) {
    const rank = (error) => {
      if (error.code === "UNSUPPORTED_CONTENT_TYPE") return 3;
      if (error.category === "content") return 2;
      return 1;
    };
    const currentRank = rank(current);
    const nextRank = rank(next);
    if (nextRank > currentRank) return next;
    if (nextRank < currentRank) return current;
  }

  return next;
}

/**
 * Validate the normalized boundary between a platform plugin and the core.
 * Platform-specific response objects must never pass this boundary directly.
 */
export function validateParsedVideo(parsed, pluginId = "unknown") {
  const fail = (message) => {
    throw new PlatformError(`Invalid result from platform plugin ${pluginId}: ${message}`, {
      code: "INVALID_PLUGIN_RESULT",
      permanent: true,
    });
  };

  if (!parsed || typeof parsed !== "object") fail("expected an object");
  for (const field of ["platform", "sourceUrl", "canonicalUrl", "videoId"]) {
    if (typeof parsed[field] !== "string" || !parsed[field].trim()) {
      fail(`${field} must be a non-empty string`);
    }
  }
  if (typeof parsed.title !== "string") fail("title must be a string");
  if (!parsed.author || typeof parsed.author !== "object" || Array.isArray(parsed.author)) {
    fail("author must be an object");
  }
  if (parsed.author.nickname != null && typeof parsed.author.nickname !== "string") {
    fail("author.nickname must be a string or null");
  }
  if (!parsed.statistics || typeof parsed.statistics !== "object" || Array.isArray(parsed.statistics)) {
    fail("statistics must be an object");
  }
  if (parsed.description != null && typeof parsed.description !== "string") {
    fail("description must be a string or null");
  }
  if (parsed.postTime != null && typeof parsed.postTime !== "string") {
    fail("postTime must be a string or null");
  }
  if (parsed.duration != null && (!Number.isFinite(parsed.duration) || parsed.duration < 0)) {
    fail("duration must be a non-negative number or null");
  }
  if (!Array.isArray(parsed.mediaStreams) || parsed.mediaStreams.length === 0) {
    fail("mediaStreams must be a non-empty array");
  }

  const validateStream = (stream, location) => {
    if (!stream || typeof stream !== "object") fail(`${location} must be an object`);
    if (!/^https?:\/\//i.test(stream.url ?? "")) {
      fail(`${location}.url must be an absolute HTTP(S) URL`);
    }
    if (!["video+audio", "video", "audio"].includes(stream.type)) {
      fail(`${location}.type is unsupported`);
    }
    if (!["mp4", "m4s"].includes(stream.format)) {
      fail(`${location}.format is unsupported`);
    }
  };
  const validateStreamSet = (streams, location) => {
    if (!Array.isArray(streams) || streams.length === 0) fail(`${location} must be a non-empty array`);
    const streamTypes = new Set();
    for (const [index, stream] of streams.entries()) {
      validateStream(stream, `${location}[${index}]`);
      streamTypes.add(stream.type);
    }
    if (!streamTypes.has("video+audio") && !(streamTypes.has("video") && streamTypes.has("audio"))) {
      fail(`${location} must contain a muxed stream or a video/audio pair`);
    }
  };

  validateStreamSet(parsed.mediaStreams, "mediaStreams");

  if (parsed.availableStreams != null) {
    if (!Array.isArray(parsed.availableStreams)) fail("availableStreams must be an array");
    for (const [index, stream] of parsed.availableStreams.entries()) {
      validateStream(stream, `availableStreams[${index}]`);
    }
  }

  if (parsed.mediaAlternatives != null) {
    if (!Array.isArray(parsed.mediaAlternatives)) fail("mediaAlternatives must be an array");
    for (const [index, streams] of parsed.mediaAlternatives.entries()) {
      validateStreamSet(streams, `mediaAlternatives[${index}]`);
    }
  }

  if (parsed.qualityAudit != null && (
    typeof parsed.qualityAudit !== "object" || Array.isArray(parsed.qualityAudit)
  )) {
    fail("qualityAudit must be an object");
  }

  return parsed;
}
