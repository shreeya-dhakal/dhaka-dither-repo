/**
 * Akshara splitting — orthographic syllables, not grapheme clusters.
 *
 * Pulled forward from Phase 2 because Bharati Braille maps *aksharas* to cells,
 * not clusters. It is self-contained and testable, so bringing it early costs
 * nothing and the Phase 2 lyric timing will find it already done.
 *
 * The rule: an akshara is a consonant, plus any virama-joined consonants that
 * follow it, plus its vowel sign and any trailing nasal or visarga marks. A
 * cluster ending in a virama does not stand alone — it binds to the next.
 *
 * So तिमी is 2 aksharas (ति · मी) and क्षितिज is 3 (क्षि · ति · ज), even where
 * naive segmentation would say otherwise.
 */

import { segment } from "./segment.ts";

const VIRAMA = "्";
const DEVANAGARI = /[ऀ-ॿ]/;

/** Marks that hang off the preceding akshara rather than starting a new one. */
const TRAILING = new Set([
  "ँ", // chandrabindu
  "ं", // anusvara
  "ः", // visarga
  "़", // nukta
  "॑",
  "॒", // vedic accents
]);

function isDevanagari(cluster: string): boolean {
  return DEVANAGARI.test(cluster);
}

/**
 * Latin has no aksharas, so it falls back to a word split — no hyphenation, no
 * syllabification, just the runs between spaces.
 */
function isSpace(cluster: string): boolean {
  return cluster.trim() === "";
}

export function akshara(text: string): string[] {
  const clusters = segment(text);
  const out: string[] = [];
  let pending = "";

  const flush = () => {
    if (pending !== "") out.push(pending);
    pending = "";
  };

  for (const cluster of clusters) {
    if (isSpace(cluster)) {
      flush();
      continue;
    }

    if (!isDevanagari(cluster)) {
      // Latin and everything else: accumulate until whitespace breaks it.
      pending += cluster;
      continue;
    }

    // A Devanagari cluster cannot join a Latin run that is still open.
    if (pending !== "" && !isDevanagari(pending)) flush();

    if (TRAILING.has(cluster)) {
      // A bare combining mark belongs to whatever came before it.
      if (pending === "" && out.length > 0) out[out.length - 1] += cluster;
      else pending += cluster;
      continue;
    }

    // The previous cluster ended in a virama, so it was waiting for this one.
    if (pending.endsWith(VIRAMA)) {
      pending += cluster;
      if (!pending.endsWith(VIRAMA)) flush();
      continue;
    }

    flush();
    pending = cluster;
    // A cluster that ends in a virama is not finished; it binds to the next.
    if (!pending.endsWith(VIRAMA)) flush();
  }

  flush();
  return out;
}
