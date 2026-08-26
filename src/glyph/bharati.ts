/**
 * Bharati Braille: Devanagari letters to six-dot cells.
 *
 * **Read this before trusting the output.** The table below follows the
 * documented principle that Bharati Braille reuses the English Braille cell for
 * the corresponding sound — क takes the cell for `k`, म the cell for `m`, and
 * so on. That principle is sound and the base letters here follow it
 * consistently. What this is *not* is a verified transcription checked against
 * a braille reader, and two approximations are structural rather than
 * incidental:
 *
 * 1. **Vowel signs are dropped.** Real Bharati writes a consonant with a matra
 *    as two cells — the consonant then the vowel. One cell per akshara cannot
 *    hold that, so कि renders as क. The syllable's vowel is lost.
 * 2. **Conjuncts take their first consonant.** क्ष renders as क.
 *
 * The mode is therefore labelled approximate everywhere it surfaces, and the
 * app never claims braille-reader correctness. A tool that emits subtly wrong
 * braille while implying it is valid is worse than one that says it is
 * decorative — so this says it is decorative.
 *
 * Corrections from anyone who reads Bharati Braille are welcome and belong
 * here, in one table.
 */

/** Dot numbers to a mask, so the table below reads like the standard does. */
function dots(...numbers: number[]): number {
  return numbers.reduce((mask, dot) => mask | (1 << (dot - 1)), 0);
}

/** Independent letters. Vowel *signs* are in `MATRA` below. */
export const BHARATI: Readonly<Record<string, number>> = {
  // Independent vowels
  अ: dots(1),
  आ: dots(3, 4, 5),
  इ: dots(2, 4),
  ई: dots(3, 5),
  उ: dots(1, 3, 6),
  ऊ: dots(1, 2, 5, 6),
  ए: dots(1, 5),
  ऐ: dots(3, 4),
  ओ: dots(1, 3, 5),
  औ: dots(2, 4, 6),

  // Consonants, following the English Braille cell for the same sound
  क: dots(1, 3),
  ख: dots(4, 6),
  ग: dots(1, 2, 4, 5),
  घ: dots(1, 2, 6),
  ङ: dots(3, 4, 6),
  च: dots(1, 4),
  छ: dots(1, 6),
  ज: dots(2, 4, 5),
  झ: dots(3, 5, 6),
  ञ: dots(1, 3, 4, 6),
  ट: dots(2, 3, 4, 5),
  ठ: dots(1, 2, 3, 4, 6),
  ड: dots(1, 2, 4, 6),
  ढ: dots(1, 2, 3, 4, 5, 6),
  ण: dots(3, 4, 5, 6),
  त: dots(2, 3, 4, 5, 6),
  थ: dots(1, 4, 5, 6),
  द: dots(1, 4, 5),
  ध: dots(2, 3, 4, 6),
  न: dots(1, 3, 4, 5),
  प: dots(1, 2, 3, 4),
  फ: dots(2, 3, 5),
  ब: dots(1, 2),
  भ: dots(4, 5),
  म: dots(1, 3, 4),
  य: dots(1, 3, 4, 5, 6),
  र: dots(1, 2, 3, 5),
  ल: dots(1, 2, 3),
  व: dots(1, 2, 3, 6),
  श: dots(1, 4, 6),
  ष: dots(1, 2, 4, 5, 6),
  स: dots(2, 3, 4),
  ह: dots(1, 2, 5),
};

/**
 * Vowel signs take the cell of the vowel they write, which is how Bharati
 * spells a consonant-plus-vowel syllable across two cells.
 */
const MATRA: Readonly<Record<string, number>> = {
  "ा": BHARATI["आ"]!,
  "ि": BHARATI["इ"]!,
  "ी": BHARATI["ई"]!,
  "ु": BHARATI["उ"]!,
  "ू": BHARATI["ऊ"]!,
  "े": BHARATI["ए"]!,
  "ै": BHARATI["ऐ"]!,
  "ो": BHARATI["ओ"]!,
  "ौ": BHARATI["औ"]!,
};

/**
 * The cells for an akshara, in writing order, or null when nothing maps — in
 * which case the caller falls back to the dithered cell, so the image stays
 * continuous rather than punching a hole where the table is thin.
 *
 * A consonant with a vowel sign returns two cells. The virama is skipped rather
 * than written, which is the remaining approximation.
 */
export function bharatiCells(unit: string): number[] | null {
  const cells: number[] = [];
  let sawLetter = false;
  for (const char of unit) {
    const letter = BHARATI[char];
    if (letter !== undefined) {
      cells.push(letter);
      sawLetter = true;
      continue;
    }
    const matra = MATRA[char];
    if (matra !== undefined) cells.push(matra);
    // Virama, nukta and unmapped marks contribute no cell.
  }
  return sawLetter ? cells : null;
}

/** How much of a text this table actually covers, for the UI to report plainly. */
export function bharatiCoverage(units: readonly string[]): { mapped: number; total: number } {
  let mapped = 0;
  for (const unit of units) if (bharatiCells(unit) !== null) mapped++;
  return { mapped, total: units.length };
}
