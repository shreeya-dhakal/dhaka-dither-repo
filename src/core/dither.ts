/**
 * The dithering pass over a Float32Array.
 *
 * Two entry points, both emitting a `Uint8Array` of **level indices**, never
 * colors — `palette.ts` turns indices into pixels. Callers working in RGB run
 * these once per channel.
 */

import type { Kernel } from "./kernels.ts";
import { levelStep, quantizeIndex } from "./quantize.ts";

/**
 * Threshold offset for one grid position, in `[-0.5, 0.5)`. Every ordered
 * algorithm is `ordered()` with a different one of these: Bayer, blue noise,
 * white noise, and hard threshold differ only in this argument.
 */
export type ThresholdSource = (x: number, y: number) => number;

/** Plain threshold at the level midpoint — no pattern at all. */
export const hardThreshold: ThresholdSource = () => 0;

/**
 * Positive modulo. `%` alone returns a negative result for negative operands,
 * which would index a tiling mask out of bounds and silently yield `undefined`.
 * Grid coordinates are non-negative today, but these sources are public and a
 * tiling lookup that breaks on negative input is a trap.
 */
export function wrap(v: number, size: number): number {
  return ((v % size) + size) % size;
}

/**
 * The loops below index with `!` on the strength of `w * h`, which is only
 * sound if the buffers really are that big. Checking once here is what makes
 * those assertions true rather than hopeful.
 */
function requireGrid(buf: Float32Array, out: Uint8Array, w: number, h: number): void {
  if (buf.length < w * h) throw new Error(`buffer holds ${buf.length} values, need ${w * h}`);
  if (out.length < w * h) throw new Error(`output holds ${out.length} values, need ${w * h}`);
}

/**
 * A tiling mask of 8-bit ranks, e.g. the void-and-cluster blue noise from
 * `scripts/bluenoise.ts`. Core never loads the file; the bytes arrive here.
 */
export function maskSource(mask: Uint8Array, size: number): ThresholdSource {
  if (mask.length < size * size) {
    throw new Error(`mask of ${mask.length} bytes is too small for ${size}×${size}`);
  }
  return (x, y) => (mask[wrap(y, size) * size + wrap(x, size)]! + 0.5) / 256 - 0.5;
}

/**
 * Hashed from `(x, y, seed)`, never a sequential RNG: the value at a position
 * must not depend on how many pixels were drawn before it, or every video
 * frame hashes differently and the result boils.
 */
export function whiteNoiseSource(seed: number): ThresholdSource {
  return (x, y) => {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296 - 0.5;
  };
}

/**
 * Ordered dithering. Reads `buf` without modifying it.
 *
 * `strength` runs 0–2 with a detent at 1. Above 1 the offset exceeds the level
 * spacing and tone clips to flat black and white — that is overdrive, and it
 * is deliberate.
 */
export function ordered(
  buf: Float32Array,
  w: number,
  h: number,
  threshold: ThresholdSource,
  levels: number,
  strength = 1,
  out: Uint8Array = new Uint8Array(w * h),
): Uint8Array {
  requireGrid(buf, out, w, h);
  const scale = levelStep(levels) * strength;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] = quantizeIndex(buf[i]! + threshold(x, y) * scale, levels);
    }
  }
  return out;
}

/**
 * Error-diffusion dithering. The mutation is in the name: `buf` carries the
 * propagated error, so it is rewritten as the scan proceeds. The pipeline owns
 * a persistent scratch buffer per `(w, h, channels)` and hands that in — never
 * the source of truth.
 *
 * CPU only, and permanently so: each pixel depends on error written by pixels
 * already visited, which a fragment shader cannot express.
 */
export function errorDiffuseInPlace(
  buf: Float32Array,
  w: number,
  h: number,
  kernel: Kernel,
  levels: number,
  serpentine = false,
  out: Uint8Array = new Uint8Array(w * h),
): Uint8Array {
  requireGrid(buf, out, w, h);
  const step = levelStep(levels);
  const weights = kernel.weights;

  for (let y = 0; y < h; y++) {
    const rightward = !serpentine || (y & 1) === 0;
    const xStart = rightward ? 0 : w - 1;
    const xEnd = rightward ? w : -1;
    const xStep = rightward ? 1 : -1;

    for (let x = xStart; x !== xEnd; x += xStep) {
      const i = y * w + x;
      const index = quantizeIndex(buf[i]!, levels);
      out[i] = index;

      // Not clamped: the error is what the kernel is here to carry, and
      // clipping it to the representable range is what causes tone drift.
      const errUnit = (buf[i]! - index * step) / kernel.divisor;

      for (let k = 0; k < weights.length; k++) {
        const [dx, dy, weight] = weights[k]!;
        const sy = y + dy;
        if (sy >= h) continue;
        const sx = x + (rightward ? dx : -dx);
        if (sx < 0 || sx >= w) continue;
        buf[sy * w + sx]! += errUnit * weight;
      }
    }
  }
  return out;
}
