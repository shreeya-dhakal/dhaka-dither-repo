import { expect, test } from "vitest";
import { segment, segmentWords, uniqueClusters } from "./segment.ts";

test("Devanagari conjuncts and matras stay attached to their base", () => {
  // क् + ष is a conjunct and इ-matra rides the result: क्षि · ति · ज.
  // Seven code points, three visual characters. Splitting by code point would
  // yield a bare virama and two orphaned matras.
  expect([...("क्षितिज")].length).toBe(7);
  expect(segment("क्षितिज")).toEqual(["क्षि", "ति", "ज"]);

  // SPEC's Step 6 bullet claims 4 here. It is 3: ने · पा · ली, six code points
  // paired into three clusters. There is no reading of this word that yields
  // four grapheme clusters, so the assertion below is the correct one and the
  // spec bullet needs the number changed.
  expect([...("नेपाली")].length).toBe(6);
  expect(segment("नेपाली")).toEqual(["ने", "पा", "ली"]);

  expect(segment("तिमी")).toEqual(["ति", "मी"]);
  expect(segment("कि")).toEqual(["कि"]);
});

test("a Latin string round-trips", () => {
  expect(segment("Dhaka")).toEqual(["D", "h", "a", "k", "a"]);
  expect(segment("Dhaka").join("")).toBe("Dhaka");
});

test("mixed scripts need no special casing", () => {
  expect(segment("धाका Dhaka")).toEqual(["धा", "का", " ", "D", "h", "a", "k", "a"]);
});

test("unique clusters keep first-appearance order", () => {
  expect(uniqueClusters(segment("नेपाल नेपाली"))).toEqual(["ने", "पा", "ल", " ", "ली"]);
});

test("segmentWords segments each word by grapheme cluster", () => {
  expect(segmentWords("तिमी")[0]!.clusters).toEqual(["ति", "मी"]);
});
