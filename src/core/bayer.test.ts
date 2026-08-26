import { expect, test } from "vitest";
import { BAYER_SIZES, bayerMatrix, bayerSource } from "./bayer.ts";

// The canonical ordered-dither matrices, transcribed independently of the
// generator so a wrong recurrence cannot agree with itself.
const REFERENCE_4 = [
   0,  8,  2, 10,
  12,  4, 14,  6,
   3, 11,  1,  9,
  15,  7, 13,  5,
];

const REFERENCE_8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

test("4×4 and 8×8 match the reference matrices", () => {
  expect(Array.from(bayerMatrix(4))).toEqual(REFERENCE_4);
  expect(Array.from(bayerMatrix(8))).toEqual(REFERENCE_8);
});

test("every size is a permutation of 0 .. n²-1", () => {
  for (const n of BAYER_SIZES) {
    const m = bayerMatrix(n);
    expect(m.length).toBe(n * n);
    expect(new Set(m).size).toBe(n * n);
    expect(Math.max(...m)).toBe(n * n - 1);
  }
});

test("thresholds stay inside [-0.5, 0.5) and tile", () => {
  for (const n of BAYER_SIZES) {
    const source = bayerSource(n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const t = source(x, y);
        expect(t).toBeGreaterThanOrEqual(-0.5);
        expect(t).toBeLessThan(0.5);
        expect(source(x + n * 3, y + n * 2)).toBe(t);
      }
    }
  }
});
