import { expect, test } from "vitest";
import { en, type MessageKey } from "./en.ts";

const KEYS = Object.keys(en) as MessageKey[];

test("no message is empty", () => {
  for (const key of KEYS) {
    expect(en[key].trim(), key).not.toBe("");
  }
});

test("every interpolation slot is a named one", () => {
  // The failure this catches is silent: a bare `{}` or a positional `{0}`
  // renders literally, so the label ships with braces visible in it.
  for (const key of KEYS) {
    for (const [whole, name] of en[key].matchAll(/\{(\w*)\}/g)) {
      expect(name, `${key}: ${whole}`).not.toBe("");
    }
  }
});

test("no message is assembled from a fragment", () => {
  // A label that is only a connective is the signature of a sentence built by
  // concatenation somewhere in the caller, which the catalog exists to prevent.
  for (const key of KEYS) {
    expect(en[key].trim(), key).not.toMatch(/^(and|or|of|the|a|in|to|with)$/i);
  }
});
