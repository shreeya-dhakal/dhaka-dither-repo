import { expect, test } from "vitest";
import {
  BRAILLE_BASE,
  brailleChar,
  brailleMask,
  DOT_BITS,
  masksToText,
  packBraille,
} from "./braille.ts";

test("every one of the 256 masks round-trips", () => {
  for (let mask = 0; mask < 256; mask++) {
    expect(brailleMask(brailleChar(mask)), `mask ${mask}`).toBe(mask);
  }
  expect(brailleChar(0)).toBe("⠀");
  expect(brailleChar(0xff)).toBe("⣿");
});

test("non-braille input is rejected rather than wrapped", () => {
  expect(brailleMask("क")).toBe(-1);
  expect(brailleMask("A")).toBe(-1);
  expect(brailleMask("")).toBe(-1);
});

test("the bit table covers all eight dots exactly once", () => {
  const bits = DOT_BITS.flatMap((column) => [...column]);
  expect(bits.length).toBe(8);
  expect(new Set(bits).size).toBe(8);
  expect(bits.reduce((all, bit) => all | bit, 0)).toBe(0xff);
});

test("dot positions are anchored to Unicode, not to our own table", () => {
  // The round-trip test above is a bijection by construction: it would pass
  // just as happily on a wrong table. These four codepoints are fixed by the
  // standard, so they fail on any formula-derived mapping however it is wrong.
  // They pin the 2×3 origin and the appended pair together.
  const onlyDot = (col: number, row: number) => {
    const grid = new Uint8Array(8).fill(1);
    grid[row * 2 + col] = 0; // sub-grid is two wide for a single cell
    return brailleChar(packBraille(grid, 1, 1)[0]!);
  };

  expect(onlyDot(0, 0)).toBe("\u2801"); // dot 1, top-left
  expect(onlyDot(1, 0)).toBe("\u2808"); // dot 4, top-right
  expect(onlyDot(0, 3)).toBe("\u2840"); // dot 7, bottom-left
  expect(onlyDot(1, 3)).toBe("\u2880"); // dot 8, bottom-right
});

test("the naive derivation would fail those anchors in four of eight places", () => {
  // Dots 1–6 are a 2×3 block, so a 2×4 column-major stride of 4 shifts the
  // entire second column by one bit. It is not only the bottom row.
  const naive = [
    [0x01, 0x02, 0x04, 0x08],
    [0x10, 0x20, 0x40, 0x80],
  ];
  let agree = 0;
  for (let col = 0; col < 2; col++) {
    for (let row = 0; row < 4; row++) {
      if (naive[col]![row] === DOT_BITS[col]![row]) agree++;
    }
  }
  expect(agree).toBe(4);
  // Every position in column 1 diverges, which the (0,3) check alone misses.
  expect(DOT_BITS[1]!.every((bit, row) => bit !== naive[1]![row])).toBe(false);
  expect(DOT_BITS[1]![0]).toBe(0x08);
  expect(DOT_BITS[1]![1]).toBe(0x10);
  expect(DOT_BITS[1]![2]).toBe(0x20);
});

test("packing reads the sub-grid column-major, darkest level as ink", () => {
  // One cell, every sub-sample dark: all eight dots raised.
  expect(packBraille(new Uint8Array(8).fill(0), 1, 1)[0]).toBe(0xff);
  // Every sub-sample light: no dots.
  expect(packBraille(new Uint8Array(8).fill(1), 1, 1)[0]).toBe(0x00);

  // Only the top-left sub-sample dark. The sub-grid is 2 wide, so index 0.
  const corner = new Uint8Array(8).fill(1);
  corner[0] = 0;
  expect(packBraille(corner, 1, 1)[0]).toBe(0x01);

  // Only the bottom-right: last row, second column — the late-addition dot.
  const bottomRight = new Uint8Array(8).fill(1);
  bottomRight[7] = 0;
  expect(packBraille(bottomRight, 1, 1)[0]).toBe(0x80);
});

test("cells are packed independently across a wider grid", () => {
  // Two cells side by side: sub-grid is 4 wide, 4 tall.
  const index = new Uint8Array(16).fill(1);
  index[0] = 0; // cell 0, column 0, row 0
  index[2] = 0; // cell 1, column 0, row 0
  const masks = packBraille(index, 2, 1);
  expect([...masks]).toEqual([0x01, 0x01]);
});

test("a short sub-grid is rejected rather than read past its end", () => {
  expect(() => packBraille(new Uint8Array(4), 2, 1)).toThrow(/need 16/);
});

test("the text form encodes the same image the dots draw", () => {
  const masks = Uint8Array.from([0x01, 0xff, 0x00, 0x80]);
  const text = masksToText(masks, 2, 2);
  expect(text).toBe(`${brailleChar(0x01)}${brailleChar(0xff)}\n${brailleChar(0x00)}${brailleChar(0x80)}`);
  expect(text.codePointAt(0)).toBe(BRAILLE_BASE + 0x01);
});
