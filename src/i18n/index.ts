/**
 * Message lookup and numerals.
 *
 * Not a barrel — the catalog is imported directly by anyone who needs it. This
 * holds the behaviour: how a message resolves and how a number is rendered.
 *
 * The interface is English only. What the app *renders* is unaffected: it
 * dithers Devanagari and Ranjana exactly as before, and the seed text in the
 * text box is Devanagari on purpose, because that is a demonstration of the
 * tool rather than a label on it.
 */

import { en, type MessageKey } from "./en.ts";

export type { MessageKey };

/**
 * Latin digits, through `Intl` rather than `String(n)`.
 *
 * It survives the catalog being one language: grouping and decimal separators
 * are still a formatting decision, and routing every number through one place
 * is what stopped a raw `String(n)` appearing beside a formatted one.
 */
const NUMERALS = new Intl.NumberFormat("en", { numberingSystem: "latn" });

export function num(value: number): string {
  return NUMERALS.format(value);
}

/**
 * Named slots only. `t("export.scaleOriginal", { n: 2 })` — never
 * `t("export.scale") + n`. A sentence assembled from fragments is hard to read
 * and impossible to re-word in one place, which is the whole point of the
 * catalog. Numbers passed as slots are formatted on the way in.
 */
export function t(key: MessageKey, slots?: Record<string, string | number>): string {
  const message = en[key];
  if (!slots) return message;
  return message.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
    const value = slots[name];
    if (value === undefined) return whole;
    return typeof value === "number" ? num(value) : value;
  });
}
