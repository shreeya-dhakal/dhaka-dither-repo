/**
 * Braille dots, drawn rather than typed.
 *
 * Painting filled circles instead of calling `fillText` removes the font
 * dependency, the fallback probing and the density measurement from this path
 * entirely. The output is then identical on every machine without bundling
 * anything, which is a stronger guarantee than the text pipeline can make even
 * with its fonts committed.
 *
 * The copied text still emits real U+2800 codepoints — it encodes the same
 * image; the drawn version is simply the one that cannot vary.
 */

import { CELL_COLS, CELL_ROWS, DOT_BITS } from "../glyph/braille.ts";
import type { Rgb } from "../core/palette.ts";
import type { ParamSet } from "../params.ts";
import { BLOOM_ALPHA, emits, glowSigma } from "./glow.ts";

function css({ r, g, b }: Rgb): string {
  return `rgb(${r} ${g} ${b})`;
}

export function paintBraille(
  masks: Uint8Array,
  cols: number,
  rows: number,
  ink: Rgb,
  paper: Rgb | null,
  params: ParamSet,
  target: HTMLCanvasElement,
  outW: number,
  outH: number,
  /** Per-cell 0–1 scale for the dots. Bharati mode uses it to carry tone. */
  weights?: Float32Array,
): void {
  target.width = outW;
  target.height = outH;
  const ctx = target.getContext("2d");
  if (!ctx) throw new Error("could not get a 2D context");

  ctx.clearRect(0, 0, outW, outH);
  if (paper) {
    ctx.fillStyle = css(paper);
    ctx.fillRect(0, 0, outW, outH);
  }

  const cellW = outW / cols;
  const cellH = outH / rows;
  const slotW = cellW / CELL_COLS;
  const slotH = cellH / CELL_ROWS;
  // Spacing pulls the dot lattice in or out about the cell's centre, so the
  // cells stay on their grid while the dots inside them breathe.
  const spread = params.dotSpacing;
  const radius = Math.min(slotW, slotH) * 0.5 * params.dotRadius;

  // Glows by the same rules as the glyph painters — additive where the ink is
  // the lighter of the pair, an ordinary halo where it is not — but by a
  // different mechanism, and deliberately.
  //
  // The glyph painters route through a transparent layer because a shadow
  // there is paid per `fillText`, tens of thousands of times. Braille is the
  // opposite shape of problem: every dot in the grid is one path and one fill,
  // so a shadow costs two fills for the whole picture. Sending it through a
  // layer instead made a full-frame `drawImage` the dominant cost and took the
  // paint from 42ms to 162ms — four times slower for the identical look.
  //
  // Sized off the dot's slot rather than the braille cell, because the slot is
  // the mark: a cell holds eight of them, and a halo scaled to the cell would
  // swallow the lattice that carries the picture.
  const blur = glowSigma(params.glow, slotW, slotH) * 2;
  ctx.fillStyle = css(ink);

  // One path, one fill. A fill per dot is tens of thousands of state changes on
  // a large grid, which is most of the frame time.
  ctx.beginPath();
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const mask = masks[cy * cols + cx]!;
      if (mask === 0) continue;
      const weight = weights ? weights[cy * cols + cx]! : 1;
      const r = radius * weight;
      if (r < 0.05) continue;

      const originX = cx * cellW;
      const originY = cy * cellH;
      for (let col = 0; col < CELL_COLS; col++) {
        for (let row = 0; row < CELL_ROWS; row++) {
          if ((mask & DOT_BITS[col]![row]!) === 0) continue;
          const x = originX + cellW / 2 + ((col + 0.5) * slotW - cellW / 2) * spread;
          const y = originY + cellH / 2 + ((row + 0.5) * slotH - cellH / 2) * spread;
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
      }
    }
  }
  if (blur > 0) {
    // The halo, then the dots themselves crisp on top. `shadowBlur` is twice
    // the Gaussian's standard deviation, which is what `glowSigma` returns, so
    // the reach matches the glyph painters at the same setting.
    ctx.save();
    ctx.shadowBlur = blur;
    ctx.shadowColor = css(ink);
    if (emits(ink, paper)) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = BLOOM_ALPHA;
    }
    ctx.fill();
    ctx.restore();
  }
  ctx.fill();
}
