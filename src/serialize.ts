/**
 * A `ParamSet` to a string and back.
 *
 * One serializer, two readers: presets and the URL both encode exactly the same
 * thing, and giving them separate encoders would mean two formats to keep in
 * step and two places for a new parameter to be forgotten.
 *
 * **Every key comes from `DEFAULT_PARAMS`, never from a hand-written list.** A
 * parameter added to `ParamSet` is carried automatically; a list here would go
 * stale silently, and the symptom — a preset that quietly drops one setting —
 * is invisible until someone notices their picture changed.
 *
 * Only what *differs* from the defaults is written. A URL is meant to be pasted
 * into a message, and a preset is meant to be read; encoding forty unchanged
 * values makes both unusable and buries the two settings that matter.
 *
 * The text and the loaded image are deliberately absent. The image never leaves
 * the machine — that is the whole premise — and a link that silently carried
 * someone's typed words into a URL would be a surprise of the worst kind. The
 * text is a separate, explicit field.
 */

import { DEFAULT_PARAMS, type ParamSet } from "./params.ts";
import type { Rgb } from "./core/palette.ts";

/** `#rrggbb`, the same form the colour inputs use, so no second convention. */
function encodeRgb({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

function decodeRgb(text: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function isRgb(value: unknown): value is Rgb {
  return typeof value === "object" && value !== null && "r" in value && "g" in value && "b" in value;
}

/**
 * The differences from default, as `key=value` pairs.
 *
 * Numbers are rounded to four decimals: a slider's value is not meaningful past
 * that, and full float expansion turns a shareable link into a wall of digits.
 */
export function encodeParams(params: ParamSet): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of Object.keys(DEFAULT_PARAMS) as (keyof ParamSet)[]) {
    const value = params[key];
    const fallback = DEFAULT_PARAMS[key];
    if (isRgb(value) && isRgb(fallback)) {
      if (value.r !== fallback.r || value.g !== fallback.g || value.b !== fallback.b) {
        out.set(key, encodeRgb(value));
      }
    } else if (typeof value === "number" && typeof fallback === "number") {
      if (value !== fallback) out.set(key, String(Math.round(value * 10000) / 10000));
    } else if (value !== fallback) {
      out.set(key, String(value));
    }
  }
  return out;
}

/**
 * Back to a partial set, skipping anything that does not parse.
 *
 * Lenient on purpose: a URL is user-editable and arrives from anywhere, and one
 * bad pair must not cost the user the other twenty. The caller feeds the result
 * through `StaticParams.update`, which clamps — so a hostile number lands in
 * range rather than being trusted here.
 */
export function decodeParams(text: string): Partial<ParamSet> {
  const source = new URLSearchParams(text.startsWith("?") || text.startsWith("#") ? text.slice(1) : text);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_PARAMS) as (keyof ParamSet)[]) {
    const raw = source.get(key);
    if (raw === null) continue;
    const fallback = DEFAULT_PARAMS[key];
    if (isRgb(fallback)) {
      const rgb = decodeRgb(raw);
      if (rgb) out[key] = rgb;
    } else if (typeof fallback === "number") {
      const n = Number(raw);
      if (Number.isFinite(n)) out[key] = n;
    } else if (typeof fallback === "boolean") {
      out[key] = raw === "true";
    } else {
      // Enums stay strings. Validating the member list here would duplicate
      // every union in `params.ts`; an unknown value falls through to the
      // renderer's own `else` branch, which is the same thing a stale preset
      // would do anyway.
      out[key] = raw;
    }
  }
  return out as Partial<ParamSet>;
}

/** A named preset: a diff from the defaults, plus the text it was made with. */
export interface Preset {
  name: string;
  params: Partial<ParamSet>;
  text: string;
}

/**
 * Presets as JSON, for a file the user can keep and share.
 *
 * Versioned so a future format change can be detected rather than silently
 * mis-read. `1` is the first, and nothing else is accepted yet.
 */
export function encodePresets(presets: readonly Preset[]): string {
  return JSON.stringify({ version: 1, presets }, null, 2);
}

export function decodePresets(json: string): Preset[] {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) throw new Error("not a preset file");
  const { version, presets } = parsed as { version?: unknown; presets?: unknown };
  if (version !== 1) throw new Error(`unknown preset format (version ${String(version)})`);
  if (!Array.isArray(presets)) throw new Error("that file carries no presets");
  return presets.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { name, params, text } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof params !== "object" || params === null) return [];
    return [{ name, params: params as Partial<ParamSet>, text: typeof text === "string" ? text : "" }];
  });
}
