/**
 * Cell grid and flow layout.
 *
 * Flow mode runs the text in reading order across the grid — left to right,
 * top to bottom — and lets luminance decide *how* each cluster is drawn rather
 * than which one it is. That means the layout is a pure function of the text
 * and the grid: no luminance in here at all.
 *
 * The result is one cluster index per cell, which is exactly the per-cell
 * buffer the GPU path uploads as a data texture at step 10. Computing it on the
 * CPU is not a compromise — wrapping is sequential and cannot be derived
 * per-fragment.
 */

import type { Token } from "./segment.ts";

/** No cluster in this cell. */
export const EMPTY = -1;

export interface FlowOptions {
  /** Advance to the next row rather than splitting a word across the wrap. */
  keepWords: boolean;
  /** `repeat` tiles the text until the grid is full; `stretch` lays it out exactly once. */
  fit: "repeat" | "stretch";
}

export interface FlowLayout {
  /** `w * h` indices into `clusters`, or `EMPTY`. */
  cells: Int32Array;
  /** Every cluster in reading order, flattened from the tokens. */
  clusters: string[];
  /**
   * 1 where the cell holds the last cluster of a word, 0 elsewhere.
   *
   * Whitespace takes no cell, so without this there is nothing in the grid to
   * say where one word stops and the next starts. The painter uses it to open a
   * *fractional* gap — a cell is all-or-nothing, and a whole one is far more
   * space than a word break wants.
   */
  wordEnds: Uint8Array;
  /** Clusters the grid had no room for. Surfaced in the UI, never dropped silently. */
  truncated: number;
}

/**
 * Split `count` extra cells across `slots` gaps, as evenly as the arithmetic
 * allows — the leftover goes to the earliest gaps rather than accumulating at
 * one end.
 */
function share(count: number, slots: number): number[] {
  if (slots <= 0) return [];
  const base = Math.floor(count / slots);
  const extra = count % slots;
  return Array.from({ length: slots }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Maximal runs of non-blank clusters, as indices. Whitespace between them is a
 * word boundary, which is where padding belongs.
 */
function inkRuns(clusters: readonly string[]): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < clusters.length; i++) {
    if (clusters[i]!.trim() === "") {
      if (current.length > 0) runs.push(current);
      current = [];
    } else {
      current.push(i);
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * `stretch` spreads the text so it spans the grid exactly once, padding the gaps
 * between clusters rather than repeating them — repeating each character to
 * fill space would read as a stutter, not as stretched text. If the text is
 * longer than the grid it is truncated, because the alternative is shrinking
 * text the user asked to be laid out once.
 */
export function layoutFlow(
  tokens: readonly Token[],
  w: number,
  h: number,
  options: FlowOptions,
): FlowLayout {
  const cells = new Int32Array(w * h).fill(EMPTY);
  const wordEnds = new Uint8Array(w * h);
  const clusters: string[] = [];
  for (const token of tokens) clusters.push(...token.clusters);

  const total = w * h;
  if (total === 0 || clusters.length === 0) return { cells, clusters, wordEnds, truncated: 0 };

  if (options.fit === "stretch") {
    const runs = inkRuns(clusters);
    const ink = runs.reduce((sum, run) => sum + run.length, 0);
    if (ink === 0) return { cells, clusters, wordEnds, truncated: 0 };

    // No room to spread: place what fits and report the rest.
    if (ink >= total) {
      const flat = runs.flat();
      for (let k = 0; k < total; k++) cells[k] = flat[k]!;
      return { cells, clusters, wordEnds, truncated: ink - total };
    }

    const slack = total - ink;
    // Padding goes between words first. Spreading it evenly across every
    // cluster would pull letters apart inside words, which destroys the
    // legibility flow mode exists for. Only a single unbroken run — nowhere
    // else to put it — falls back to gaps inside the word.
    const gaps =
      runs.length > 1 ? share(slack, runs.length - 1) : share(slack, Math.max(1, runs[0]!.length - 1));

    let cell = 0;
    if (runs.length > 1) {
      runs.forEach((run, r) => {
        for (const index of run) cells[cell++] = index;
        if (r < runs.length - 1) cell += gaps[r]!;
      });
    } else {
      const run = runs[0]!;
      run.forEach((index, i) => {
        cells[cell++] = index;
        if (i < run.length - 1) cell += gaps[i]!;
      });
    }
    return { cells, clusters, wordEnds, truncated: 0 };
  }

  // repeat: walk the tokens, wrapping, until every cell is considered.
  let cell = 0;
  let cursor = 0; // index into `clusters`, rebuilt per token below
  const offsets: number[] = [];
  let running = 0;
  for (const token of tokens) {
    offsets.push(running);
    running += token.clusters.length;
  }

  let guard = 0;
  while (cell < total && guard++ < total * 4) {
    for (let t = 0; t < tokens.length && cell < total; t++) {
      const token = tokens[t]!;
      const length = token.clusters.length;
      if (length === 0) continue;
      const blankToken = token.clusters.every((cluster) => cluster.trim() === "");
      cursor = offsets[t]!;

      const column = cell % w;
      const remaining = w - column;

      if (options.keepWords && token.wordLike && length > remaining && length <= w) {
        // Skip to the start of the next row rather than breaking the word. A
        // word longer than a whole row still has to split, or nothing fits and
        // the loop never advances.
        cell += remaining;
        if (cell >= total) break;
      }

      // Whitespace occupies no cell at all. A space is not a mark, and on a
      // fixed lattice it costs exactly as much room as a letter — which made
      // the grid look full of holes for text that is mostly short words.
      //
      // Note this tests for blankness, not `wordLike`. The segmenter marks
      // punctuation as not word-like along with whitespace, and the earlier
      // form skipped both — so a danda or a comma was silently dropped from the
      // picture. Punctuation is ink and gets a cell like anything else.
      if (blankToken) continue;

      for (let i = 0; i < length && cell < total; i++, cell++) {
        cells[cell] = cursor + i;
        if (i === length - 1) wordEnds[cell] = 1;
      }
    }

    // No gap before the text starts over. One used to be inserted so the last
    // word of a pass could not fuse with the first of the next — but with
    // whitespace no longer taking a cell, every word already runs into its
    // neighbour, and a single blank at the seam would be the only gap in the
    // grid and read as a mistake rather than as a separator.
  }

  return { cells, clusters, wordEnds, truncated: 0 };
}

/**
 * How far the glyph in `cell` shifts sideways to open word gaps, in cells.
 *
 * Whitespace occupies no cell, so a word break has to be drawn rather than laid
 * out: the glyph ending a word moves left and the one starting the next moves
 * right, splitting `gap` between them.
 *
 * Both halves are conditional, and that is the whole substance of this
 * function. A word ending at a row's edge, or before the ragged tail
 * keep-words-whole leaves, has **nothing on its right to be separated from** —
 * shifting it there only tightens it against the letter before it, taking space
 * out of the middle of a word. Because it struck only at line ends it looked
 * like the spacing coming and going at random.
 *
 * Lives here rather than in the painter so the rule can be tested directly; the
 * shader carries a transcription of it.
 */
export function wordNudge(
  cells: Int32Array,
  wordEnds: Uint8Array,
  w: number,
  cell: number,
  gap: number,
): number {
  if (gap <= 0) return 0;
  const x = cell % w;
  let nudge = 0;
  const nextHolds = x < w - 1 && cells[cell + 1]! >= 0;
  if (wordEnds[cell] === 1 && nextHolds) nudge -= gap / 2;
  // A row never inherits the break that ended the row above it.
  if (x > 0 && wordEnds[cell - 1] === 1) nudge += gap / 2;
  return nudge;
}
