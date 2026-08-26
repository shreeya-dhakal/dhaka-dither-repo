import { expect, test } from "vitest";
import { akshara } from "./akshara.ts";

test("the two counts SPEC names", () => {
  expect(akshara("क्षितिज")).toEqual(["क्षि", "ति", "ज"]);
  expect(akshara("तिमी")).toEqual(["ति", "मी"]);
});

test("virama conjuncts bind rather than standing alone", () => {
  // क् ends in a virama, so it is not an akshara by itself — it waits for ष.
  expect(akshara("क्ष")).toEqual(["क्ष"]);
  expect(akshara("विद्या").length).toBeLessThan(akshara("विद्या").join("").length);
});

test("matras stay with their consonant", () => {
  expect(akshara("को")).toEqual(["को"]);
  expect(akshara("कि")).toEqual(["कि"]);
  expect(akshara("नेपाली")).toEqual(["ने", "पा", "ली"]);
});

test("independent vowels are aksharas in their own right", () => {
  expect(akshara("अआइई")).toEqual(["अ", "आ", "इ", "ई"]);
});

test("chandrabindu, anusvara and visarga hang off the akshara before them", () => {
  expect(akshara("हुँ")).toEqual(["हुँ"]);
  expect(akshara("अंश")).toEqual(["अं", "श"]);
  expect(akshara("दुःख")).toEqual(["दुः", "ख"]);
});

test("Latin falls back to a word split", () => {
  expect(akshara("Dhaka")).toEqual(["Dhaka"]);
  expect(akshara("the cloth")).toEqual(["the", "cloth"]);
});

test("a mixed string splits each script by its own rule", () => {
  expect(akshara("धाका Dhaka")).toEqual(["धा", "का", "Dhaka"]);
});

test("whitespace separates without becoming an akshara", () => {
  expect(akshara("क ख")).toEqual(["क", "ख"]);
  expect(akshara("   ")).toEqual([]);
  expect(akshara("")).toEqual([]);
});
