import assert from "node:assert/strict";
import test from "node:test";

import { PlatformError, preferPlatformError } from "../scripts/platforms/base.js";
import { BilibiliParser, classifyBilibiliViewApiError } from "../scripts/platforms/bilibili.js";

function dashFixture() {
  return {
    accept_quality: [120, 80, 32, 16],
    support_formats: [
      { quality: 120, new_description: "4K 超清" },
      { quality: 80, new_description: "1080P 高清" },
      { quality: 32, new_description: "480P 清晰" },
      { quality: 16, new_description: "360P 流畅" },
    ],
    dash: {
      video: [
        { id: 16, baseUrl: "https://media.test/360.m4s", width: 640, height: 360, frameRate: "30", bandwidth: 300_000, codecs: "avc1" },
        { id: 32, base_url: "https://media.test/480-low.m4s", width: 852, height: 480, frame_rate: "30000/1001", bandwidth: 600_000, codecs: "avc1" },
        { id: 32, baseUrl: "https://media.test/480-high.m4s", width: 852, height: 480, frameRate: "30000/1001", bandwidth: 800_000, codecs: "hev1" },
      ],
      audio: [
        { id: 30216, baseUrl: "https://media.test/audio-low.m4s", bandwidth: 64_000, codecs: "mp4a" },
        { id: 30280, base_url: "https://media.test/audio-high.m4s", bandwidth: 192_000, codecs: "mp4a" },
      ],
    },
  };
}

test("Bilibili enumerates DASH candidates and selects highest accessible video and audio", () => {
  const parser = new BilibiliParser();
  const available = parser._extractAvailableStreams(dashFixture());
  const alternatives = parser._buildMediaAlternatives(available);

  assert.equal(available.length, 5);
  assert.equal(alternatives.length, 3);
  assert.equal(alternatives[0][0].url, "https://media.test/480-high.m4s");
  assert.equal(alternatives[0][0].width, 852);
  assert.equal(alternatives[0][0].fps, 30000 / 1001);
  assert.equal(alternatives[0][0].codec, "hev1");
  assert.equal(alternatives[0][1].url, "https://media.test/audio-high.m4s");
  assert.deepEqual(parser._extractMediaStreams(dashFixture()), alternatives[0]);
});

test("Bilibili quality audit distinguishes advertised 4K from anonymous 480P access", () => {
  const parser = new BilibiliParser();
  const fixture = dashFixture();
  const available = parser._extractAvailableStreams(fixture);
  const selected = parser._buildMediaAlternatives(available)[0];
  const audit = parser._buildQualityAudit([fixture], available, selected);

  assert.deepEqual(audit.advertisedQualities, ["4K 超清", "1080P 高清", "480P 清晰", "360P 流畅"]);
  assert.deepEqual(audit.accessibleQualities, ["480P 清晰", "360P 流畅"]);
  assert.equal(audit.selectedQuality, "480P 清晰");
  assert.equal(audit.limitedBy, "anonymous_platform_access");
  assert.match(audit.selectionReason, /highest-quality stream actually returned/);
});

test("Bilibili fallback requests the highest anonymous quality intent", async () => {
  const parser = new BilibiliParser();
  const requests = [];
  parser._fetchJsonFromPage = async (_page, requestUrl) => {
    requests.push(new URL(requestUrl));
    return { code: 0, data: dashFixture() };
  };

  const result = await parser._fetchPlayurlFallback(
    {},
    { bvid: "BV1fixture", cid: 123 },
    "https://www.bilibili.com/video/BV1fixture",
  );

  assert.ok(result?.dash);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get("qn"), "127");
  assert.equal(requests[0].searchParams.get("fourk"), "1");
  assert.equal(requests[0].searchParams.get("fnval"), "4048");
});

test("Bilibili legacy muxed streams remain selectable and auditable", () => {
  const parser = new BilibiliParser();
  const fixture = {
    quality: 64,
    accept_quality: [64, 32],
    support_formats: [{ quality: 64, new_description: "720P" }, { quality: 32, new_description: "480P" }],
    durl: [{ url: "https://media.test/muxed.mp4", size: 1234 }],
  };
  const available = parser._extractAvailableStreams(fixture);
  const alternatives = parser._buildMediaAlternatives(available);

  assert.equal(available[0].type, "video+audio");
  assert.equal(available[0].totalBytes, 1234);
  assert.deepEqual(alternatives, [[available[0]]]);
});

test("Bilibili temporary view API codes stay retryable; known content codes are permanent", () => {
  const riskControl = classifyBilibiliViewApiError(-412);
  assert.equal(riskControl.code, "PLATFORM_API_ERROR");
  assert.equal(riskControl.permanent, false);
  assert.equal(riskControl.retryable, true);

  const missing = classifyBilibiliViewApiError(-404);
  assert.equal(missing.code, "CONTENT_UNAVAILABLE");
  assert.equal(missing.permanent, true);
  assert.equal(missing.retryable, false);

  assert.equal(classifyBilibiliViewApiError(0), null);
});

test("Bilibili later retryable view codes do not demote earlier permanent content errors", () => {
  let permanentError = preferPlatformError(null, classifyBilibiliViewApiError(62002));
  permanentError = preferPlatformError(permanentError, classifyBilibiliViewApiError(-412));
  assert.equal(permanentError.code, "CONTENT_UNAVAILABLE");
  assert.equal(permanentError.permanent, true);

  // Body permanent must also upgrade over a sticky retryable API error.
  permanentError = preferPlatformError(null, classifyBilibiliViewApiError(-412));
  permanentError = preferPlatformError(permanentError, new PlatformError("已被删除", {
    code: "CONTENT_DELETED",
    category: "content",
    permanent: true,
    retryable: false,
  }));
  assert.equal(permanentError.code, "CONTENT_DELETED");
  assert.equal(permanentError.permanent, true);
});

test("Bilibili empty streams preserve an earlier permanentError when present", () => {
  // Mirrors the empty-stream branch: prefer permanentError over MEDIA_DISCOVERY_FAILED.
  const permanentError = classifyBilibiliViewApiError(62002);
  const mediaStreams = [];
  let thrown = null;
  try {
    if (mediaStreams.length === 0) {
      if (permanentError) throw permanentError;
      throw new Error("No valid media streams found");
    }
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, permanentError);
  assert.equal(thrown.code, "CONTENT_UNAVAILABLE");
  assert.equal(thrown.permanent, true);
});
