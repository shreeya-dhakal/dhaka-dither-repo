/**
 * Recursive threshold-matrix generation.
 *
 * M2 is the seed [[0,2],[3,1]]. Each doubling places four scaled copies of the
 * previous matrix and offsets each quadrant by the seed value for that
 * quadrant:  M2n[y][x] = 4 * Mn[y%n][x%n] + M2[floor(y/n)][floor(x/n)]
 */

import { wrap, type ThresholdSource } from "./dither.ts";

export type BayerSize = 2 | 4 | 8 | 16;

export const BAYER_SIZES: readonly BayerSize[] = [2, 4, 8, 16];

const SEED = [
  [0, 2],
  [3, 1],
];

const cache = new Map<BayerSize, Uint16Array>();

/** Row-major `n * n` matrix holding each cell's rank in `0 .. n²-1`. */
export function bayerMatrix(n: BayerSize): Uint16Array {
  const cached = cache.get(n);
  if (cached) return cached;

  let size = 2;
  let m = Uint16Array.from([0, 2, 3, 1]);

  while (size < n) {
    const next = new Uint16Array(size * size * 4);
    const nextSize = size * 2;
    for (let y = 0; y < nextSize; y++) {
      for (let x = 0; x < nextSize; x++) {
        const quadrant = SEED[Math.floor(y / size)]![Math.floor(x / size)]!;
        next[y * nextSize + x] = 4 * m[(y % size) * size + (x % size)]! + quadrant;
      }
    }
    m = next;
    size = nextSize;
  }

  cache.set(n, m);
  return m;
}

/**
 * Threshold offset in `[-0.5, 0.5)`, tiled over the plane. Callers scale this
 * by the level spacing and the user's strength control.
 */
export function bayerSource(n: BayerSize): ThresholdSource {
  const m = bayerMatrix(n);
  const area = n * n;
  return (x, y) => (m[wrap(y, n) * n + wrap(x, n)]! + 0.5) / area - 0.5;
}
