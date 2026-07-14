import assert from "node:assert/strict";
import test from "node:test";

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
