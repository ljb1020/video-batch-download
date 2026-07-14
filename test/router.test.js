import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractAndRouteUrls,
  loadPlatforms,
  routeUrl,
} from "../scripts/platforms/router.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMP_ROOT = path.join(TEST_DIR, ".tmp");

async function makePluginDirectory(t) {
  await mkdir(TEMP_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(TEMP_ROOT, "plugins-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function writePlugin(directory, filename, source) {
  const file = path.join(directory, filename);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source, "utf8");
}

async function resultOf(value) {
  return await value;
}

test("extractAndRouteUrls extracts supported URLs, trims punctuation, and removes duplicates", async () => {
  const douyin = "https://www.douyin.com/video/1234567890";
  const bilibili = "https://www.bilibili.com/video/BV1xx411c7mD";
  const text = [
    `先看 ${douyin}，`,
    `重复链接：${douyin}。`,
    `还有 ${bilibili})`,
    "不支持：https://example.com/video/1。",
  ].join("\n");

  const routed = await resultOf(extractAndRouteUrls(text));

  assert.deepEqual(
    routed.map(({ url }) => url),
    [douyin, bilibili],
  );
  assert.equal(routed[0].ParserClass.platformId, "douyin");
  assert.equal(routed[1].ParserClass.platformId, "bilibili");
});

test("routeUrl recognizes Weibo video URLs", async () => {
  const ParserClass = await resultOf(
    routeUrl("https://video.weibo.com/show?fid=1034:5317814823878730"),
  );

  assert.ok(ParserClass, "the Weibo plugin should be loaded");
  assert.equal(ParserClass.platformId, "weibo");
});

test("disabledPlatforms disables one plugin without affecting the others", async () => {
  const weiboUrl =
    "https://video.weibo.com/show?fid=1034:5317814823878730";
  const douyinUrl = "https://www.douyin.com/video/1234567890";
  const options = { disabledPlatforms: ["weibo"] };

  assert.equal(await resultOf(routeUrl(weiboUrl, options)), null);
  const DouyinParser = await resultOf(routeUrl(douyinUrl, options));
  assert.ok(DouyinParser);
  assert.equal(DouyinParser.platformId, "douyin");
});

test("loadPlatforms isolates a plugin that throws while being imported", async (t) => {
  const platformsDir = await makePluginDirectory(t);
  await writePlugin(
    platformsDir,
    "healthy.mjs",
    `
      export class HealthyParser {
        static getPlatformName() { return "Healthy"; }
        static getSlug() { return "healthy"; }
        static matchesUrl(url) { return url.startsWith("https://healthy.test/"); }
        async parse() { return {}; }
      }
    `,
  );
  await writePlugin(
    platformsDir,
    "broken.mjs",
    `throw new Error("plugin import exploded");`,
  );

  const platforms = await loadPlatforms({ platformsDir });

  assert.deepEqual(platforms.map((ParserClass) => ParserClass.getSlug()), [
    "healthy",
  ]);
  const ParserClass = await routeUrl("https://healthy.test/video/1", {
    platformsDir,
  });
  assert.equal(ParserClass?.getSlug(), "healthy");
});

test("loadPlatforms discovers a directory plugin from platforms/<id>/index.mjs", async (t) => {
  const platformsDir = await makePluginDirectory(t);
  await writePlugin(
    platformsDir,
    path.join("nested", "index.mjs"),
    `
      export default class NestedParser {
        static getPlatformName() { return "Nested"; }
        static matchesUrl(url) { return url.startsWith("https://nested.test/"); }
        async parse() { return {}; }
      }
    `,
  );

  const platforms = await loadPlatforms({ platformsDir });

  assert.equal(platforms.length, 1);
  assert.equal(platforms[0].platformId, "nested");
  assert.equal(
    await routeUrl("https://nested.test/video/1", { platformsDir }),
    platforms[0],
  );
});

test("loadPlatforms isolates a duplicate platformId", async (t) => {
  const platformsDir = await makePluginDirectory(t);
  const pluginSource = (className, displayName) => `
    export default class ${className} {
      static platformId = "shared";
      static getPlatformName() { return "${displayName}"; }
      static matchesUrl() { return false; }
      async parse() { return {}; }
    }
  `;
  await writePlugin(platformsDir, "alpha.mjs", pluginSource("AlphaParser", "Alpha"));
  await writePlugin(platformsDir, "beta.mjs", pluginSource("BetaParser", "Beta"));
  const warnings = [];

  const platforms = await loadPlatforms({
    platformsDir,
    onWarning: (message) => warnings.push(message),
  });

  assert.equal(platforms.length, 1);
  assert.equal(platforms[0].getPlatformName(), "Alpha");
  assert.equal(platforms[0].platformId, "shared");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duplicate plugin id: shared/);
});

test("routeUrl isolates a plugin whose URL matcher throws", async () => {
  class BrokenMatcherParser {
    static platformId = "broken-matcher";
    static matchesUrl() {
      throw new Error("matcher exploded");
    }
  }
  class HealthyParser {
    static platformId = "healthy";
    static matchesUrl(url) {
      return url.startsWith("https://healthy.test/");
    }
  }
  const warnings = [];

  const ParserClass = await routeUrl("https://healthy.test/video/1", {
    platforms: [BrokenMatcherParser, HealthyParser],
    onWarning: (message) => warnings.push(message),
  });

  assert.equal(ParserClass, HealthyParser);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /broken-matcher/);
});

test("loadPlatforms rejects malformed plugin contracts and keeps valid plugins", async (t) => {
  const platformsDir = await makePluginDirectory(t);
  await writePlugin(
    platformsDir,
    "valid.mjs",
    `
      export class ValidParser {
        static getPlatformName() { return "Valid"; }
        static getSlug() { return "valid"; }
        static matchesUrl(url) { return url.includes("valid.test"); }
        async parse() { return {}; }
      }
    `,
  );
  await writePlugin(
    platformsDir,
    "missing-matcher.mjs",
    `
      export class MissingMatcherParser {
        static getPlatformName() { return "Missing matcher"; }
        static getSlug() { return "missing-matcher"; }
        async parse() { return {}; }
      }
    `,
  );
  await writePlugin(
    platformsDir,
    "missing-parser.mjs",
    `
      export class MissingParser {
        static getPlatformName() { return "Missing parser"; }
        static getSlug() { return "missing-parser"; }
        static matchesUrl() { return false; }
      }
    `,
  );

  const platforms = await loadPlatforms({ platformsDir });

  assert.deepEqual(platforms.map((ParserClass) => ParserClass.getSlug()), [
    "valid",
  ]);
});

test.after(async () => {
  await rm(TEMP_ROOT, { recursive: true, force: true });
});
