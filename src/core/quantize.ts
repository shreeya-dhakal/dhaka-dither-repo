/**
 * Level quantization and tone adjustment.
 *
 * Everything here works on 0–255 channel values held in a `Float32Array`:
 * intermediate tone stages and diffused error both need headroom that a
 * `Uint8ClampedArray` would silently eat.
 */

/** Rec. 709 luminance weights. */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

export interface Tone {
  /** Additive, −255 … 255. */
  brightness: number;
  /**
   * −1 … 1, NOT −255 … 255. The 1.015 constant below is a rounded 259/255 and
   * the curve only behaves on the normalized range: a UI slider of −100 … 100
   * divides by 100 before calling. Passing 255 here gives a factor of ~135.
   */
  contrast: number;
  /** > 0. 1 is identity. */
  gamma: number;
  invert: boolean;
}

export const NEUTRAL_TONE: Tone = { brightness: 0, contrast: 0, gamma: 1, invert: false };

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function contrastFactor(c: number): number {
  return (1.015 * (c + 1)) / (1.015 - c);
}

/**
 * Brightness → contrast → gamma → invert, clamping after each stage.
 * Mutates `buf` in place.
 *
 * `stride` is values per pixel. At 1 the whole buffer is a single channel; at 4
 * only the first three of each group are touched, so an interleaved RGBA buffer
 * keeps its alpha — gamma-correcting opacity would quietly wreck the cutout
 * mode, and inverting it would turn every transparent pixel opaque.
 */
export function applyTone(buf: Float32Array, tone: Tone, stride = 1): void {
  const { brightness, contrast, gamma, invert } = tone;
  const factor = contrastFactor(contrast);
  const invGamma = 1 / gamma;
  const channels = stride === 1 ? 1 : Math.min(3, stride);

  for (let p = 0; p + channels <= buf.length; p += stride) {
    for (let c = 0; c < channels; c++) {
      let v = buf[p + c]!;
      if (brightness !== 0) v = clamp255(v + brightness);
      if (contrast !== 0) v = clamp255((v - 128) * factor + 128);
      if (gamma !== 1) v = clamp255(255 * Math.pow(v / 255, invGamma));
      if (invert) v = 255 - v;
      buf[p + c] = v;
    }
  }
}

/** Interleaved RGB(A) → single-channel luminance. `stride` is 3 or 4. */
export function toLuminance(rgb: Float32Array, stride: number, out: Float32Array): Float32Array {
  const needed = out.length * stride;
  if (rgb.length < needed) {
    throw new Error(`source holds ${rgb.length} values, need ${needed} for ${out.length} pixels`);
  }
  for (let i = 0, p = 0; i < out.length; i++, p += stride) {
    out[i] = LUMA_R * rgb[p]! + LUMA_G * rgb[p + 1]! + LUMA_B * rgb[p + 2]!;
  }
  return out;
}

/** Value in 0–255 → level index in `0 .. levels-1`. Clamps: diffused error overshoots. */
export function quantizeIndex(v: number, levels: number): number {
  const i = Math.round((v / 255) * (levels - 1));
  return i < 0 ? 0 : i > levels - 1 ? levels - 1 : i;
}

/** Level index → its 0–255 value. Index 0 is black, `levels-1` is white. */
export function levelValue(index: number, levels: number): number {
  return (index * 255) / (levels - 1);
}

/** Spacing between adjacent levels, in 0–255 units. Ordered dither scales by this. */
export function levelStep(levels: number): number {
  return 255 / (levels - 1);
}
