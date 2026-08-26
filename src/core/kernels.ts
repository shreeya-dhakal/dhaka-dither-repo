/**
 * Error-diffusion kernel tables.
 *
 * Every kernel is data, never a hand-written loop: `dither.ts` has one
 * diffusion routine that reads these tables. Offsets are written for a
 * left-to-right scan; serpentine rows negate `dx` at scan time.
 */

export type KernelId =
  | "floyd-steinberg"
  | "atkinson"
  | "jarvis"
  | "stucki"
  | "burkes"
  | "sierra"
  | "sierra-lite";

/** `[dx, dy, weight]` relative to the pixel currently being quantized. */
export type DiffusionWeight = readonly [dx: number, dy: number, weight: number];

export interface Kernel {
  readonly id: KernelId;
  readonly divisor: number;
  readonly weights: readonly DiffusionWeight[];
}

export const KERNELS: Readonly<Record<KernelId, Kernel>> = {
  //   *  7
  // 3  5  1
  "floyd-steinberg": {
    id: "floyd-steinberg",
    divisor: 16,
    weights: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
  },

  //   *  1  1
  // 1  1  1
  //    1
  //
  // Atkinson's weights sum to 6 against a divisor of 8: it deliberately
  // discards a quarter of the error at every pixel. That loss is the whole
  // reason it looks the way it does — high contrast, blown highlights, open
  // shadows. Do not "fix" the divisor to 6; that produces a different
  // algorithm that happens to share a name.
  atkinson: {
    id: "atkinson",
    divisor: 8,
    weights: [
      [1, 0, 1],
      [2, 0, 1],
      [-1, 1, 1],
      [0, 1, 1],
      [1, 1, 1],
      [0, 2, 1],
    ],
  },

  //       *  7  5
  // 3  5  7  5  3
  // 1  3  5  3  1
  jarvis: {
    id: "jarvis",
    divisor: 48,
    weights: [
      [1, 0, 7],
      [2, 0, 5],
      [-2, 1, 3],
      [-1, 1, 5],
      [0, 1, 7],
      [1, 1, 5],
      [2, 1, 3],
      [-2, 2, 1],
      [-1, 2, 3],
      [0, 2, 5],
      [1, 2, 3],
      [2, 2, 1],
    ],
  },

  //       *  8  4
  // 2  4  8  4  2
  // 1  2  4  2  1
  stucki: {
    id: "stucki",
    divisor: 42,
    weights: [
      [1, 0, 8],
      [2, 0, 4],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 8],
      [1, 1, 4],
      [2, 1, 2],
      [-2, 2, 1],
      [-1, 2, 2],
      [0, 2, 4],
      [1, 2, 2],
      [2, 2, 1],
    ],
  },

  //       *  8  4
  // 2  4  8  4  2
  burkes: {
    id: "burkes",
    divisor: 32,
    weights: [
      [1, 0, 8],
      [2, 0, 4],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 8],
      [1, 1, 4],
      [2, 1, 2],
    ],
  },

  //       *  5  3
  // 2  4  5  4  2
  //    2  3  2
  sierra: {
    id: "sierra",
    divisor: 32,
    weights: [
      [1, 0, 5],
      [2, 0, 3],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 5],
      [1, 1, 4],
      [2, 1, 2],
      [-1, 2, 2],
      [0, 2, 3],
      [1, 2, 2],
    ],
  },

  //    *  2
  // 1  1
  "sierra-lite": {
    id: "sierra-lite",
    divisor: 4,
    weights: [
      [1, 0, 2],
      [-1, 1, 1],
      [0, 1, 1],
    ],
  },
};

export const KERNEL_IDS = Object.keys(KERNELS) as KernelId[];
