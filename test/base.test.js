import assert from "node:assert/strict";
import test from "node:test";

import {
  PlatformError,
  validateParsedVideo,
} from "../scripts/platforms/base.js";

function parsedVideo(mediaStreams) {
  return {
    platform: "测试平台",
    sourceUrl: "https://source.test/video/1",
    canonicalUrl: "https://canonical.test/video/1",
    videoId: "video-1",
    title: "测试视频",
    author: { nickname: "测试作者" },
    description: null,
    postTime: null,
    duration: 10,
    statistics: {},
    mediaStreams,
  };
}

test("validateParsedVideo accepts a normalized muxed stream", () => {
  const parsed = parsedVideo([
    {
      url: "https://media.test/video.mp4",
      type: "video+audio",
      format: "mp4",
      quality: 1080,
    },
  ]);

  assert.equal(validateParsedVideo(parsed, "fixture"), parsed);
});

test("validateParsedVideo accepts normalized split video and audio streams", () => {
  const parsed = parsedVideo([
    {
      url: "https://media.test/video.m4s",
      type: "video",
      format: "m4s",
    },
    {
      url: "https://media.test/audio.m4s",
      type: "audio",
      format: "m4s",
    },
  ]);

  assert.equal(validateParsedVideo(parsed, "fixture"), parsed);
});

test("validateParsedVideo rejects invalid normalized results with a permanent platform error", () => {
  const invalidCases = [
    ["non-object", null, /expected an object/],
    ["missing platform", { ...parsedVideo([]), platform: "" }, /platform must be a non-empty string/],
    ["missing title", { ...parsedVideo([]), title: null }, /title must be a string/],
    ["missing author", { ...parsedVideo([]), author: null }, /author must be an object/],
    ["missing statistics", { ...parsedVideo([]), statistics: null }, /statistics must be an object/],
    ["invalid duration", { ...parsedVideo([]), duration: "10" }, /duration must be a non-negative number or null/],
    ["empty streams", parsedVideo([]), /mediaStreams must be a non-empty array/],
    [
      "relative stream URL",
      parsedVideo([{ url: "/video.mp4", type: "video+audio", format: "mp4" }]),
      /url must be an absolute HTTP\(S\) URL/,
    ],
    [
      "unsupported stream type",
      parsedVideo([{ url: "https://media.test/video.mp4", type: "muxed", format: "mp4" }]),
      /type is unsupported/,
    ],
    [
      "unsupported stream format",
      parsedVideo([{ url: "https://media.test/video.webm", type: "video+audio", format: "webm" }]),
      /format is unsupported/,
    ],
    [
      "video without audio",
      parsedVideo([{ url: "https://media.test/video.m4s", type: "video", format: "m4s" }]),
      /muxed stream or a video\/audio pair/,
    ],
    [
      "audio without video",
      parsedVideo([{ url: "https://media.test/audio.m4s", type: "audio", format: "m4s" }]),
      /muxed stream or a video\/audio pair/,
    ],
  ];

  for (const [name, parsed, message] of invalidCases) {
    assert.throws(
      () => validateParsedVideo(parsed, "fixture"),
      (error) => {
        assert.ok(error instanceof PlatformError, name);
        assert.equal(error.code, "INVALID_PLUGIN_RESULT", name);
        assert.equal(error.permanent, true, name);
        assert.match(error.message, /platform plugin fixture/, name);
        assert.match(error.message, message, name);
        return true;
      },
    );
  }
});
