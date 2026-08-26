import { expect, test } from "vitest";
import {
  applyTone,
  contrastFactor,
  levelValue,
  NEUTRAL_TONE,
  quantizeIndex,
} from "./quantize.ts";

const LEVELS = [2, 3, 4, 5, 6, 7, 8];

test("levels span black to white and every level is reachable", () => {
  for (const levels of LEVELS) {
    expect(quantizeIndex(0, levels)).toBe(0);
    expect(quantizeIndex(255, levels)).toBe(levels - 1);
    expect(levelValue(0, levels)).toBe(0);
    expect(levelValue(levels - 1, levels)).toBe(255);

    const hit = new Set<number>();
    for (let v = 0; v <= 255; v++) hit.add(quantizeIndex(v, levels));
    expect(hit.size, `levels=${levels}`).toBe(levels);
  }
});

test("out-of-range input clamps rather than wrapping", () => {
  // Error diffusion routinely pushes values past both ends before quantizing.
  for (const levels of LEVELS) {
    expect(quantizeIndex(-4000, levels)).toBe(0);
    expect(quantizeIndex(4000, levels)).toBe(levels - 1);
  }
});

test("neutral tone is a no-op and contrast is identity at 0", () => {
  expect(contrastFactor(0)).toBeCloseTo(1, 12);

  const buf = Float32Array.from({ length: 256 }, (_, i) => i);
  applyTone(buf, NEUTRAL_TONE);
  for (let i = 0; i < 256; i++) expect(buf[i]).toBe(i);
});
