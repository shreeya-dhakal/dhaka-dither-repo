/**
 * Per-cell glyph painting.
 *
 * Devanagari is not monospace and never will be, so there is no `<pre>` grid
 * and no assumed character advance. Every cluster is drawn individually into
 * its own fixed cell, centred, and handed to `fillText` whole so that shaping
 * and conjunct formation happen normally.
 *
 * Neither mode owns a colour. The glyph is an ink *mask*; what colour it takes
 * arrives already resolved through `palette.ts`, exactly as it would for a
 * dithered pixel. Halftone has its own ink because it produces no level indices
 * at all and never reaches the palette — text art has no such constraint, and
 * giving it one anyway generalised a forced exception into a convention.
 */

import type { Rgb } from "../core/palette.ts";
import { compositeGlow, emits, glowSigma, layerContext } from "./glow.ts";
import { wordNudge } from "../glyph/layout.ts";
import type { ParamSet } from "../params.ts";

function css({ r, g, b }: Rgb): string {
  return `rgb(${r} ${g} ${b})`;
}

/**
 * The shirorekha — the headline Devanagari hangs from — sits high in the em
 * box, so a glyph centred on the exact middle of its cell rides visibly low.
 * Nudging the baseline to about 0.55 of cell height puts the headline where the
 * eye expects the row to be.
 */
const BASELINE = 0.55;

/** Size spans this fraction of the cell at full depth and full brightness. */
const MIN_SIZE = 0.4;

function prepare(
  target: HTMLCanvasElement,
  outW: number,
  outH: number,
  paper: Rgb | null,
): CanvasRenderingContext2D {
  target.width = outW;
  target.height = outH;
  const ctx = target.getContext("2d");
  if (!ctx) throw new Error("could not get a 2D context");
  ctx.clearRect(0, 0, outW, outH);
  // `paper` is null when the lightest level is cut: the glyphs float on
  // transparency instead of a background.
  if (paper) {
    ctx.fillStyle = css(paper);
    ctx.fillRect(0, 0, outW, outH);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  return ctx;
}

/**
 * A per-cluster `maxWidth` that keeps each glyph inside its own cell.
 *
 * The font size comes from the cell, but a cluster's *ink* is not the font's
 * size: a Devanagari consonant carrying a matra — का, को — draws about 1.09
 * cells wide at the size the cell asks for and laps into its neighbour.
 * Nothing in the geometry catches it, because the cell sizes the font rather
 * than the other way round.
 *
 * The overlap is scale-invariant — measured at every pixel size from 4 to 64 it
 * is the same 1.09 — so it is not a large-cell bug. It is 0.4px at pixelSize 4
 * and 6px at pixelSize 64, which is only where the eye starts catching it.
 *
 * Corrected on the horizontal alone, and only for the clusters that overflow.
 * Shrinking the font instead would fix the same collision, but it shrinks every
 * glyph to suit the widest one — and at a six-pixel cell that pushes Devanagari
 * strokes under a pixel, so the darkest cell stops reaching full ink and the
 * tonal ladder loses its bottom rung. The cell is taller than it is wide, so
 * width is the axis that is actually short.
 *
 * `maxWidth` condenses to the *advance*, while what overflows is the ink, so
 * the cap is scaled by the ratio between them. A cluster that already fits gets
 * the full cell and is untouched — `fillText` only condenses what is too wide,
 * so text that never overflowed renders exactly as it did before.
 */
function cellCaps(
  ctx: CanvasRenderingContext2D,
  clusters: readonly string[],
  cellW: number,
): { caps: Float64Array; ink: Float64Array } {
  const caps = new Float64Array(clusters.length);
  const ink = new Float64Array(clusters.length);
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    if (!cluster || cluster.trim() === "") {
      caps[i] = cellW;
      ink[i] = 0;
      continue;
    }
    const m = ctx.measureText(cluster);
    const width = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    caps[i] = width > cellW ? cellW * (m.width / width) : cellW;
    // What it will actually occupy: the cap holds the wide ones to the cell.
    ink[i] = Math.min(width, cellW);
  }
  return { caps, ink };
}


/**
 * Ramp mode: tone lives in *which* cluster is chosen, so the colour must not
 * carry it as well. Colouring each cell by its level would double-count the
 * tone and flatten the ladder the density measurement just built. It reduces to
 * ink on paper — and both colours still come from `palette.ts`, as the darkest
 * and lightest levels of the selected output mode.
 */
export function paintTextArt(
  index: Uint8Array,
  w: number,
  h: number,
  ramp: readonly string[],
  fontFamily: string,
  ink: Rgb,
  paper: Rgb | null,
  target: HTMLCanvasElement,
  outW: number,
  outH: number,
  /**
   * Per-cell RGB, used by colour mode. The glyph still carries every bit of the
   * tone; these supply only hue, so nothing is said twice.
   */
  tints: Uint8ClampedArray | null = null,
  /** Halo radius as a fraction of the cell's short side. 0 draws nothing extra. */
  glow = 0,
): void {
  const ctx = prepare(target, outW, outH, paper);

  const cellW = outW / w;
  const cellH = outH / h;
  // With a glow the glyphs go to a transparent layer and are composited after;
  // without one they are drawn straight onto the paper, at no extra cost.
  const blur = glowSigma(glow, cellW, cellH);
  const g = blur > 0 ? layerContext(outW, outH) : ctx;

  g.font = `${Math.min(cellW, cellH) * 1.05}px ${fontFamily}`;
  // Measured once per paint over the ramp's handful of rungs, against tens of
  // thousands of `fillText` calls.
  const { caps } = cellCaps(g, ramp, cellW);
  g.fillStyle = css(ink);

  let currentFill = "";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = y * w + x;
      // Level index and ramp index agree: 0 is the densest cluster, the last
      // rung is the blank, so a white cell draws nothing.
      const rung = Math.min(index[cell]!, ramp.length - 1);
      const cluster = ramp[rung] ?? "";
      if (cluster === "" || cluster.trim() === "") continue;

      if (tints) {
        const p = cell * 3;
        const fill = `rgb(${tints[p]} ${tints[p + 1]} ${tints[p + 2]})`;
        if (fill !== currentFill) {
          g.fillStyle = fill;
          currentFill = fill;
        }
      }
      g.fillText(cluster, (x + 0.5) * cellW, (y + BASELINE) * cellH, caps[rung]!);
    }
  }
  if (blur > 0) compositeGlow(ctx, blur, emits(ink, paper));
}

/**
 * How far the whole glyph ramp is pulled off the paper, as a fraction of the
 * distance to the ink.
 */
const OFF_PAPER = 0.28;

/**
 * The cell's colour, moved clear of the paper without flattening the ramp.
 *
 * Flow's reason for existing is that the sentence reads, and a glyph painted in
 * the paper's colour is not carrying tone — it is absent. At the default two
 * levels that was half the text, and the sentence came out full of holes.
 *
 * The whole ramp is compressed toward the ink by a constant fraction rather
 * than the light end being clamped to a floor. Clamping was the first attempt
 * and it was worse than the problem: with two levels both ended up at the same
 * ink and the picture disappeared from the text entirely. A constant blend
 * keeps every level's *relative* spacing exactly as the palette set it — the
 * darkest cell does not move at all, since it already is the ink — so the image
 * still reads through the text while nothing lands on the page colour.
 */
function offPaper(colour: Rgb, paper: Rgb | null, ink: Rgb): Rgb {
  if (!paper) return colour;
  return {
    r: colour.r + (ink.r - colour.r) * OFF_PAPER,
    g: colour.g + (ink.g - colour.g) * OFF_PAPER,
    b: colour.b + (ink.b - colour.b) * OFF_PAPER,
  };
}

/**
 * Flow mode: the layout fixes *which* cluster sits in each cell, so the cell's
 * level carries colour much as it would for a dithered pixel — grey in mono, the
 * duo lerp in duo, per-channel RGB in colour — except that it is never allowed
 * to reach the paper. See `offPaper`: tone reaches the eye through weight, size
 * and opacity, and a glyph the colour of the paper conveys nothing at all.
 *
 * `pixels` is the palette's own RGBA output for the grid; `mod` is the
 * luminance level that drives the three modulation axes. At depth 0 every axis
 * draws at its legible end, so turning a control down never turns text to mush.
 */
export function paintFlow(
  cells: Int32Array,
  wordEnds: Uint8Array,
  clusters: readonly string[],
  pixels: Uint8ClampedArray,
  mod: Uint8Array,
  levels: number,
  w: number,
  h: number,
  fontFamily: string,
  params: ParamSet,
  target: HTMLCanvasElement,
  outW: number,
  outH: number,
  paper: Rgb | null,
  ink: Rgb,
): void {
  const ctx = prepare(target, outW, outH, paper);

  const cellW = outW / w;
  const cellH = outH / h;
  const base = Math.min(cellW, cellH) * 1.05;
  const steps = Math.max(1, levels - 1);
  const gap = params.flowWordGap;
  // Sized off the cell, not off the per-level font size: the halo marks where
  // the sentence sits on the lattice, and a glow that shrank with the lighter
  // levels would fade out exactly where flow is already faintest.
  const blur = glowSigma(params.glow, cellW, cellH);
  const g = blur > 0 ? layerContext(outW, outH) : ctx;

  // Weight and size take only `levels` distinct values, so the font strings are
  // built once per level rather than per cell — assigning ctx.font is the
  // expensive part of this loop by a wide margin.
  const fonts: string[] = [];
  const alphas: number[] = [];
  const weights: number[] = [];
  const sizes: number[] = [];
  for (let level = 0; level < levels; level++) {
    const darkness = 1 - level / steps;
    // A variable face interpolates across this range; a static pair snaps to
    // whichever of 400/700 is nearer, which is the documented fallback.
    weights.push(Math.round(400 + params.flowWeight * darkness * 300));
    sizes.push(base * (1 - params.flowSize * (1 - MIN_SIZE) * (1 - darkness)));
    alphas.push(1 - params.flowOpacity * (1 - darkness));
  }
  // Level 0 is the worst case — heaviest weight at the largest size — so one
  // measurement there bounds every level. The scalar then applies to all of
  // them, which keeps the size ladder that carries tone intact.
  g.font = `${weights[0]!} ${sizes[0]!}px ${fontFamily}`;
  const { caps, ink: inkWidth } = cellCaps(g, clusters, cellW);
  for (let level = 0; level < levels; level++) {
    fonts.push(`${weights[level]!} ${sizes[level]!}px ${fontFamily}`);
  }

  // Drawn level by level rather than row by row.
  //
  // Every cell's font and alpha are a function of its level alone, and a
  // dithered grid alternates level between neighbours — so in row order the
  // font changed on roughly three cells in five, and assigning `ctx.font`
  // re-parses a CSS font shorthand every time. Grouping by level sets font and
  // alpha once per level: `levels` assignments instead of tens of thousands.
  //
  // The fill is deliberately *not* hoisted with them. It comes from the
  // palette's own per-cell output, which is not a function of `mod` and in
  // colour mode genuinely differs cell to cell. Leaving it under its existing
  // guard keeps that correct, and grouping makes the guard effective anyway:
  // cells sharing a level usually share a colour too.
  //
  // Within a level the original row-major order is preserved, so only the
  // order *between* levels changes — see the note on overlap below.
  const counts = new Int32Array(levels);
  const cellLevel = new Int16Array(w * h).fill(-1);
  let drawn = 0;
  for (let cell = 0; cell < cellLevel.length; cell++) {
    const which = cells[cell]!;
    if (which < 0) continue;
    const cluster = clusters[which];
    if (!cluster || cluster.trim() === "") continue;

    // The palette's alpha already encodes the cutout, so a cut cell simply
    // has nothing to draw.
    if (pixels[cell * 4 + 3] === 0) continue;

    const level = Math.min(mod[cell]!, levels - 1);
    if (alphas[level]! <= 0.01) continue;

    cellLevel[cell] = level;
    counts[level]!++;
    drawn++;
  }

  // Counting sort: cells ordered by level, and inside a level still in the
  // order the rows would have visited them.
  const start = new Int32Array(levels + 1);
  for (let level = 0; level < levels; level++) start[level + 1] = start[level]! + counts[level]!;
  const cursor = start.slice(0, levels);
  const order = new Int32Array(drawn);
  for (let cell = 0; cell < cellLevel.length; cell++) {
    const level = cellLevel[cell]!;
    if (level >= 0) order[cursor[level]!++] = cell;
  }

  let currentFill = "";
  for (let level = 0; level < levels; level++) {
    const from = start[level]!;
    const to = start[level + 1]!;
    if (from === to) continue;

    g.font = fonts[level]!;
    g.globalAlpha = alphas[level]!;
    // Ink scales with the level's font size, so the room a glyph has to move
    // does too — a light, small glyph can slide further than a heavy one.
    // Measured at level 0 and scaled rather than re-measured per level: level 0
    // is the largest and heaviest, so scaling down only ever over-states the
    // ink, and an over-stated width errs towards not moving.
    const inkScale = sizes[level]! / sizes[0]!;

    for (let i = from; i < to; i++) {
      const cell = order[i]!;
      const x = cell % w;
      const y = (cell - x) / w;
      const p = cell * 4;

      const shown = offPaper(
        { r: pixels[p]!, g: pixels[p + 1]!, b: pixels[p + 2]! },
        paper,
        ink,
      );
      const fill = `rgb(${Math.round(shown.r)} ${Math.round(shown.g)} ${Math.round(shown.b)})`;
      if (fill !== currentFill) {
        g.fillStyle = fill;
        currentFill = fill;
      }
      // A word break opens a *fraction* of a cell, not a whole one: whitespace
      // takes no cell at all, and spending one on a space left the grid looking
      // full of holes. The glyph ending a word slides left and the one starting
      // the next slides right, so the gap appears between them.
      //
      // Clamped to the room the glyph actually has. Keeping the glyph's
      // *centre* inside its cell is not enough — its ink is what collides, and
      // at the default gap the slide is a fifth of a cell while a Devanagari
      // cluster already fills nine tenths of one. The shift went straight into
      // the neighbour, so opening a gap between two words closed one inside a
      // word, which is where the overlapping letters came from.
      const which = cells[cell]!;
      // Clamped so the glyph stays inside its own cell.
      //
      // Keeping its *centre* in the cell is not enough — its ink is what
      // collides, and at the default gap the slide is a fifth of a cell while a
      // Devanagari cluster already fills nine tenths of one, so the shift went
      // straight into the neighbour. Opening a gap between two words closed one
      // inside a word, which is where the overlapping letters came from.
      //
      // Bounded by this glyph's own margin rather than by the space between it
      // and its neighbour, even though the neighbour's margin is real room. The
      // shader draws each glyph from its own slot on the atlas sheet and cannot
      // reach past it, so "a glyph never leaves its cell" is the one rule both
      // paths can hold to — worth more than the extra sliver of gap the Canvas
      // path could have taken on its own.
      const room = Math.max(0, (cellW - inkWidth[which]! * inkScale) / 2);
      const wanted = wordNudge(cells, wordEnds, w, cell, gap) * cellW;
      const shift = wanted > room ? room : wanted < -room ? -room : wanted;
      const cx = (x + 0.5) * cellW + shift;
      const cy = (y + BASELINE) * cellH;
      g.fillText(clusters[which]!, cx, cy, caps[which]!);
    }
  }
  g.globalAlpha = 1;
  if (blur > 0) compositeGlow(ctx, blur, emits(ink, paper));
}

/**
 * The grid as text, joined with newlines.
 *
 * Only ever aligns in a proportional-safe context for Latin — Devanagari
 * clusters have no common advance, so the PNG is the real artifact and this is
 * a convenience.
 */
export function gridToText(index: Uint8Array, w: number, h: number, ramp: readonly string[]): string {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) row += ramp[Math.min(index[y * w + x]!, ramp.length - 1)] ?? "";
    rows.push(row.replace(/\s+$/, ""));
  }
  return rows.join("\n");
}
