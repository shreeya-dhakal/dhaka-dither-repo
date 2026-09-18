import { expect, test } from "vitest";
import { EMPTY, layoutFlow, layoutProportional, wordNudge } from "./layout.ts";
import { segmentWords } from "./segment.ts";

/** The clusters a layout actually places, row by row, for readable assertions. */
function rows(text: string, w: number, h: number, keepWords: boolean, fit: "repeat" | "stretch") {
  const { cells, clusters } = layoutFlow(segmentWords(text), w, h, { keepWords, fit });
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      const index = cells[y * w + x]!;
      row += index === EMPTY ? "·" : clusters[index]!;
    }
    out.push(row);
  }
  return out;
}

test("text runs in reading order and repeats when it runs out", () => {
  // Whitespace takes no cell. A space is not a mark, and on a fixed lattice it
  // costs exactly as much room as a letter, which left the grid full of holes.
  expect(rows("ab cd", 5, 2, false, "repeat")).toEqual(["abcda", "bcdab"]);
});

test("punctuation is ink and gets a cell, unlike whitespace", () => {
  // The segmenter marks punctuation as not word-like along with whitespace, and
  // skipping on that flag dropped dandas and commas out of the picture
  // entirely. Blankness is the test, not word-likeness.
  expect(rows("ab, cd", 6, 1, false, "repeat")).toEqual(["ab,cda"]);
  expect(rows("क।", 4, 1, false, "repeat")).toEqual(["क।क।"]);
});

test("keeping words whole moves a word to the next row rather than splitting it", () => {
  // "ab" fills two of four columns; "cde" needs three and only two remain, so
  // the whole word drops to row 1 and row 0 ends short.
  expect(rows("ab cde", 4, 2, true, "repeat")).toEqual(["ab··", "cde·"]);

  // Without the option the same word breaks across the wrap — the contrast is
  // the point, and an assertion that passes either way tests nothing.
  expect(rows("ab cde", 4, 2, false, "repeat")).toEqual(["abcd", "eabc"]);
});

test("a word longer than a whole row still splits, rather than hanging", () => {
  // Nothing would ever fit otherwise, and the layout would spin.
  const laid = rows("abcdefgh", 4, 2, true, "repeat");
  expect(laid.join("")).not.toContain("·");
  expect(laid[0]).toBe("abcd");
});

test("stretch lays the text out exactly once, spread across the grid", () => {
  const laid = rows("ab cd", 4, 2, false, "stretch");
  const placed = laid.join("").replace(/·/g, "");
  expect(placed).toBe("abcd");
  // First cluster at the very start, last at the very end.
  expect(laid[0]![0]).toBe("a");
  expect(laid[1]!.at(-1)).toBe("d");
});

test("stretch pads at word boundaries, never inside a word", () => {
  // Four ink clusters into eight cells. All four spare cells belong in the one
  // gap between the words: spreading them evenly would give "a·b··c·d", which
  // is no longer two readable words.
  const laid = rows("ab cd", 4, 2, false, "stretch").join("");
  expect(laid).toBe("ab····cd");
  expect(laid).not.toContain("a·b");
  expect(laid).not.toContain("c·d");
});

test("stretch pads between several words evenly", () => {
  const laid = rows("a b c", 3, 3, false, "stretch").join("");
  expect(laid.replace(/·/g, "")).toBe("abc");
  expect(laid[0]).toBe("a");
  expect(laid.at(-1)).toBe("c");
  // Three ink clusters, six spare cells, two boundaries: three each.
  expect(laid).toBe("a···b···c");
});

test("stretch falls back to within-word gaps only when there is no boundary", () => {
  // A single unbroken word has nowhere else to put the padding.
  const laid = rows("abc", 3, 2, false, "stretch").join("");
  expect(laid.replace(/·/g, "")).toBe("abc");
  expect(laid[0]).toBe("a");
  expect(laid.at(-1)).toBe("c");
});

test("stretch reports clusters the grid had no room for", () => {
  const long = layoutFlow(segmentWords("abcdefghij"), 2, 2, {
    keepWords: false,
    fit: "stretch",
  });
  expect(long.truncated).toBe(6);
  // What does fit is still placed, in order.
  expect([...long.cells].map((i) => long.clusters[i])).toEqual(["a", "b", "c", "d"]);
});

test("Devanagari wraps by cluster, never by code point", () => {
  const laid = rows("क्षितिज", 3, 1, false, "repeat");
  expect(laid[0]).toBe("क्षितिज");
  expect(laid[0]!.length).toBeGreaterThan(3); // three clusters, seven code points
});

test("an empty grid or empty text places nothing", () => {
  expect(layoutFlow(segmentWords(""), 4, 4, { keepWords: true, fit: "repeat" }).cells).toContain(
    EMPTY,
  );
  expect(layoutFlow(segmentWords("ab"), 0, 0, { keepWords: true, fit: "repeat" }).cells.length).toBe(
    0,
  );
});

test("keep-words tails stay ragged, and the final row is not special-cased", () => {
  // Characterization, not decoration: the blank tails below are the correct
  // output of the option, and a later refactor that "helpfully" fills the last
  // row — or packs the tail — has broken it rather than tidied it.
  // Five columns: "abcd" leaves one, which is not enough for "ef", so every
  // row ends short. A width where the text happens to fit exactly would prove
  // nothing about the option.
  expect(rows("abcd ef", 5, 3, true, "repeat")).toEqual(["abcd·", "ef···", "abcd·"]);

  // Every row ends short here, including the last. Nothing treats the final
  // row differently from the rest.
  for (const row of rows("abcd ef", 5, 3, true, "repeat")) expect(row).toMatch(/·$/);
});

test("stretching a single unbroken run spaces it out, by decision", () => {
  // There is no word boundary to absorb the padding, so it goes between the
  // clusters. The alternative — placing the run once and leaving the rest of
  // the frame empty — is a defensible reading of "stretch", and this test
  // exists so that swapping to it is a deliberate edit rather than a drift.
  expect(rows("abc", 5, 1, false, "stretch").join("")).toBe("a·b·c");
});

test("word ends are marked, so the painter can space words without a blank cell", () => {
  // Whitespace occupies no cell, so nothing in the grid says where a word
  // stops. These marks are what let the painter open a *fraction* of a cell at
  // a break instead of the whole one a space used to cost.
  const { cells, clusters, wordEnds } = layoutFlow(segmentWords("ab cd"), 8, 1, {
    keepWords: true,
    fit: "repeat",
  });
  const laid = [...cells].map((i) => (i < 0 ? "·" : clusters[i]!)).join("");
  expect(laid).toBe("abcdabcd");
  // A mark under the last cluster of each word, and nowhere else.
  expect([...wordEnds]).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
});

test("punctuation ends a word too, rather than being skipped", () => {
  const { wordEnds, cells, clusters } = layoutFlow(segmentWords("ab, cd"), 6, 1, {
    keepWords: true,
    fit: "repeat",
  });
  // The trailing blank is keep-words working: one column is left and "ab" will
  // not split into it.
  expect([...cells].map((i) => (i < 0 ? "·" : clusters[i]!)).join("")).toBe("ab,cd·");
  expect(wordEnds[1]).toBe(1);
  expect(wordEnds[2]).toBe(1);
});

test("a word's last glyph only shifts left when something follows it on the row", () => {
  // "ab cd" on a 5-wide row: abcd then a blank tail.
  const { cells, wordEnds } = layoutFlow(segmentWords("ab cd"), 5, 1, {
    keepWords: true,
    fit: "repeat",
  });
  expect([...cells].map((i) => (i < 0 ? "·" : "x")).join("")).toBe("xxxx·");

  // "b" ends a word and "c" follows it: the pair splits the gap.
  expect(wordNudge(cells, wordEnds, 5, 1, 0.4)).toBeCloseTo(-0.2, 10);
  expect(wordNudge(cells, wordEnds, 5, 2, 0.4)).toBeCloseTo(0.2, 10);

  // "d" ends a word at index 3 with a blank after it. Shifting it left would
  // pull it toward "c" inside its own word, which is the bug this guards.
  expect(wordEnds[3]).toBe(1);
  expect(wordNudge(cells, wordEnds, 5, 3, 0.4)).toBe(0);
});

test("a word ending at the row's edge does not shift either", () => {
  // "abcd" fills the row exactly, so its last glyph sits at the edge.
  const { cells, wordEnds } = layoutFlow(segmentWords("abcd ef"), 4, 2, {
    keepWords: true,
    fit: "repeat",
  });
  expect(wordEnds[3]).toBe(1);
  expect(wordNudge(cells, wordEnds, 4, 3, 0.4)).toBe(0);
  // And the next row does not inherit that break.
  expect(wordNudge(cells, wordEnds, 4, 4, 0.4)).toBe(0);
});

test("no gap means no movement anywhere", () => {
  const { cells, wordEnds } = layoutFlow(segmentWords("ab cd"), 5, 1, {
    keepWords: true,
    fit: "repeat",
  });
  for (let i = 0; i < cells.length; i++) {
    expect(wordNudge(cells, wordEnds, 5, i, 0)).toBe(0);
  }
});

/** A stub advance table, in cells, so the packing can be tested under Node. */
const widths: Record<string, number> = { n: 0.5, w: 1.0, " ": 0.25 };
const stub = (c: string) => widths[c] ?? 0.5;

test("a cluster takes its measured width, not a whole cell", () => {
  const laid = layoutProportional(segmentWords("nw"), 8, 2, { keepWords: false, fit: "stretch" }, stub);
  expect(laid.placements.map((p) => [p.x, p.width])).toEqual([
    [0, 0.5],
    [0.5, 1.0],
  ]);
});

test("a row holds more narrow clusters than wide ones", () => {
  // Four cells of room. Eight halves fit; four wholes fit. On a fixed lattice
  // both would be four, which is the entire reason for this layout.
  const narrow = layoutProportional(segmentWords("nnnnnnnn"), 4, 1, { keepWords: false, fit: "stretch" }, stub);
  const wide = layoutProportional(segmentWords("wwww"), 4, 1, { keepWords: false, fit: "stretch" }, stub);
  expect(narrow.placements.length).toBe(8);
  expect(wide.placements.length).toBe(4);
});

test("wrapping happens on measured width, not on a column count", () => {
  // Three wholes need 3.0 of a 2.5-wide row, so the third drops.
  const laid = layoutProportional(segmentWords("www"), 2.5, 2, { keepWords: false, fit: "stretch" }, stub);
  expect(laid.placements.map((p) => p.row)).toEqual([0, 0, 1]);
});

test("whitespace takes its natural width and never opens a row", () => {
  const laid = layoutProportional(segmentWords("n n"), 8, 1, { keepWords: false, fit: "stretch" }, stub);
  // 0.5 for the first, 0.25 for the space, so the second starts at 0.75 —
  // a fraction of a cell, which a lattice with no half-cells could not do.
  expect(laid.placements.map((p) => p.x)).toEqual([0, 0.75]);
  // A row never opens on a space.
  const leading = layoutProportional(segmentWords(" n"), 8, 1, { keepWords: false, fit: "stretch" }, stub);
  expect(leading.placements[0]!.x).toBe(0);
});

test("keeping words whole moves the whole word down, measured", () => {
  // Row is 3.0 wide. "nn" is 1.0 and fits; "www" is 3.0, which fits a row of
  // its own but not the 1.75 left after "nn" and its space — so it moves whole.
  // The row has to be at least as wide as the word, or keep-words correctly
  // declines to wrap and the word splits instead.
  const laid = layoutProportional(segmentWords("nn www"), 3, 2, { keepWords: true, fit: "stretch" }, stub);
  expect(laid.placements.filter((p) => p.row === 0).length).toBe(2);
  expect(laid.placements.filter((p) => p.row === 1).length).toBe(3);
});

test("a word wider than the whole row still splits rather than hanging", () => {
  const laid = layoutProportional(segmentWords("wwww"), 1.5, 4, { keepWords: true, fit: "stretch" }, stub);
  expect(laid.placements.length).toBe(4);
  expect(new Set(laid.placements.map((p) => p.row)).size).toBeGreaterThan(1);
});

test("repeat tiles until the rows run out, stretch lays it down once", () => {
  const once = layoutProportional(segmentWords("nn"), 4, 3, { keepWords: false, fit: "stretch" }, stub);
  const tiled = layoutProportional(segmentWords("nn"), 4, 3, { keepWords: false, fit: "repeat" }, stub);
  expect(once.placements.length).toBe(2);
  expect(tiled.placements.length).toBeGreaterThan(2);
  expect(tiled.placements.every((p) => p.row < 3)).toBe(true);
});

test("stretch reports what the grid had no room for", () => {
  const laid = layoutProportional(segmentWords("wwww"), 1, 2, { keepWords: false, fit: "stretch" }, stub);
  expect(laid.placements.length).toBe(2);
  expect(laid.truncated).toBe(2);
});

test("a zero or nonsense advance cannot walk the cursor backwards", () => {
  const laid = layoutProportional(segmentWords("nnn"), 4, 1, { keepWords: false, fit: "stretch" },
    () => Number.NaN);
  expect(laid.placements.every((p) => p.x === 0)).toBe(true);
  expect(laid.placements.length).toBe(3);
});
