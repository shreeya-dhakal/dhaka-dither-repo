import { expect, test } from "vitest";
import { KERNELS, KERNEL_IDS } from "./kernels.ts";

function sum(id: (typeof KERNEL_IDS)[number]): number {
  return KERNELS[id].weights.reduce((total, [, , w]) => total + w, 0);
}

test("every kernel distributes its full error, except Atkinson which does not", () => {
  for (const id of KERNEL_IDS) {
    if (id === "atkinson") continue;
    expect(sum(id), id).toBe(KERNELS[id].divisor);
  }

  // Atkinson is the deliberate exception: 6/8 of the error propagates and the
  // remaining quarter is thrown away, which is what opens up its shadows and
  // blows its highlights. A test asserting sum === divisor for all seven
  // kernels would be asserting a false thing, and the only way to make it pass
  // would be to break Atkinson.
  expect(sum("atkinson")).toBe(6);
  expect(KERNELS.atkinson.divisor).toBe(8);
});

test("kernel offsets only ever point forward along the scan", () => {
  // dy < 0 would write into a row already emitted; dy === 0 with dx <= 0 would
  // write behind the head on the same row. Either one silently corrupts the
  // serpentine path, where dx is mirrored.
  for (const id of KERNEL_IDS) {
    for (const [dx, dy] of KERNELS[id].weights) {
      expect(dy, `${id} [${dx},${dy}]`).toBeGreaterThanOrEqual(0);
      if (dy === 0) expect(dx, `${id} [${dx},${dy}]`).toBeGreaterThan(0);
    }
  }
});
