import { expect, test } from "vitest";
import {
  BLANK,
  buildRamp,
  effectiveSteps,
  skippedClusters,
  type MeasuredCluster,
} from "./ramp.ts";

// Densities as if measured: a filled block puts down far more ink than a period.
const SET: MeasuredCluster[] = [
  { cluster: "█", density: 1.0 },
  { cluster: "म", density: 0.42 },
  { cluster: "क", density: 0.35 },
  { cluster: "ि", density: 0.12 },
  { cluster: ".", density: 0.03 },
];

test("the ladder runs darkest first and ends blank", () => {
  const ramp = buildRamp(SET, 6);
  expect(ramp[0]).toBe("█");
  expect(ramp.at(-1)).toBe(BLANK);
  expect(ramp.indexOf("█")).toBeLessThan(ramp.indexOf("."));
});

test("more steps than distinct clusters clamps, with no duplicates", () => {
  // The control goes to 20; this text has five distinct characters. Padding the
  // ladder by repeating them would make several levels render identically.
  const ramp = buildRamp(SET, 20);
  expect(ramp.length).toBe(SET.length + 1);
  expect(new Set(ramp).size).toBe(ramp.length);
  expect(effectiveSteps(SET, 20)).toBe(ramp.length);
});

test("fewer steps samples across the range rather than taking the top", () => {
  const ramp = buildRamp(SET, 3);
  expect(ramp.length).toBe(3);
  expect(new Set(ramp).size).toBe(3);
  // Endpoints of the ink range are kept: densest, and the lightest real glyph.
  expect(ramp[0]).toBe("█");
  expect(ramp[1]).toBe(".");
});

test("whitespace in the source text never takes an ink rung", () => {
  const ramp = buildRamp([...SET, { cluster: " ", density: 0 }], 20);
  expect(ramp.filter((c) => c === BLANK).length).toBe(1);
});

test("a single distinct cluster still yields a usable two-rung ladder", () => {
  const ramp = buildRamp([{ cluster: "क", density: 0.4 }], 8);
  expect(ramp).toEqual(["क", BLANK]);
});

test("clusters the bundled fonts do not cover are dropped from the ladder", () => {
  // A system-fallback glyph paints differently on every machine, so keeping it
  // at any density would still produce different output from the same text.
  const withGaps = [...SET, { cluster: "🌸", density: 0.29, supported: false }];
  expect(buildRamp(withGaps, 20)).not.toContain("🌸");
  expect(skippedClusters(withGaps)).toBe(1);
  expect(effectiveSteps(withGaps, 20)).toBe(SET.length + 1);
});

test("text with nothing covered yields the blank rung, not an empty ramp", () => {
  const none = [
    { cluster: "🌸", density: 0.4, supported: false },
    { cluster: "█", density: 0.29, supported: false },
  ];
  expect(buildRamp(none, 8)).toEqual([BLANK]);
  expect(effectiveSteps(none, 8)).toBe(1);
  expect(skippedClusters(none)).toBe(2);
});
