import { expect, test } from "vitest";
import {
  displaces,
  falloff,
  HOVER_IDS,
  hoverSample,
  hoverTone,
  type HoverId,
  type HoverState,
} from "./hover.ts";

const at = (id: HoverId, over: Partial<HoverState> = {}): HoverState => ({
  id,
  u: 0.5,
  v: 0.5,
  radius: 0.3,
  strength: 1,
  aspect: 1,
  ...over,
});

const active = HOVER_IDS.filter((id) => id !== "none");

test("none changes neither the sample nor the tone", () => {
  const state = at("none");
  expect(hoverSample(state, 0.2, 0.8)).toEqual({ u: 0.2, v: 0.8 });
  expect(hoverTone(state, 0.2, 0.8, 0.7)).toBe(0);
});

/**
 * The control has no separate enable, so strength 0 is how it rests. An effect
 * that still did something there would mean the user cannot turn it off without
 * also changing the mode back.
 */
test("strength 0 is the identity for every effect", () => {
  for (const id of active) {
    const state = at(id, { strength: 0 });
    expect(hoverSample(state, 0.31, 0.62), id).toEqual({ u: 0.31, v: 0.62 });
    expect(hoverTone(state, 0.31, 0.62, 0.8), id).toBe(0);
  }
});

test("nothing reaches outside its radius", () => {
  for (const id of active) {
    const state = at(id, { radius: 0.2 });
    // Well beyond the rim on both axes.
    expect(hoverSample(state, 0.95, 0.95), id).toEqual({ u: 0.95, v: 0.95 });
  }
  // Flashlight is the deliberate exception: it dims what it does not light, so
  // "no effect outside the circle" would make it a bright patch, not a beam.
  expect(hoverTone(at("flashlight"), 0.95, 0.95)).toBeLessThan(0);
  expect(hoverTone(at("neon"), 0.95, 0.95, 1)).toBe(0);
});

test("falloff is 1 under the pointer and 0 at the rim", () => {
  const state = at("flashlight", { radius: 0.25 });
  expect(falloff(state, 0.5, 0.5)).toBeCloseTo(1, 10);
  expect(falloff(state, 0.5, 0.75)).toBe(0);
  // Smooth rather than linear: the midpoint of a smoothstep is 0.5, but its
  // slope at both ends is zero, which is what removes the visible seam.
  expect(falloff(state, 0.5, 0.625)).toBeCloseTo(0.5, 6);
});

test("the lens and the well pull in opposite directions", () => {
  const u = 0.62;
  // Magnifier samples from nearer the centre, so what is there spreads out.
  const lens = hoverSample(at("magnifier"), u, 0.5);
  expect(lens.u).toBeGreaterThan(0.5);
  expect(lens.u).toBeLessThan(u);
  // Gravity samples from further out, dragging the picture inward.
  const well = hoverSample(at("gravity"), u, 0.5);
  expect(well.u).toBeGreaterThan(u);
});

/**
 * A lens that samples past its own centre folds the image through itself and
 * mirrors it, which looks like a bug rather than like glass.
 */
test("the magnifier never folds through its centre", () => {
  const state = at("magnifier", { strength: 1, radius: 0.5 });
  for (let i = 1; i <= 40; i++) {
    const u = 0.5 + (i / 40) * 0.5;
    const sampled = hoverSample(state, u, 0.5);
    expect(sampled.u, `folded at ${u}`).toBeGreaterThanOrEqual(0.5);
    expect(sampled.u).toBeLessThanOrEqual(u + 1e-9);
  }
});

test("every effect stays inside the tone range it promises", () => {
  for (const id of active) {
    for (const edge of [0, 0.5, 1]) {
      for (let i = 0; i <= 20; i++) {
        for (let j = 0; j <= 20; j++) {
          const value = hoverTone(at(id), i / 20, j / 20, edge);
          expect(Number.isFinite(value), id).toBe(true);
          expect(value, id).toBeGreaterThanOrEqual(-1.0001);
          expect(value, id).toBeLessThanOrEqual(1.0001);
        }
      }
    }
  }
});

test("neon lights an edge and drops a flat", () => {
  const state = at("neon");
  expect(hoverTone(state, 0.5, 0.5, 1)).toBeGreaterThan(0);
  expect(hoverTone(state, 0.5, 0.5, 0)).toBeLessThan(0);
});

test("a wide frame keeps the reach circular", () => {
  const state = at("flashlight", { aspect: 2, radius: 0.3 });
  // Equal distance once the aspect is applied: 0.1 along x doubles to 0.2.
  expect(falloff(state, 0.5 + 0.1, 0.5)).toBeCloseTo(falloff(state, 0.5, 0.5 + 0.2), 10);
});

test("only the lens family moves the sample", () => {
  expect(active.filter(displaces).sort()).toEqual(["gravity", "ice", "magnifier"]);
  for (const id of ["flashlight", "neon"] as const) {
    expect(hoverSample(at(id), 0.55, 0.5), id).toEqual({ u: 0.55, v: 0.5 });
  }
});
