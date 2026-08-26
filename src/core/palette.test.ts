import { expect, test } from "vitest";
import { BUILT_IN_PALETTES, hueTint, paintPalette, paletteAt } from "./palette.ts";

const BLACK = { r: 0, g: 0, b: 0 };

test("an unsaturated cell tints to the ink, so greyscale matches mono exactly", () => {
  expect(hueTint(128, 128, 128, BLACK)).toEqual(BLACK);
  expect(hueTint(255, 255, 255, BLACK)).toEqual(BLACK);
  expect(hueTint(0, 0, 0, BLACK)).toEqual(BLACK);
});

test("a saturated cell keeps its hue at full strength, carrying no tone", () => {
  // Dark red and bright red tint identically: the glyph carries the tone, so
  // the colour must not carry it as well.
  expect(hueTint(128, 0, 0, BLACK)).toEqual(hueTint(255, 0, 0, BLACK));
  expect(hueTint(255, 0, 0, BLACK)).toEqual({ r: 255, g: 0, b: 0 });
});

test("partial saturation lands between the ink and the pure hue", () => {
  const tint = hueTint(255, 128, 128, BLACK);
  expect(tint.r).toBeGreaterThan(tint.g);
  expect(tint.g).toBeCloseTo(tint.b, 10);
  expect(tint.r).toBeLessThan(255);
});

test("the ink colour is respected, not assumed to be black", () => {
  const ink = { r: 20, g: 40, b: 60 };
  expect(hueTint(200, 200, 200, ink)).toEqual(ink);
});

test("a palette maps each level to its own swatch, darkest first", () => {
  const strip = BUILT_IN_PALETTES[0]!;
  const index = new Uint8Array([0, 1, 2, 3]);
  const px = paintPalette(index, strip.swatches, { levels: 4 });
  for (let i = 0; i < 4; i++) {
    const want = strip.swatches[i]!;
    expect([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]).toEqual([want.r, want.g, want.b]);
  }
});

test("every bundled strip climbs from dark to light", () => {
  // The level index *is* the position in the strip, so a strip out of tonal
  // order maps a ladder that no longer describes the picture.
  for (const strip of BUILT_IN_PALETTES) {
    const luma = strip.swatches.map((s) => 0.2126 * s.r + 0.7152 * s.g + 0.0722 * s.b);
    for (let i = 1; i < luma.length; i++) {
      expect(luma[i]!, `${strip.name} dips at swatch ${i}`).toBeGreaterThan(luma[i - 1]!);
    }
  }
});

test("cut-out fires on the lightest level, not the last swatch", () => {
  // The two differ whenever a caller hands in a strip shorter than `levels`;
  // the transparent one must be the lightest *tone*.
  const strip = [
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 255, b: 255 },
  ];
  const px = paintPalette(new Uint8Array([0, 1, 2, 3]), strip, { levels: 4, cutLightest: true });
  expect([px[3], px[7], px[11], px[15]]).toEqual([255, 255, 255, 0]);
});

test("paletteAt clamps against the strips actually loaded", () => {
  // PARAM_RANGES.paletteIndex carries a placeholder maximum on purpose: the
  // real bound grows when the user uploads a strip.
  expect(paletteAt(BUILT_IN_PALETTES, 0).name).toBe(BUILT_IN_PALETTES[0]!.name);
  expect(paletteAt(BUILT_IN_PALETTES, 99).name).toBe(BUILT_IN_PALETTES[BUILT_IN_PALETTES.length - 1]!.name);
  expect(paletteAt(BUILT_IN_PALETTES, -5).name).toBe(BUILT_IN_PALETTES[0]!.name);
});

test("an empty strip is refused rather than painted as nothing", () => {
  expect(() => paintPalette(new Uint8Array([0]), [], { levels: 2 })).toThrow();
  expect(() => paletteAt([], 0)).toThrow();
});
