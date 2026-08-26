import { expect, test } from "vitest";
import { errorDiffuseInPlace, hardThreshold, ordered } from "./dither.ts";
import { KERNELS } from "./kernels.ts";
import { levelValue } from "./quantize.ts";

const W = 64;
const H = 64;
const LEVELS = 2;
const FS = KERNELS["floyd-steinberg"];

function ramp(): Float32Array {
  const buf = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) buf[y * W + x] = (x / (W - 1)) * 255;
  }
  return buf;
}

/**
 * Mean absolute tone error over 8×8 blocks.
 *
 * Per-pixel error is meaningless at two levels — every pixel is off by up to
 * 127 by construction, and a comparison against the source would fail for a
 * perfectly correct implementation. What error diffusion actually promises is
 * that local *average* tone survives, so that is what gets measured. This is
 * the assertion that catches broken propagation: drop the error on the floor
 * and each block collapses to flat black or flat white.
 */
function blockToneError(source: Float32Array, index: Uint8Array, block = 8): number {
  const area = block * block;
  let total = 0;
  let blocks = 0;
  for (let by = 0; by < H; by += block) {
    for (let bx = 0; bx < W; bx += block) {
      let want = 0;
      let got = 0;
      for (let y = by; y < by + block; y++) {
        for (let x = bx; x < bx + block; x++) {
          want += source[y * W + x]!;
          got += levelValue(index[y * W + x]!, LEVELS);
        }
      }
      total += Math.abs(want - got) / area;
      blocks++;
    }
  }
  return total / blocks;
}

test("serpentine and progressive scans disagree on uniform mid-gray", () => {
  // They mirror each other on alternate rows, so the outputs are different
  // arrays. Asserting equality here would be asserting something false — and
  // worse, it would pass for an implementation that ignored the flag outright.
  const source = new Float32Array(W * H).fill(128);
  const progressive = errorDiffuseInPlace(source.slice(), W, H, FS, LEVELS, false);
  const serpentine = errorDiffuseInPlace(source.slice(), W, H, FS, LEVELS, true);

  expect(Array.from(serpentine)).not.toEqual(Array.from(progressive));
});

test("both scan directions preserve local tone", () => {
  const source = ramp();
  const progressive = errorDiffuseInPlace(source.slice(), W, H, FS, LEVELS, false);
  const serpentine = errorDiffuseInPlace(source.slice(), W, H, FS, LEVELS, true);

  // Floyd–Steinberg measures ~2.8 progressive and ~3.5 serpentine here, against
  // ~63 for the control below. The threshold sits between the two bands with
  // room on both sides, so it survives a refactor but not a real regression.
  expect(blockToneError(source, progressive)).toBeLessThan(8);
  expect(blockToneError(source, serpentine)).toBeLessThan(8);

  // The control: no diffusion at all. If this ever slips under the threshold
  // above, the threshold has stopped testing anything.
  const flat = ordered(source, W, H, hardThreshold, LEVELS);
  expect(blockToneError(source, flat)).toBeGreaterThan(20);
});

test("the same input dithers to the same output every time", () => {
  const source = ramp();
  for (const serpentine of [false, true]) {
    const first = errorDiffuseInPlace(source.slice(), W, H, FS, LEVELS, serpentine);
    const second = errorDiffuseInPlace(source.slice(), W, H, FS, LEVELS, serpentine);
    expect(Array.from(second), `serpentine=${serpentine}`).toEqual(Array.from(first));
  }
});
