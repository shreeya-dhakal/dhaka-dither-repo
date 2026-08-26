import { expect, test } from "vitest";
import { akshara } from "./akshara.ts";
import { BHARATI, bharatiCells, bharatiCoverage } from "./bharati.ts";

test("every cell uses only the six dots Bharati has", () => {
  // Dots 7 and 8 belong to the 8-dot computer braille, not to this script.
  for (const [letter, mask] of Object.entries(BHARATI)) {
    expect(mask & 0xc0, letter).toBe(0);
    expect(mask, letter).toBeGreaterThan(0);
  }
});

test("distinct letters take distinct cells", () => {
  const seen = new Map<number, string>();
  for (const [letter, mask] of Object.entries(BHARATI)) {
    expect(seen.get(mask), `${letter} collides with ${seen.get(mask)}`).toBeUndefined();
    seen.set(mask, letter);
  }
});

test("a consonant with a vowel sign spans two cells, as Bharati writes it", () => {
  // The grid consumes a run of cells and does not care that two came from one
  // syllable, so the vowel is not lost.
  expect(bharatiCells("कि")).toEqual([BHARATI["क"], BHARATI["इ"]]);
  expect(bharatiCells("को")).toEqual([BHARATI["क"], BHARATI["ओ"]]);
  expect(bharatiCells("मी")).toEqual([BHARATI["म"], BHARATI["ई"]]);
});

test("an inherent-vowel consonant is a single cell", () => {
  expect(bharatiCells("क")).toEqual([BHARATI["क"]]);
});

test("an independent vowel is its own cell", () => {
  expect(bharatiCells("आ")).toEqual([BHARATI["आ"]]);
});

test("a conjunct loses its virama, the one remaining approximation", () => {
  // क्षि emits क, ष, इ — readable as three sounds rather than the joined
  // कषि. Asserted so the loss stays visible instead of being discovered by
  // someone who reads braille.
  expect(bharatiCells("क्षि")).toEqual([BHARATI["क"], BHARATI["ष"], BHARATI["इ"]]);
});

test("anything unmapped returns null rather than a wrong cell", () => {
  expect(bharatiCells("Dhaka")).toBeNull();
  expect(bharatiCells("123")).toBeNull();
  expect(bharatiCells("")).toBeNull();
});

test("coverage is reported honestly for mixed text", () => {
  const units = akshara("धाका Dhaka");
  expect(units).toEqual(["धा", "का", "Dhaka"]);
  expect(bharatiCoverage(units)).toEqual({ mapped: 2, total: 3 });
});
