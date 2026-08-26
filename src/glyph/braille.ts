/**
 * Braille as a sub-cell dithering primitive.
 *
 * U+2800–28FF encodes a 2×4 dot matrix in the low eight bits of the codepoint,
 * so one cell carries 256 addressable patterns. That is **four times the
 * effective resolution** of an ordinary character cell — each cell is itself a
 * little dither, not a glyph chosen from a pool.
 *
 * This is deliberately not a glyph ramp. It never measures density, never
 * builds a ladder, and never consults a font. It is a separate render path that
 * consumes the ordinary dither at a finer grid and packs the result.
 */

/**
 * Dot bit by (column, row), written out rather than computed.
 *
 * Dots 1–6 are a 2×**3** block; 7 and 8 were appended to the standard
 * afterwards. So a 2×4 column-major derivation with a stride of 4 — the obvious
 * one — gives column 0 as 01 02 04 08 and column 1 as 10 20 40 80, and agrees
 * with the truth in only **four of eight positions**. The whole second column
 * is shifted by one bit, not merely the bottom row.
 *
 * Anchor any test against Unicode codepoints rather than against this table: a
 * round trip through our own mapping is a bijection by construction and proves
 * nothing about whether the mapping is the right one.
 */
export const DOT_BITS: readonly (readonly number[])[] = [
  // column 0: rows 0–3
  [0x01, 0x02, 0x04, 0x40],
  // column 1: rows 0–3
  [0x08, 0x10, 0x20, 0x80],
];

export const BRAILLE_BASE = 0x2800;
export const CELL_COLS = 2;
export const CELL_ROWS = 4;

/** The character for a dot mask. `0` is U+2800, the blank braille cell. */
export function brailleChar(mask: number): string {
  return String.fromCodePoint(BRAILLE_BASE + (mask & 0xff));
}

/** The mask a braille character encodes, or -1 if it is not braille. */
export function brailleMask(char: string): number {
  const code = char.codePointAt(0);
  if (code === undefined || code < BRAILLE_BASE || code > BRAILLE_BASE + 0xff) return -1;
  return code - BRAILLE_BASE;
}

/**
 * Pack a dithered sub-grid into one mask per cell.
 *
 * `index` holds level indices over a grid of `cols * 2` by `rows * 4`. Index 0
 * is the darkest level, so it is ink and raises a dot.
 *
 * Packing happens strictly after dithering. Doing it during would confine error
 * diffusion inside each cell, and the boundaries would show as a grid.
 */
export function packBraille(index: Uint8Array, cols: number, rows: number): Uint8Array {
  const subW = cols * CELL_COLS;
  const needed = subW * rows * CELL_ROWS;
  if (index.length < needed) {
    throw new Error(`sub-grid holds ${index.length} samples, need ${needed}`);
  }

  const masks = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let mask = 0;
      for (let col = 0; col < CELL_COLS; col++) {
        for (let row = 0; row < CELL_ROWS; row++) {
          const x = cx * CELL_COLS + col;
          const y = cy * CELL_ROWS + row;
          if (index[y * subW + x] === 0) mask |= DOT_BITS[col]![row]!;
        }
      }
      masks[cy * cols + cx] = mask;
    }
  }
  return masks;
}

/** The grid as braille text, which encodes the same image the dots draw. */
export function masksToText(masks: Uint8Array, cols: number, rows: number): string {
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = "";
    for (let x = 0; x < cols; x++) line += brailleChar(masks[y * cols + x]!);
    lines.push(line);
  }
  return lines.join("\n");
}
