/**
 * The Devanagari letters, as a glyph pool to start from.
 *
 * Ranjana is the reason this exists: its face covers 45 of these and nothing
 * like a full keyboard's worth, so asking a user to type an alphabet they may
 * not have an input method for — in a script with no Unicode block of its own —
 * would make the face unusable in practice.
 *
 * It is an **addition** to user-supplied text and never a replacement. The pool
 * fills the text box, which the user can then edit, clear, or ignore; the
 * non-negotiable requirement is that the picture is made of *their* text, and a
 * starting point they can overwrite does not touch that.
 *
 * Ordering and membership follow `scripts/ranjana-audit.ts`, which is the
 * project's existing definition of what a pool may safely offer. The audit reads
 * the font's cmap offline; the caller filters this list against the *selected*
 * face at runtime, so the same pool works for every face rather than being a
 * table of one font's coverage frozen into the source.
 */

/** Independent vowels, U+0905–U+0914 in Unicode order. */
const VOWELS = 0x0905;
const VOWELS_END = 0x0914;

/** Consonants, U+0915–U+0939. */
const CONSONANTS = 0x0915;
const CONSONANTS_END = 0x0939;

/**
 * Vowels then consonants, the order the audit prints them in.
 *
 * The Unicode range carries five letters — ऌ ऍ ऎ ऑ ऒ — that a Nepali varnamala
 * does not recite. They are left in rather than hand-pruned: Ranjana covers
 * none of them, so coverage filtering removes them there anyway, and a
 * hand-pruned list would be one more thing to keep in step with the audit.
 */
export function varnamala(): string[] {
  const out: string[] = [];
  for (let cp = VOWELS; cp <= VOWELS_END; cp++) out.push(String.fromCodePoint(cp));
  for (let cp = CONSONANTS; cp <= CONSONANTS_END; cp++) out.push(String.fromCodePoint(cp));
  return out;
}
