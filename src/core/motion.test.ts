import { expect, test } from "vitest";
import { MOTION_IDS, motionField, type MotionId } from "./motion.ts";

const animated = MOTION_IDS.filter((id) => id !== "none");

test("none is the identity at every position and time", () => {
  const field = motionField("none");
  for (const t of [0, 0.5, 3, 97.25]) {
    expect(field(0, 0, t)).toBe(0);
    expect(field(0.5, 0.5, t)).toBe(0);
    expect(field(1, 1, t)).toBe(0);
  }
});

test("every field stays inside the tone range it promises", () => {
  for (const id of animated) {
    const field = motionField(id, 1, 16 / 9);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 40; i++) {
      const t = i * 0.37;
      for (let y = 0; y <= 10; y++) {
        for (let x = 0; x <= 10; x++) {
          const value = field(x / 10, y / 10, t);
          expect(Number.isFinite(value), `${id} produced ${value}`).toBe(true);
          lo = Math.min(lo, value);
          hi = Math.max(hi, value);
        }
      }
    }
    expect(lo, `${id} underflowed`).toBeGreaterThanOrEqual(-1.0001);
    expect(hi, `${id} overflowed`).toBeLessThanOrEqual(1.0001);
  }
});

/**
 * The invariant the whole design rests on: a field is a pure function of where
 * and when. Export derives `t` from the frame index and the timeline scrubs to
 * arbitrary points, so a value that depended on evaluation order would make the
 * same clip export differently twice — and would rule out scrubbing entirely.
 */
test("a field asked the same question twice gives the same answer", () => {
  for (const id of animated) {
    const first = motionField(id, 1.3, 1.5);
    const second = motionField(id, 1.3, 1.5);
    // Deliberately out of order the second time round: a sequential RNG would
    // survive an in-order comparison and fail this one.
    const points: [number, number, number][] = [
      [0.1, 0.2, 0], [0.7, 0.3, 1.5], [0.5, 0.5, 9.25], [0.9, 0.05, 0.75],
    ];
    const forward = points.map(([u, v, t]) => first(u, v, t));
    const backward = [...points].reverse().map(([u, v, t]) => second(u, v, t));
    expect(backward.reverse(), `${id} is not position-deterministic`).toEqual(forward);
  }
});

/**
 * The same instance, re-asked. `cellular` memoizes its feature points on the
 * lattice cell it is looking at, which is only sound while the key covers `t`
 * as well — a cache keyed on position alone would hand a scrubbed frame the
 * points belonging to whichever time it happened to be asked about first.
 * Held one instance and one position, varying only `t`, which is precisely
 * what the timeline does.
 */
test("one field instance answers for a time it has already left", () => {
  for (const id of animated) {
    const reference = [0, 0.4, 1.1, 2.7, 0.4, 0].map((t) => motionField(id, 1.3, 1.5)(0.42, 0.58, t));
    const reused = motionField(id, 1.3, 1.5);
    const actual = [0, 0.4, 1.1, 2.7, 0.4, 0].map((t) => reused(0.42, 0.58, t));
    expect(actual, `${id} remembers a previous t`).toEqual(reference);
  }
});

test("every field actually moves", () => {
  for (const id of animated) {
    const field = motionField(id, 1, 1);
    const samples = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const t = i * 0.21;
      samples.add(
        [field(0.25, 0.35, t), field(0.6, 0.7, t), field(0.5, 0.5, t)]
          .map((v) => v.toFixed(4))
          .join(","),
      );
    }
    expect(samples.size, `${id} is static`).toBeGreaterThan(4);
  }
});

test("the spatial fields vary across the frame, the uniform ones do not", () => {
  const across = (id: MotionId) => {
    const field = motionField(id, 1, 1);
    const values = [];
    for (let y = 0; y <= 8; y++) {
      for (let x = 0; x <= 8; x++) values.push(field(x / 8, y / 8, 1.7).toFixed(4));
    }
    return new Set(values).size;
  };
  // Breathe and Pulse are the spatially uniform members of the same family —
  // that is the point of the single mechanism, so it is asserted rather than
  // left as a comment.
  expect(across("breathe")).toBe(1);
  expect(across("pulse")).toBe(1);
  for (const id of ["wave", "spiral", "rain", "ripple", "cellular"] as const) {
    expect(across(id), `${id} should vary across the frame`).toBeGreaterThan(4);
  }
  // Sparkle is deliberately two-valued within a frame: every cell that is lit
  // shares the step's phase, and the rest sit at rest. Asking it for a
  // continuous spread would be asking it to stop being a spark.
  expect(across("sparkle")).toBe(2);
});

test("speed changes the rate and not the shape", () => {
  // Sampling twice as fast at half the speed must trace the same curve.
  for (const id of ["breathe", "wave", "spiral", "ripple"] as const) {
    const slow = motionField(id, 0.5, 1);
    const fast = motionField(id, 1, 1);
    for (let i = 0; i < 12; i++) {
      const t = i * 0.4;
      expect(slow(0.3, 0.6, t * 2)).toBeCloseTo(fast(0.3, 0.6, t), 10);
    }
  }
});

test("ripple stays round on a wide frame", () => {
  const field = motionField("ripple", 1, 2);
  // Two points at equal distance from the centre once the aspect is applied:
  // one along x at half the offset, one along y. Without the correction the
  // rings come out as ellipses and these disagree.
  expect(field(0.5 + 0.1 / 2, 0.5, 2)).toBeCloseTo(field(0.5, 0.5 + 0.1, 2), 10);
});

/**
 * Pulse, Rain and Sparkle are event fields: they add light where they fire and
 * rest at zero. A resting value of -1 would darken the entire frame between
 * events, which is what selecting them used to do.
 */
test("the event fields rest at no change rather than at full dark", () => {
  for (const id of ["pulse", "rain", "sparkle"] as const) {
    const field = motionField(id, 1, 1);
    let lowest = Infinity;
    for (let i = 0; i < 60; i++) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          lowest = Math.min(lowest, field(x / 8, y / 8, i * 0.13));
        }
      }
    }
    expect(lowest, `${id} darkens the frame at rest`).toBeGreaterThanOrEqual(0);
  }
});

test("sparkle leaves most of the frame dark", () => {
  const field = motionField("sparkle", 1, 1);
  let lit = 0;
  let total = 0;
  for (let i = 0; i < 10; i++) {
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        total++;
        if (field(x / 32, y / 32, i * 0.3) > 0.5) lit++;
      }
    }
  }
  // Sparse by design: a field that lights most cells is a flicker, not a spark.
  expect(lit / total).toBeLessThan(0.2);
  expect(lit).toBeGreaterThan(0);
});
