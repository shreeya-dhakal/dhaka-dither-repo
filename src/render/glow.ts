/**
 * The glow: a halo on every mark the painters draw.
 *
 * Its own module because all three glyph modes need it — density, flow and
 * braille — and one control that behaves differently depending on which of them
 * is running is not one control. Braille draws circles rather than glyphs and
 * still glows by exactly these rules.
 */

import type { Rgb } from "../core/palette.ts";
import { LUMA_B, LUMA_G, LUMA_R } from "../core/quantize.ts";

/**
 * The glow is one blur of the finished glyph layer, not a shadow per glyph.
 *
 * `shadowBlur` is applied per draw call, so a shadowed grid blurs forty-odd
 * thousand times to produce one image — it dominated every profile of this
 * file. Drawing the glyphs once into a transparent layer and blurring *that*
 * costs one filtered `drawImage` over the canvas however many cells are inked.
 */
export const BLOOM_PASSES = 1;

/**
 * How bright the halo is beside the glyph that casts it.
 *
 * Light adds, so a halo at full strength saturates the very strokes it is
 * supposed to surround: at one em the blur is wider than a Devanagari stroke,
 * and the character stops being a character and becomes a bright blob. Held
 * well under half, the halo reads as light coming *off* the letter and the
 * crisp pass on top keeps the letter itself legible.
 */
export const BLOOM_ALPHA = 0.45;

/**
 * Halo standard deviation at `glow` = 1, as a fraction of the cell's short side.
 *
 * Deliberately well under half a cell. A halo that reaches as far as its
 * neighbours stops belonging to any character: the separate glows merge into
 * one field, and what appears to light up is whichever *region* of the picture
 * happens to be dense — the highlights, not the letters. Kept tight, each
 * character carries its own halo and the grid stays legible underneath.
 */
const GLOW_REACH = 0.18;

/**
 * Shared because a paint is synchronous start to finish: the preview and an
 * export never hold it at the same time, and reallocating a full-frame canvas
 * per frame is exactly the garbage a 30fps export cannot afford.
 */
const layerCanvas = document.createElement("canvas");

export function layerContext(outW: number, outH: number): CanvasRenderingContext2D {
  layerCanvas.width = outW;
  layerCanvas.height = outH;
  const ctx = layerCanvas.getContext("2d");
  if (!ctx) throw new Error("could not get a 2D context");
  ctx.clearRect(0, 0, outW, outH);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  return ctx;
}

function luma({ r, g, b }: Rgb): number {
  return LUMA_R * r + LUMA_G * g + LUMA_B * b;
}

/**
 * Whether the ink is a light source against its ground.
 *
 * Light *adds*: a glowing character brightens what is behind it, and two halos
 * that meet get brighter still. That is only true where the ink is the lighter
 * of the pair. Dark ink on pale paper emits nothing — adding light there would
 * do nothing at all and the control would look broken — so that case keeps an
 * ordinary halo, which is ink bleeding into the page.
 *
 * A null paper is the cut-out: the glyphs float on transparency with no ground
 * to be darker than, so they are treated as emitting.
 */
export function emits(ink: Rgb, paper: Rgb | null): boolean {
  return paper === null || luma(ink) > luma(paper);
}

/**
 * Lay the bloom over the paper, then the glyphs themselves on top.
 *
 * The crisp pass is always `source-over`, whatever the bloom did. Additive
 * compositing drives a bright core towards white, and a character that has
 * blown out to a white blob is no longer the character — the halo is what
 * glows, the glyph stays the colour the palette chose for it.
 */
export function compositeGlow(
  ctx: CanvasRenderingContext2D,
  sigma: number,
  additive: boolean,
): void {
  ctx.save();
  ctx.filter = `blur(${sigma}px)`;
  if (additive) {
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = BLOOM_ALPHA;
  }
  for (let pass = 0; pass < BLOOM_PASSES; pass++) ctx.drawImage(layerCanvas, 0, 0);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.drawImage(layerCanvas, 0, 0);
  ctx.restore();
}

/** Halo spread in output pixels, from a fraction of the mark's short side. */
export function glowSigma(glow: number, cellW: number, cellH: number): number {
  return glow > 0 ? glow * GLOW_REACH * Math.min(cellW, cellH) : 0;
}
