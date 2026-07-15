import assert from "node:assert/strict";
import test from "node:test";

import { WeiboParser } from "../scripts/platforms/weibo.js";

function componentResponse(oid, urls) {
  const data = new URLSearchParams({
    data: JSON.stringify({ Component_Play_Playinfo: { oid } }),
  }).toString();

  return {
    url: () => "https://weibo.com/tv/api/component",
    status: () => 200,
    request: () => ({
      method: () => "POST",
      postData: () => data,
    }),
    json: async () => ({
      code: 100000,
      data: {
        Component_Play_Playinfo: {
          oid,
          text: "微博画质测试",
          urls,
        },
      },
    }),
  };
}

function fakeBrowserManager(response) {
  let contextOptions;
  let responseHandler;

  const page = {
    on(event, handler) {
      if (event === "response") responseHandler = handler;
    },
    async goto() {
      await responseHandler(response);
    },
    url: () => "https://weibo.com/tv/show/1034:5317814823878730",
    locator: () => ({ innerText: async () => "" }),
    title: async () => "微博视频",
    evaluate: async () => [],
  };
  const context = {
    newPage: async () => page,
    close: async () => {},
  };
  const browser = {
    newContext: async (options) => {
      contextOptions = options;
      return context;
    },
  };

  return {
    start: async () => browser,
    getUserAgent: () => "weibo-test-agent",
    getContextOptions: () => contextOptions,
  };
}

test("Weibo anonymous component candidates select the highest resolution even when unordered", async () => {
  const oid = "1034:5317814823878730";
  const urls = {
    "720P": "https://f.video.weibocdn.com/a/720.mp4?template=1280x720&media_id=5317814823878730",
    "1080P": "https://f.video.weibocdn.com/a/1080.mp4?template=1920x1080&media_id=5317814823878730",
    "480P": "https://f.video.weibocdn.com/a/480.mp4?template=854x480&media_id=5317814823878730",
  };
  const browserManager = fakeBrowserManager(componentResponse(oid, urls));
  const parser = new WeiboParser();

  const parsed = await parser.parse(
    browserManager,
    `https://video.weibo.com/show?fid=${oid}`,
    { pageTimeoutMs: 1_000, mediaWaitMs: 1 },
  );

  assert.equal(browserManager.getContextOptions().storageState, undefined);
  assert.equal(parsed.mediaStreams[0].url, urls["1080P"]);
  assert.equal(parsed.mediaStreams[0].width, 1920);
  assert.equal(parsed.mediaStreams[0].height, 1080);
  assert.deepEqual(
    parsed.availableStreams.map((stream) => stream.label),
    ["1080P", "720P", "480P"],
  );
  assert.deepEqual(parsed.qualityAudit.advertisedQualities, ["720P", "1080P", "480P"]);
  assert.equal(parsed.qualityAudit.selectedQuality, "1080P");
});

test("Weibo candidate scoring prioritizes resolution over label, source, and response size", () => {
  const parser = new WeiboParser();
  const candidates = [
    { width: 1280, height: 720, quality: 2160, source: "component-api", totalBytes: 1_000_000_000 },
    { width: 1920, height: 1080, quality: 1080, source: "media-response", totalBytes: 1 },
    { width: 854, height: 480, quality: 480, source: "component-api", totalBytes: 10_000_000_000 },
  ];

  candidates.sort((a, b) => parser._candidateScore(b) - parser._candidateScore(a));

  assert.deepEqual(candidates.map(({ width, height }) => `${width}x${height}`), [
    "1920x1080",
    "1280x720",
    "854x480",
  ]);
});

test("Weibo extracts dimensions from template and quality from labels", () => {
  const parser = new WeiboParser();

  assert.deepEqual(
    parser._extractDimensions(
      "https://f.video.weibocdn.com/video.mp4?template=1920x1080",
      "高清 1080P",
    ),
    { width: 1920, height: 1080, quality: 1080 },
  );
  assert.deepEqual(
    parser._extractDimensions("https://f.video.weibocdn.com/video.mp4", "流畅 480p"),
    { width: 0, height: 0, quality: 480 },
  );
  assert.deepEqual(
    parser._extractDimensions("https://f.video.weibocdn.com/video.mp4?template=720x1280"),
    { width: 720, height: 1280, quality: 720 },
  );
});

test("Weibo extracts the target oid from fid and canonical URLs", () => {
  const parser = new WeiboParser();
  const oid = "1034:5317814823878730";

  assert.equal(parser._extractOid(`https://video.weibo.com/show?fid=${oid}`), oid);
  assert.equal(parser._extractOid(`https://weibo.com/tv/show/${oid}`), oid);
  assert.equal(parser._extractOid("https://video.weibo.com/show?fid=invalid"), null);
});

test("Weibo matches component requests and media responses to the exact target oid", () => {
  const parser = new WeiboParser();
  const oid = "1034:5317814823878730";
  const postData = new URLSearchParams({
    data: JSON.stringify({ Component_Play_Playinfo: { oid } }),
  }).toString();

  assert.equal(parser._extractRequestedOid(postData), oid);
  assert.equal(parser._extractRequestedOid("data=%7Bbroken"), null);
  assert.equal(
    parser._mediaUrlMatchesOid(
      "https://f.video.weibocdn.com/video.mp4?media_id=5317814823878730",
      oid,
    ),
    true,
  );
  assert.equal(
    parser._mediaUrlMatchesOid(
      "https://f.video.weibocdn.com/video.mp4?media_id=53178148238787301",
      oid,
    ),
    false,
  );
  assert.equal(parser._mediaUrlMatchesOid("not-a-url", oid), false);
});
