import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const DEFAULT_PLATFORMS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORE_FILES = new Set(["base.js", "router.js"]);

function normalizeId(value) {
  return String(value ?? "").trim().toLowerCase();
}

function validatePlugin(ParserClass, fallbackId) {
  if (typeof ParserClass !== "function") throw new Error("plugin must export a parser class");
  if (typeof ParserClass.getPlatformName !== "function") throw new Error("missing static getPlatformName()");
  if (typeof ParserClass.matchesUrl !== "function") throw new Error("missing static matchesUrl()");
  if (typeof ParserClass.prototype?.parse !== "function") throw new Error("missing parse()");

  const id = normalizeId(ParserClass.platformId ?? ParserClass.id ?? fallbackId);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new Error(`invalid plugin id: ${id || "empty"}`);
  }
  const name = ParserClass.getPlatformName();
  if (typeof name !== "string" || !name.trim()) throw new Error("getPlatformName() returned an empty name");

  Object.defineProperty(ParserClass, "platformId", {
    value: id,
    configurable: true,
  });
  return ParserClass;
}

function selectParserExport(module) {
  if (typeof module.default === "function") return module.default;
  return Object.values(module).find((value) =>
    typeof value === "function"
    && typeof value.matchesUrl === "function"
    && typeof value.prototype?.parse === "function"
  ) ?? null;
}

async function discoverPluginEntries(platformsDir) {
  const entries = await fsp.readdir(platformsDir, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (entry.isFile() && /\.(?:js|mjs)$/i.test(entry.name) && !CORE_FILES.has(entry.name)) {
      candidates.push({ id: path.basename(entry.name, path.extname(entry.name)), file: path.join(platformsDir, entry.name) });
    } else if (entry.isDirectory()) {
      for (const indexName of ["index.js", "index.mjs"]) {
        const file = path.join(platformsDir, entry.name, indexName);
        try {
          const stat = await fsp.stat(file);
          if (stat.isFile()) candidates.push({ id: entry.name, file });
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
  }

  return candidates.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Discover platform plugins. A missing or broken plugin is isolated and does
 * not prevent other platforms from loading.
 */
export async function loadPlatforms(options = {}) {
  const platformsDir = path.resolve(options.platformsDir ?? DEFAULT_PLATFORMS_DIR);
  const disabled = new Set((options.disabledPlatforms ?? []).map(normalizeId));
  const warn = options.onWarning ?? ((message) => console.warn(`[platforms] ${message}`));
  const loaded = [];
  const ids = new Set();

  let candidates;
  try {
    candidates = await discoverPluginEntries(platformsDir);
  } catch (error) {
    warn(`failed to scan ${platformsDir}: ${error.message}`);
    return loaded;
  }

  for (const candidate of candidates) {
    const fallbackId = normalizeId(candidate.id);
    if (disabled.has(fallbackId)) continue;
    try {
      const stat = await fsp.stat(candidate.file);
      const moduleUrl = `${pathToFileURL(candidate.file).href}?v=${stat.mtimeMs}`;
      const module = await import(moduleUrl);
      const ParserClass = validatePlugin(selectParserExport(module), fallbackId);
      if (disabled.has(ParserClass.platformId)) continue;
      if (ids.has(ParserClass.platformId)) throw new Error(`duplicate plugin id: ${ParserClass.platformId}`);
      ids.add(ParserClass.platformId);
      loaded.push(ParserClass);
    } catch (error) {
      warn(`skipped ${candidate.id}: ${error.message}`);
    }
  }

  return loaded;
}

export function getPlatformId(ParserClass) {
  return normalizeId(ParserClass?.platformId ?? ParserClass?.id ?? ParserClass?.getSlug?.());
}

/** Route a URL to the first matching loaded platform plugin. */
export async function routeUrl(url, options = {}) {
  const platforms = options.platforms ?? await loadPlatforms(options);
  for (const ParserClass of platforms) {
    try {
      if (ParserClass.matchesUrl(url)) return ParserClass;
    } catch (error) {
      options.onWarning?.(`matcher failed for ${getPlatformId(ParserClass)}: ${error.message}`);
    }
  }
  return null;
}

/** Extract, de-duplicate and route supported URLs from arbitrary share text. */
export async function extractAndRouteUrls(text, options = {}) {
  const genericUrlRe = /https?:\/\/[^\s<>"']+/gi;
  const urls = [...text.matchAll(genericUrlRe)].map((match) =>
    match[0].replace(/[，。！？；：、,.!?;:)}\]>]+$/u, "")
  );
  const result = [];
  const seen = new Set();
  const platforms = options.platforms ?? await loadPlatforms(options);

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const ParserClass = await routeUrl(url, { ...options, platforms });
    if (ParserClass) result.push({ url, ParserClass });
  }
  return result;
}
