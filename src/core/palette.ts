/**
 * Level indices → RGBA pixels: mono, duotone, per-channel color, alpha cutout.
 *
 * The output is a flat RGBA `Uint8ClampedArray` at working-grid resolution.
 * Whoever owns a canvas turns it into pixels; core stays unaware that canvases
 * exist.
 */

import { levelValue } from "./quantize.ts";

export type OutputMode = "mono" | "duo" | "color" | "palette";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface PaletteOptions {
  levels: number;
  /**
   * Alpha 0 on the lightest level, so the background drops out and the PNG is
   * usable as a sprite.
   */
  cutLightest?: boolean;
}

function alloc(count: number, out?: Uint8ClampedArray): Uint8ClampedArray {
  if (out && out.length < count * 4) {
    throw new Error(`output holds ${out.length} bytes, need ${count * 4} for ${count} pixels`);
  }
  return out ?? new Uint8ClampedArray(count * 4);
}

/** Grayscale at `levels` steps. */
export function paintMono(
  index: Uint8Array,
  { levels, cutLightest = false }: PaletteOptions,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const px = alloc(index.length, out);
  const lightest = levels - 1;
  for (let i = 0, p = 0; i < index.length; i++, p += 4) {
    const level = index[i]!;
    const v = levelValue(level, levels);
    px[p] = v;
    px[p + 1] = v;
    px[p + 2] = v;
    px[p + 3] = cutLightest && level === lightest ? 0 : 255;
  }
  return px;
}

/** Linear interpolation from `dark` at level 0 to `light` at the top level. */
export function paintDuo(
  index: Uint8Array,
  dark: Rgb,
  light: Rgb,
  { levels, cutLightest = false }: PaletteOptions,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const px = alloc(index.length, out);
  const lightest = levels - 1;
  for (let i = 0, p = 0; i < index.length; i++, p += 4) {
    const level = index[i]!;
    const t = level / lightest;
    px[p] = dark.r + (light.r - dark.r) * t;
    px[p + 1] = dark.g + (light.g - dark.g) * t;
    px[p + 2] = dark.b + (light.b - dark.b) * t;
    px[p + 3] = cutLightest && level === lightest ? 0 : 255;
  }
  return px;
}

/**
 * A palette strip: an ordered run of swatches, darkest first.
 *
 * Ordered, because the level index *is* the position in the strip. A strip
 * whose swatches are not in tonal order does not map wrongly so much as it maps
 * to something the tonal ladder no longer describes.
 */
export interface PaletteStrip {
  name: string;
  swatches: Rgb[];
}

/**
 * The bundled strips. Darkest first in every one.
 *
 * These are shipped as data rather than fetched, for the same reason the fonts
 * are: the tool works offline, and a palette that arrives over the network is a
 * palette that can change under an export.
 */
export const BUILT_IN_PALETTES: readonly PaletteStrip[] = [
  {
    name: "gameboy",
    swatches: [
      { r: 15, g: 56, b: 15 },
      { r: 48, g: 98, b: 48 },
      { r: 139, g: 172, b: 15 },
      { r: 155, g: 188, b: 15 },
    ],
  },
  {
    // CGA's palette 1, reordered by luminance. The hardware order is black,
    // cyan, magenta, white — but cyan is much the brighter of the two, so that
    // order makes the ladder climb and then dip, and the mid-tones of a
    // gradient come out lighter than the tones above them. Same four colours,
    // put in the order the level index requires.
    name: "cga",
    swatches: [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 85, b: 255 },
      { r: 85, g: 255, b: 255 },
      { r: 255, g: 255, b: 255 },
    ],
  },
  {
    // The flag's own crimson and blue, with white between them: the two darkest
    // swatches are the border and the field, so the ladder still climbs.
    name: "nepal",
    swatches: [
      { r: 0, g: 51, b: 128 },
      { r: 220, g: 20, b: 60 },
      { r: 255, g: 255, b: 255 },
    ],
  },
];

/**
 * Level index straight into the strip.
 *
 * The strip's swatch count and the quantization level count are the same number
 * by construction — the caller drives `levels` from the strip — because a strip
 * shorter or longer than the ladder maps tones to the wrong swatches rather
 * than failing. The clamp here is a backstop for a caller that got it wrong,
 * not the mechanism.
 */
export function paintPalette(
  index: Uint8Array,
  swatches: readonly Rgb[],
  { levels, cutLightest = false }: PaletteOptions,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  if (swatches.length === 0) throw new Error("a palette strip needs at least one swatch");
  const px = alloc(index.length, out);
  const lightest = levels - 1;
  const top = swatches.length - 1;
  for (let i = 0, p = 0; i < index.length; i++, p += 4) {
    const level = index[i]!;
    const swatch = swatches[Math.min(top, level)]!;
    px[p] = swatch.r;
    px[p + 1] = swatch.g;
    px[p + 2] = swatch.b;
    px[p + 3] = cutLightest && level === lightest ? 0 : 255;
  }
  return px;
}

/**
 * Which strip a `paletteIndex` selects.
 *
 * The authoritative clamp, and the reason `PARAM_RANGES.paletteIndex` carries a
 * placeholder maximum: the real bound is however many strips are loaded, which
 * grows when the user uploads one and is not knowable from a static table.
 */
export function paletteAt(strips: readonly PaletteStrip[], paletteIndex: number): PaletteStrip {
  if (strips.length === 0) throw new Error("no palette strips are loaded");
  const i = Math.min(strips.length - 1, Math.max(0, Math.round(paletteIndex)));
  return strips[i]!;
}

/**
 * Three independently dithered channel planes recombined. Cutout applies only
 * where all three channels sit on the lightest level, i.e. actual white.
 */
export function paintColor(
  r: Uint8Array,
  g: Uint8Array,
  b: Uint8Array,
  { levels, cutLightest = false }: PaletteOptions,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  if (g.length < r.length || b.length < r.length) {
    throw new Error(`channel planes disagree: ${r.length}, ${g.length}, ${b.length}`);
  }
  const px = alloc(r.length, out);
  const lightest = levels - 1;
  for (let i = 0, p = 0; i < r.length; i++, p += 4) {
    const ri = r[i]!;
    const gi = g[i]!;
    const bi = b[i]!;
    px[p] = levelValue(ri, levels);
    px[p + 1] = levelValue(gi, levels);
    px[p + 2] = levelValue(bi, levels);
    px[p + 3] =
      cutLightest && ri === lightest && gi === lightest && bi === lightest ? 0 : 255;
  }
  return px;
}

/**
 * A cell's hue at full strength, carrying no tone of its own.
 *
 * Ramp-mode text art already encodes tone in *which* glyph is chosen, so a tint
 * that also encoded tone would say it twice — light areas would fade to
 * invisible against light paper, and the tonal ladder the density measurement
 * built would flatten. Normalizing to full value strips the tone out and leaves
 * only the hue.
 *
 * Scaling by saturation is what keeps it honest at the grey end: an unsaturated
 * cell returns the ink colour unchanged, so a greyscale image in colour mode is
 * pixel-identical to mono rather than washing out to white.
 */
export function hueTint(r: number, g: number, b: number, ink: Rgb): Rgb {
  const max = Math.max(r, g, b);
  if (max === 0) return ink;
  const min = Math.min(r, g, b);
  const saturation = (max - min) / max;
  const scale = (255 / max) * saturation;
  return {
    r: r * scale + ink.r * (1 - saturation),
    g: g * scale + ink.g * (1 - saturation),
    b: b * scale + ink.b * (1 - saturation),
  };
}
