import assert from "node:assert/strict";
import test from "node:test";

import { buildCandidateFailureError } from "../scripts/media/downloader.js";

test("candidate exhaustion preserves no-audio semantics and stops retrying", () => {
  const error = buildCandidateFailureError([
    {
      alternativeIndex: 0,
      code: "MEDIA_AUDIO_TRACK_MISSING",
      category: "media",
      stage: "download",
      retryable: true,
      retryScope: "candidate",
      message: "Downloaded video has no audio track",
      userMessage: "下载到的媒体没有音轨，无法转写。",
    },
    {
      alternativeIndex: 1,
      code: "MEDIA_AUDIO_TRACK_MISSING",
      category: "media",
      stage: "download",
      retryable: true,
      retryScope: "candidate",
      message: "Downloaded video has no audio track",
      userMessage: "下载到的媒体没有音轨，无法转写。",
    },
  ], 2);

  assert.equal(error.code, "MEDIA_AUDIO_TRACK_MISSING");
  assert.equal(error.category, "media");
  assert.equal(error.permanent, false);
  assert.equal(error.retryable, false);
  assert.match(error.userMessage, /没有音轨|无法转写|快速跳过/u);
  assert.equal(error.candidateFailures.length, 2);
});

test("candidate exhaustion remains retryable when failures look transient", () => {
  const error = buildCandidateFailureError([
    {
      alternativeIndex: 0,
      code: "MEDIA_HTTP_STATUS",
      category: "network",
      stage: "download",
      retryable: true,
      retryScope: "candidate",
      message: "Media request returned HTTP 403",
    },
    {
      alternativeIndex: 1,
      code: "MEDIA_INCOMPLETE",
      category: "network",
      stage: "download",
      retryable: true,
      retryScope: "candidate",
      message: "Incomplete media",
    },
  ], 2);

  assert.equal(error.code, "MEDIA_CANDIDATES_EXHAUSTED");
  assert.equal(error.permanent, false);
  assert.equal(error.retryable, true);
  assert.equal(error.retryScope, "item");
});
