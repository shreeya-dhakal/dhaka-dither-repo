/**
 * Grapheme-cluster segmentation.
 *
 * The whole text feature rests on this. In Devanagari one visual character is
 * routinely several code points — क + ् + ष is one cluster, and a consonant
 * with a matra (कि, को) is one cluster — so `[...str]` or `.split("")` shreds
 * the text into orphaned matras and bare viramas. `Intl.Segmenter` is the only
 * correct tool here.
 *
 * No DOM: this runs in Node, and it is unit tested there.
 */

/**
 * Locale is deliberately left to the runtime's default. Grapheme boundaries are
 * defined by UAX #29 and are not locale-tailored for Devanagari, and asking for
 * `ne` specifically would be worse than useless — Chrome ships no `ne` locale
 * data at all, so the request silently falls back anyway.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function segment(text: string): string[] {
  const out: string[] = [];
  for (const { segment: cluster } of GRAPHEMES.segment(text)) out.push(cluster);
  return out;
}

/** Distinct clusters in first-appearance order — the input to density measurement. */
export function uniqueClusters(clusters: readonly string[]): string[] {
  return [...new Set(clusters)];
}

const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });

export interface Token {
  /** The token's own clusters, so flow layout never re-segments. */
  clusters: string[];
  /** False for the whitespace and punctuation runs between words. */
  wordLike: boolean;
}

/**
 * Words, for flow mode's "keep words whole" wrapping.
 *
 * Nepali does put spaces between words, so this is straightforward — but the
 * separator is not necessarily an ASCII space, which is why the segmenter does
 * the work instead of `split(" ")`. Non-word runs are kept rather than dropped:
 * the spacing between words is part of how the text reads on the grid.
 */
export function segmentWords(text: string): Token[] {
  const out: Token[] = [];
  for (const { segment: chunk, isWordLike } of WORDS.segment(text)) {
    out.push({ clusters: segment(chunk), wordLike: isWordLike === true });
  }
  return out;
}
