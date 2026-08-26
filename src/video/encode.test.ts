import { expect, test } from "vitest";
import { audioSurvives, evenDimension } from "./encode.ts";

test("dimensions are forced to even whole numbers", () => {
  // H.264 rejects odd dimensions, and mp4box reports track size from a 16.16
  // fixed-point field that is not always whole. Either one reaches
  // `configure()` as a bare "Operation is not supported".
  expect(evenDimension(1920)).toBe(1920);
  expect(evenDimension(1081)).toBe(1080);
  expect(evenDimension(1079.9998)).toBe(1078);
  expect(evenDimension(641)).toBe(640);
});

test("a degenerate size still yields something encodable", () => {
  expect(evenDimension(0)).toBe(2);
  expect(evenDimension(1)).toBe(2);
  expect(evenDimension(-5)).toBe(2);
});

test("audio only survives where the container can actually carry it", () => {
  const aac = {
    samples: [],
    codec: "mp4a.40.2",
    sampleRate: 48000,
    channels: 2,
    timescale: 48000,
    description: new Uint8Array([0x12, 0x10]),
  };
  expect(audioSurvives("mp4", aac)).toBe(true);
  // AAC cannot go into WebM; saying so beats silently exporting a mute file.
  expect(audioSurvives("webm", aac)).toBe(false);
  expect(audioSurvives("mp4", null)).toBe(false);
  expect(audioSurvives("mp4", { ...aac, codec: "opus" })).toBe(false);
});

/**
 * A real recording turned this up: an AAC track whose `esds` could not be
 * found. The muxer needs the decoder config to write the track and throws from
 * inside `finalize()` without it — so the whole export failed at the last step,
 * after every frame had already been encoded, with a null-property message from
 * the muxer's internals.
 *
 * Dropping the sound and saying so hands back a working file. Failing does not.
 */
test("a track with no decoder config drops its audio rather than failing the export", () => {
  const noConfig = {
    samples: [],
    codec: "mp4a.40.2",
    sampleRate: 48000,
    channels: 2,
    timescale: 48000,
    description: null,
  };
  expect(audioSurvives("mp4", noConfig)).toBe(false);
});
