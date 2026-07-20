import assert from "node:assert/strict";
import test from "node:test";

import { validateMediaTracks } from "../scripts/media/ffmpeg.js";

test("audio track is required only when transcription needs it", () => {
  assert.doesNotThrow(() => validateMediaTracks(
    { audio: false, video: true },
    "Downloaded video",
    { requireAudio: false },
  ));

  assert.throws(
    () => validateMediaTracks({ audio: false, video: true }, "Downloaded video", { requireAudio: true }),
    (error) => {
      assert.equal(error.code, "MEDIA_AUDIO_TRACK_MISSING");
      assert.equal(error.retryable, true);
      assert.equal(error.retryScope, "candidate");
      assert.match(error.userMessage, /没有音轨|无法转写/u);
      return true;
    },
  );
});

test("inconclusive track probes keep the downloaded video", () => {
  assert.doesNotThrow(() => validateMediaTracks(null, "Downloaded video", { requireAudio: true }));
});

test("missing video track is a candidate media error", () => {
  assert.throws(
    () => validateMediaTracks({ audio: true, video: false }, "Downloaded video", { requireAudio: false }),
    (error) => {
      assert.equal(error.code, "MEDIA_VIDEO_TRACK_MISSING");
      assert.equal(error.category, "media");
      assert.equal(error.retryable, true);
      assert.equal(error.retryScope, "candidate");
      return true;
    },
  );
});

test("mediaHasAudio three-state derives from probe tracks", () => {
  const mediaHasAudioFromTracks = (tracks) => {
    if (tracks == null) return null;
    return Boolean(tracks.audio);
  };

  assert.equal(mediaHasAudioFromTracks(null), null);
  assert.equal(mediaHasAudioFromTracks({ audio: true, video: true }), true);
  assert.equal(mediaHasAudioFromTracks({ audio: false, video: true }), false);
});
