import assert from "node:assert/strict";
import test from "node:test";

import { PlatformError, preferPlatformError } from "../scripts/platforms/base.js";
import { DouyinParser } from "../scripts/platforms/douyin.js";

const parser = new DouyinParser();

test("Douyin detail collection keeps video variants and never collects music audio", () => {
  const candidates = [];
  parser._collectMediaUrls({
    aweme_detail: {
      video: {
        width: 1080,
        height: 1920,
        dynamic_cover: {
          url_list: ["https://v3.douyinvod.com/aweme/v1/play/?cover_id=wrong"],
        },
        bit_rate: [
          {
            gear_name: "normal_720_1",
            bit_rate: 1_500_000,
            play_addr: {
              width: 720,
              height: 1280,
              data_size: 10_000,
              url_list: ["https://v3.douyinvod.com/aweme/v1/play/?video_id=720"],
            },
          },
          {
            gear_name: "normal_1080_1",
            bit_rate: 3_000_000,
            play_addr: {
              width: 1080,
              height: 1920,
              data_size: 20_000,
              url_list: ["https://v3.douyinvod.com/aweme/v1/play/?video_id=1080"],
            },
          },
        ],
      },
      music: {
        play_url: {
          url_list: ["https://v3.douyinvod.com/aweme/v1/play/?audio_id=wrong"],
        },
      },
    },
  }, candidates);

  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.type === "video+audio"));
  assert.ok(candidates.every((candidate) => !candidate.url.includes("audio_id")));
  assert.deepEqual(parser._extractAdvertisedQualities({
    aweme_detail: { video: { bit_rate: [{ gear_name: "720p" }, { gear_name: "1080p" }] } },
  }), ["720p", "1080p"]);
});

test("Douyin anonymous selection ranks resolution above currentSrc and exposes fallbacks", () => {
  const currentSrc = parser._normalizeCandidate({
    url: "https://v3.douyinvod.com/aweme/v1/play/?video_id=current",
    type: "video+audio",
    source: "video-current-src",
    width: 720,
    height: 1280,
    bitrate: 4_000_000,
  });
  const best = parser._normalizeCandidate({
    url: "https://v3.douyinvod.com/aweme/v1/play/?video_id=best",
    type: "video+audio",
    source: "detail-json",
    width: 1080,
    height: 1920,
    bitrate: 3_000_000,
  });
  const candidates = [currentSrc, best].sort((a, b) => parser._compareCandidates(b, a));
  const alternatives = parser._buildMediaAlternatives(candidates);

  assert.equal(alternatives.length, 2);
  assert.equal(alternatives[0][0].url, best.url);
  assert.equal(alternatives[1][0].url, currentSrc.url);
  assert.equal(alternatives[0][0].type, "video+audio");
  assert.equal(alternatives[0][0].quality, 1080);
});

test("Douyin selection supports DASH pairs and safely typed direct play URLs", () => {
  const direct = parser._normalizeCandidate({
    url: "https://v3.douyinvod.com/aweme/v1/play/?video_id=verified",
    type: "video+audio",
    source: "media-response",
  });
  const unsafe = parser._normalizeCandidate({
    url: "https://v3.douyinvod.com/aweme/v1/play/?audio_id=unknown",
    source: "detail-json",
  });
  const video = parser._normalizeCandidate({
    url: "https://v3.douyinvod.com/path/media-video-avc1.mp4",
    width: 1080,
    height: 1920,
    bitrate: 5_000_000,
  });
  const audio = parser._normalizeCandidate({
    url: "https://v3.douyinvod.com/path/media-audio-und-mp4a.mp4",
    bitrate: 192_000,
  });

  assert.equal(direct.type, "video+audio");
  assert.equal(unsafe, null);
  assert.deepEqual(parser._buildMediaAlternatives([video, audio])[0].map((stream) => stream.type), ["video", "audio"]);
});

test("Douyin image notes are classified as unsupported content", () => {
  const error = parser._classifyUnsupportedDetail({
    aweme_detail: {
      aweme_type: 68,
      images: [{ url_list: ["https://example.test/image.jpg"] }],
      video: null,
    },
  }, "https://www.douyin.com/note/123456");

  assert.equal(error.code, "UNSUPPORTED_CONTENT_TYPE");
  assert.equal(error.category, "content");
  assert.equal(error.permanent, true);
  assert.equal(error.retryable, false);
  assert.match(error.userMessage, /图文作品|不是可转写视频/u);
});

test("Douyin empty image arrays are not enough to mark a video as an image note", () => {
  const error = parser._classifyUnsupportedDetail({
    aweme_detail: {
      aweme_type: 0,
      images: [],
      image_infos: [],
      video: null,
    },
  }, "https://www.douyin.com/video/123456");

  assert.equal(error, null);
});

test("Douyin detail deletion status is not masked by status_code zero", () => {
  const error = parser._classifyDetailStatus({
    status_code: 0,
    aweme_detail: { status: { is_delete: 1 } },
  });

  assert.equal(error.code, "CONTENT_DELETED");
  assert.equal(error.category, "content");
  assert.equal(error.permanent, true);
});

test("Douyin permanent detail errors are not overwritten by later retryable status", () => {
  const deleted = parser._classifyDetailStatus({
    status_code: 0,
    aweme_detail: { status: { is_delete: 1 } },
  });
  const imageNote = parser._classifyUnsupportedDetail({
    aweme_detail: {
      aweme_type: 68,
      images: [{ url_list: ["https://example.test/image.jpg"] }],
      video: null,
    },
  }, "https://www.douyin.com/note/123456");
  const retryableStatus = parser._classifyDetailStatus({
    status_code: 5,
    aweme_detail: { status: {} },
  });

  // Simulate response handler assignment order: permanent first, then a later retryable detail.
  let permanentError = null;
  permanentError = preferPlatformError(permanentError, deleted);
  permanentError = preferPlatformError(permanentError, retryableStatus);
  assert.equal(permanentError.code, "CONTENT_DELETED");
  assert.equal(permanentError.permanent, true);

  permanentError = preferPlatformError(permanentError, imageNote);
  permanentError = preferPlatformError(permanentError, retryableStatus);
  assert.equal(permanentError.code, "UNSUPPORTED_CONTENT_TYPE");
  assert.equal(permanentError.permanent, true);
  assert.equal(retryableStatus.retryable, true);

  // Body deleted text must upgrade over an earlier retryable detail status (not ??=).
  permanentError = preferPlatformError(null, retryableStatus);
  permanentError = preferPlatformError(permanentError, new PlatformError("已删除", {
    code: "CONTENT_DELETED",
    category: "content",
    permanent: true,
    retryable: false,
  }));
  assert.equal(permanentError.code, "CONTENT_DELETED");
  assert.equal(permanentError.permanent, true);
});
