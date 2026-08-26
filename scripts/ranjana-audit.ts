/**
 * Coverage audit for the Ranjana face.
 *
 * Reads the `cmap` straight out of the OpenType file, so it is ground truth
 * rather than an inference from rendering, and it runs offline with no browser
 * and no dependency. Re-run it whenever the font is updated:
 *
 *     npm run ranjana:audit
 *
 * **What this can and cannot see.** `cmap` maps codepoints to glyphs, so it
 * answers "is this character in the font". It says nothing about conjuncts:
 * those are GSUB ligature substitutions over sequences of covered codepoints,
 * not cmap entries of their own. Conjunct coverage has to be probed by actually
 * rendering, which `verify.html` does — this script establishes the base set
 * that such a probe is allowed to build on.
 */

import { readFileSync } from "node:fs";

const FONT = "public/fonts/nithya-ranjana-du.otf";

function readCmap(path: string): Set<number> {
  const data = readFileSync(path);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const numTables = view.getUint16(4);
  let cmapOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(...data.subarray(record, record + 4));
    if (tag === "cmap") cmapOffset = view.getUint32(record + 8);
  }
  if (cmapOffset < 0) throw new Error("no cmap table");

  // Prefer a format 12 subtable (full Unicode) over format 4 (BMP only).
  const subtableCount = view.getUint16(cmapOffset + 2);
  let best = -1;
  let bestFormat = -1;
  for (let i = 0; i < subtableCount; i++) {
    const record = cmapOffset + 4 + i * 8;
    const offset = cmapOffset + view.getUint32(record + 4);
    const format = view.getUint16(offset);
    if (format === 12 && bestFormat !== 12) {
      best = offset;
      bestFormat = 12;
    } else if (format === 4 && bestFormat < 4) {
      best = offset;
      bestFormat = 4;
    }
  }
  if (best < 0) throw new Error("no format 4 or 12 cmap subtable");

  const covered = new Set<number>();
  if (bestFormat === 12) {
    const groups = view.getUint32(best + 12);
    for (let g = 0; g < groups; g++) {
      const record = best + 16 + g * 12;
      const start = view.getUint32(record);
      const end = view.getUint32(record + 4);
      for (let cp = start; cp <= end; cp++) covered.add(cp);
    }
  } else {
    const segCount = view.getUint16(best + 6) / 2;
    const endBase = best + 14;
    const startBase = endBase + segCount * 2 + 2;
    const deltaBase = startBase + segCount * 2;
    const rangeBase = deltaBase + segCount * 2;
    for (let s = 0; s < segCount; s++) {
      const end = view.getUint16(endBase + s * 2);
      const start = view.getUint16(startBase + s * 2);
      const delta = view.getInt16(deltaBase + s * 2);
      const rangeOffset = view.getUint16(rangeBase + s * 2);
      if (start === 0xffff) continue;
      for (let cp = start; cp <= end; cp++) {
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (cp + delta) & 0xffff;
        } else {
          const at = rangeBase + s * 2 + rangeOffset + (cp - start) * 2;
          if (at + 1 >= data.byteLength) continue;
          glyph = view.getUint16(at);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) covered.add(cp);
      }
    }
  }
  return covered;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Everything a Devanagari-mapped pool might plausibly want to offer. */
const CANDIDATES: { name: string; codepoints: number[] }[] = [
  { name: "consonants", codepoints: range(0x0915, 0x0939) },
  { name: "nukta consonants", codepoints: range(0x0958, 0x095f) },
  { name: "independent vowels", codepoints: range(0x0905, 0x0914) },
  { name: "vowel signs (matras)", codepoints: range(0x093e, 0x094c) },
  { name: "virama and nukta", codepoints: [0x094d, 0x093c] },
  { name: "candrabindu / anusvara / visarga", codepoints: [0x0901, 0x0902, 0x0903] },
  { name: "digits", codepoints: range(0x0966, 0x096f) },
  { name: "danda / double danda", codepoints: [0x0964, 0x0965] },
  { name: "avagraha", codepoints: [0x093d] },
  { name: "om", codepoints: [0x0950] },
  { name: "abbreviation sign", codepoints: [0x0970] },
  { name: "vedic-era additions", codepoints: range(0x0951, 0x0954) },
];

const covered = readCmap(FONT);

console.log(`Nithya Ranjana DU — ${covered.size} codepoints in cmap\n`);

const pools: Record<string, string[]> = {};
for (const group of CANDIDATES) {
  const present = group.codepoints.filter((cp) => covered.has(cp));
  const missing = group.codepoints.filter((cp) => !covered.has(cp));
  const chars = present.map((cp) => String.fromCodePoint(cp));
  pools[group.name] = chars;

  const verdict =
    missing.length === 0
      ? "all covered"
      : `MISSING ${missing.map((cp) => `U+${cp.toString(16).toUpperCase()} ${String.fromCodePoint(cp)}`).join(", ")}`;
  console.log(`${group.name.padEnd(34)} ${String(present.length).padStart(2)}/${String(group.codepoints.length).padEnd(3)} ${verdict}`);
}

// Anything the font carries beyond the Devanagari block is worth knowing about
// before a pool claims it.
const devanagari = [...covered].filter((cp) => cp >= 0x0900 && cp <= 0x097f);
const outside = [...covered].filter((cp) => cp < 0x0900 || cp > 0x097f);
console.log(`\nDevanagari block: ${devanagari.length} of 128 codepoints`);
console.log(`Outside the block: ${outside.length} codepoints`);
console.log(
  `  ${outside
    .slice(0, 24)
    .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ")}${outside.length > 24 ? " …" : ""}`,
);

console.log(`\nVarnamala pool (letters only): ${pools["consonants"]!.length + pools["independent vowels"]!.length} glyphs`);
console.log(`  ${[...pools["independent vowels"]!, ...pools["consonants"]!].join(" ")}`);
