import { expect, test } from "vitest";
import { DEFAULT_PARAMS, StaticParams, type ParamSet } from "./params.ts";
import { decodeParams, decodePresets, encodeParams, encodePresets } from "./serialize.ts";

test("an untouched set encodes to nothing at all", () => {
  expect([...encodeParams({ ...DEFAULT_PARAMS }).keys()]).toEqual([]);
});

test("only what differs is written", () => {
  const params: ParamSet = { ...DEFAULT_PARAMS, pixelSize: 9, algorithm: "atkinson" };
  const encoded = encodeParams(params);
  expect([...encoded.keys()].sort()).toEqual(["algorithm", "pixelSize"]);
  expect(encoded.get("pixelSize")).toBe("9");
});

test("a round trip restores every kind of field", () => {
  const params: ParamSet = {
    ...DEFAULT_PARAMS,
    pixelSize: 7,
    contrast: 0.42,
    algorithm: "bayer",
    outputMode: "duo",
    serpentine: false,
    cutLightest: true,
    duoDark: { r: 18, g: 52, b: 86 },
    motion: "ripple",
    hover: "flashlight",
    textFont: "ranjana",
  };
  const back = decodeParams(encodeParams(params).toString());
  for (const key of Object.keys(back) as (keyof ParamSet)[]) {
    expect(back[key], key).toEqual(params[key]);
  }
});

/**
 * The guard against the failure this file exists to prevent: a parameter added
 * to `ParamSet` and forgotten here. Keys come from `DEFAULT_PARAMS`, so this
 * passes by construction — and fails the moment someone replaces that with a
 * hand-written list.
 */
test("every parameter survives a round trip, whatever gets added later", () => {
  const params: ParamSet = { ...DEFAULT_PARAMS };
  for (const key of Object.keys(params) as (keyof ParamSet)[]) {
    const value = params[key];
    if (typeof value === "number") (params[key] as number) = value + 1;
    else if (typeof value === "boolean") (params[key] as boolean) = !value;
    else if (typeof value === "object" && value !== null && "r" in value) {
      (params[key] as { r: number; g: number; b: number }) = { r: 1, g: 2, b: 3 };
    }
  }
  const back = decodeParams(encodeParams(params).toString());
  for (const key of Object.keys(params) as (keyof ParamSet)[]) {
    if (params[key] === DEFAULT_PARAMS[key]) continue;
    expect(back[key], `${key} did not survive`).toEqual(params[key]);
  }
});

test("a hostile or broken pair costs only itself", () => {
  const back = decodeParams("pixelSize=nonsense&levels=5&duoDark=notacolour&contrast=0.3");
  expect(back.pixelSize).toBeUndefined();
  expect(back.duoDark).toBeUndefined();
  expect(back.levels).toBe(5);
  expect(back.contrast).toBe(0.3);
});

test("an out-of-range value is left for the clamp rather than trusted", () => {
  // `decodeParams` is lenient; `StaticParams.update` is what bounds it. Doing
  // the clamping in both places would mean two definitions of the range.
  const params = new StaticParams();
  params.update(decodeParams("pixelSize=99999&levels=-4"));
  const resolved = params.resolve(0);
  expect(resolved.pixelSize).toBeLessThanOrEqual(64);
  expect(resolved.levels).toBeGreaterThanOrEqual(2);
});

test("a leading ? or # is accepted, since that is how a URL hands it over", () => {
  expect(decodeParams("?levels=6").levels).toBe(6);
  expect(decodeParams("#levels=6").levels).toBe(6);
  expect(decodeParams("levels=6").levels).toBe(6);
});

test("presets round-trip with their text", () => {
  const presets = [
    { name: "one", params: { pixelSize: 3 }, text: "धाका" },
    { name: "two", params: { algorithm: "bayer" as const }, text: "" },
  ];
  expect(decodePresets(encodePresets(presets))).toEqual(presets);
});

test("a preset file from an unknown format is refused, not half-read", () => {
  expect(() => decodePresets(JSON.stringify({ version: 2, presets: [] }))).toThrow();
  expect(() => decodePresets("not json at all")).toThrow();
  expect(() => decodePresets(JSON.stringify({ version: 1 }))).toThrow();
});

test("a malformed entry is dropped without taking the file with it", () => {
  const json = JSON.stringify({
    version: 1,
    presets: [{ name: "good", params: {}, text: "" }, { name: 7 }, null, "nope"],
  });
  expect(decodePresets(json).map((p) => p.name)).toEqual(["good"]);
});
