/**
 * Seam 1: parameters resolve per frame, from time.
 *
 * The renderer never reads UI state. It asks a `ParamSource` for a fully
 * resolved `ParamSet` at time `t` and renders that. Phase 1 ships
 * `StaticParams`, which ignores `t` and hands back the current UI values.
 * Phase 2 adds `ModulatedParams` behind the same interface, layering the
 * modulation matrix over a static base — and nothing downstream changes.
 *
 * `t` is seconds, float, media-relative. Stills are t = 0.
 */

import type { BayerSize } from "./core/bayer.ts";
import type { KernelId } from "./core/kernels.ts";
import type { HoverId } from "./core/hover.ts";
import type { MotionId } from "./core/motion.ts";
import type { OutputMode, Rgb } from "./core/palette.ts";

/** The bundled faces. Both are committed under `public/fonts/`; neither is fetched. */
export type TextFont = "devanagari" | "mono" | "ranjana";

/** Every algorithm the user can pick, flat, as the UI presents it. */
export type AlgorithmId =
  | KernelId
  | "bayer"
  | "blue-noise"
  | "white-noise"
  | "threshold"
  | "halftone";

/**
 * The modulatable half: every parameter that is a number on a range, which is
 * exactly the set Phase 2's routing table can target. Booleans live here too,
 * as 0/1 — `invert` is a listed modulation target, and a stepped route needs
 * somewhere to land.
 */
export interface ParamValues {
  pixelSize: number;
  levels: number;
  /** Ordered-dither threshold offset, added before quantizing. */
  thresholdBias: number;
  /** 0–2 with a detent at 1. Above 1 is overdrive: tone clips, deliberately. */
  patternStrength: number;
  brightness: number;
  contrast: number;
  gamma: number;
  /** 0 or 1. Numeric because Phase 2 routes to it. */
  invert: number;
  /** Rungs on the tonal ladder in ramp mode. Clamped to the unique-cluster count at use. */
  glyphSteps: number;
  /**
   * How strongly luminance drives each flow-mode axis, 0–1. The axis's own
   * output range (size spans 0.4×–1.0× of cell height) is fixed in layout;
   * this is how much of that range gets used.
   */
  flowWeight: number;
  flowSize: number;
  flowOpacity: number;
  /**
   * Space between words, as a fraction of a cell. Not a layout gap: whitespace
   * takes no cell, and a whole one is far more room than a word break wants, so
   * this nudges the glyphs on either side of a break apart instead.
   */
  flowWordGap: number;
  halftoneCell: number;
  halftoneAngle: number;
  /**
   * How much of the animation field reaches the tone, 0–1. At 0 the field is
   * still evaluated but contributes nothing, which is what lets the control sit
   * at rest without a second enable flag.
   */
  motionAmount: number;
  /** Scales time only, so it changes an animation's rate and never its shape. */
  motionSpeed: number;
  /**
   * Pointer position, 0–1 across the frame. Parameters rather than a DOM read,
   * so the renderer still reads no UI state and a PNG exports from the same
   * numbers that were on screen. Centre until the pointer has moved.
   */
  pointerU: number;
  pointerV: number;
  /** Reach of the pointer effect, 0–1 of the frame. */
  hoverRadius: number;
  /** 0 is the identity for every pointer effect, which is how the control rests. */
  hoverStrength: number;
  /** Blend with the previous frame's pre-dither luminance. 0 is off. */
  temporalSmoothing: number;
  /** Index into the loaded palette strip. Clamped again against the live palette count. */
  paletteIndex: number;
  /**
   * Cell height ÷ width for text art. Devanagari sits around 1.35, Latin
   * monospace around 1.9 — the grid is not square, so this changes the working
   * grid's vertical resolution, not just the painting.
   */
  cellAspect: number;
  /** Dot size as a fraction of its slot, for the braille path. */
  dotRadius: number;
  /** Pulls the dot lattice in or out about the cell centre. */
  dotSpacing: number;
  /**
   * Halo around every drawn mark, as a fraction of the cell's short side — so a
   * look survives a change of pixel size instead of dissolving at one scale and
   * swamping the grid at another.
   *
   * It is one parameter across all three glyph modes rather than three: ramp,
   * flow and braille all draw marks on the same lattice, and a per-mode glow
   * would be three controls that mean the same thing and drift apart. 0 is the
   * identity and the default, which is what lets the control rest without a
   * second enable flag — the same shape as `motionAmount` and `hoverStrength`.
   */
  glow: number;
}

/**
 * The structural half: choices, not quantities. Nothing here is a modulation
 * target — an LFO routed to "which kernel" is not a feature, it is a seizure.
 */
export interface ParamStructure {
  algorithm: AlgorithmId;
  bayerSize: BayerSize;
  serpentine: boolean;
  outputMode: OutputMode;
  cutLightest: boolean;
  /** Explicit so the GPU and CPU paths can be made to agree for the parity test. */
  downsample: "area" | "nearest";
  halftoneShape: "circle" | "square" | "line";
  /**
   * Halftone's own ink, not `duoDark`/`duoLight`. It never reaches `palette.ts`,
   * so borrowing duo's colours would mean one mode silently reading another
   * mode's state — the same lie as an inert control that looks active.
   */
  halftoneInk: Rgb;
  halftonePaper: Rgb;
  /** Which bundled face the glyphs are measured and drawn in. */
  textFont: TextFont;
  /**
   * `braille` is not a glyph pool: it dithers a 2×4 sub-grid per cell and packs
   * the result, giving four times the effective resolution of a character cell.
   */
  text: "off" | "ramp" | "flow" | "braille";
  /** Map aksharas to Bharati Braille cells instead of dithering them. Approximate. */
  brailleBharati: boolean;
  /** Advance to the next line rather than splitting a word across the wrap. */
  flowKeepWords: boolean;
  flowFit: "repeat" | "stretch";
  duoDark: Rgb;
  duoLight: Rgb;
  /**
   * Which time-varying tone field runs. `none` is the default and the identity.
   * Structure rather than a value because it selects a function, not a level —
   * the same reason `algorithm` lives here.
   */
  motion: MotionId;
  /**
   * Pointer effect. Stills only — an export has no pointer, and a control that
   * silently did nothing on video would be worse than one that says so.
   */
  hover: HoverId;
  /** Hashed with (x, y) for white noise. Fixed seed, reproducible frames. */
  noiseSeed: number;
}

export type ParamSet = ParamValues & ParamStructure;

export interface ParamSource {
  /**
   * The returned set is **borrowed**: the same object is reused on every call
   * so a 30fps export does not allocate 300 of them. It is valid only until the
   * next `resolve()`. Copy it if you need to hold it across frames.
   */
  resolve(t: number): ParamSet;
}

/**
 * `continuous` sliders freely; `stepped` snaps to whole units; `boolean` is a
 * checkbox that Phase 2 can still drive. The kind decides how a stepped
 * modulation route quantizes and how the UI renders the control.
 */
export type ParamKind = "continuous" | "stepped" | "boolean";

export interface ParamRange {
  min: number;
  max: number;
  step: number;
  kind: ParamKind;
  default: number;
}

/**
 * One table, three readers: the UI builds controls from it, `clampParam` bounds
 * a value against it, and Phase 2 clamps each target after summing routes into
 * it. Adding a modulation target later means adding a row here, not touching
 * call sites.
 */
export const PARAM_RANGES: { readonly [K in keyof ParamValues]: ParamRange } = {
  pixelSize: { min: 1, max: 64, step: 1, kind: "stepped", default: 4 },
  levels: { min: 2, max: 8, step: 1, kind: "stepped", default: 2 },
  thresholdBias: { min: -0.5, max: 0.5, step: 0.01, kind: "continuous", default: 0 },
  patternStrength: { min: 0, max: 2, step: 0.01, kind: "continuous", default: 1 },
  brightness: { min: -255, max: 255, step: 1, kind: "continuous", default: 0 },
  contrast: { min: -1, max: 1, step: 0.01, kind: "continuous", default: 0 },
  gamma: { min: 0.1, max: 4, step: 0.01, kind: "continuous", default: 1 },
  invert: { min: 0, max: 1, step: 1, kind: "boolean", default: 0 },
  glyphSteps: { min: 2, max: 20, step: 1, kind: "stepped", default: 8 },
  // Size and opacity start engaged, not at zero.
  //
  // Flow carries tone through weight, size and opacity — but two of the three
  // used to default to 0, so out of the box the only thing varying was weight,
  // which on its own is far too weak to show a picture. The image was in fact
  // being carried by the glyph *colour*, and once that stopped running all the
  // way to the paper the shape disappeared from the text altogether.
  //
  // 0 remains the fully-legible end of each axis, so these are turned down, not
  // up, by anyone who wants the words plainer than the picture.
  flowWeight: { min: 0, max: 1, step: 0.01, kind: "continuous", default: 1 },
  flowSize: { min: 0, max: 1, step: 0.01, kind: "continuous", default: 0.7 },
  flowOpacity: { min: 0, max: 1, step: 0.01, kind: "continuous", default: 0.35 },
  flowWordGap: { min: 0, max: 1, step: 0.05, kind: "continuous", default: 0.4 },
  halftoneCell: { min: 2, max: 64, step: 1, kind: "stepped", default: 8 },
  halftoneAngle: { min: 0, max: 180, step: 1, kind: "continuous", default: 45 },
  motionAmount: { min: 0, max: 1, step: 0.01, kind: "continuous", default: 0.35 },
  motionSpeed: { min: 0.1, max: 4, step: 0.05, kind: "continuous", default: 1 },
  pointerU: { min: 0, max: 1, step: 0.001, kind: "continuous", default: 0.5 },
  pointerV: { min: 0, max: 1, step: 0.001, kind: "continuous", default: 0.5 },
  hoverRadius: { min: 0.05, max: 1, step: 0.01, kind: "continuous", default: 0.3 },
  hoverStrength: { min: 0, max: 1, step: 0.01, kind: "continuous", default: 0.7 },
  temporalSmoothing: { min: 0, max: 0.95, step: 0.01, kind: "continuous", default: 0 },
  paletteIndex: { min: 0, max: 15, step: 1, kind: "stepped", default: 0 },
  cellAspect: { min: 1, max: 3, step: 0.05, kind: "continuous", default: 1.35 },
  glow: { min: 0, max: 2, step: 0.05, kind: "continuous", default: 0 },
  dotRadius: { min: 0.1, max: 1.5, step: 0.05, kind: "continuous", default: 0.85 },
  dotSpacing: { min: 0.4, max: 1.4, step: 0.05, kind: "continuous", default: 1 },
};

/** Cell aspect that suits each face. */
export const FONT_ASPECT: Record<TextFont, number> = {
  devanagari: 1.35,
  mono: 1.9,
  /**
   * Derived, not guessed, and not inherited from Devanagari either.
   *
   * Measured against the face's own covered letters at 100px, Ranjana's box
   * height over its mean advance is 2.12 where Devanagari's is 2.00 — it is
   * about 6% narrower for its height. Scaling Devanagari's known-good 1.35 by
   * that gives 1.43, snapped here to the cell-ratio control's own 0.05 step.
   * Taking 1.35 unchanged would set Ranjana in a cell too wide for it and the
   * glyphs would sit apart.
   */
  ranjana: 1.45,
};

/**
 * The cell ratio a mode and face want together.
 *
 * Braille's cell is two dots wide by four tall, so it wants 2.0 whatever face
 * is selected — the face does not draw it. Everything else follows the face.
 * One function rather than a mode-specific branch beside a font-specific one:
 * braille wanting 2.0 is the same shape of problem as a mono face wanting 1.9.
 */
export function defaultAspect(text: ParamStructure["text"], font: TextFont): number {
  return text === "braille" ? 2 : FONT_ASPECT[font];
}

export const PARAM_NAMES = Object.keys(PARAM_RANGES) as (keyof ParamValues)[];

/** Bound a value to its range, snapping to whole steps for stepped and boolean params. */
export function clampParam(name: keyof ParamValues, value: number): number {
  const range = PARAM_RANGES[name];
  const snapped =
    range.kind === "continuous" ? value : Math.round(value / range.step) * range.step;
  return snapped < range.min ? range.min : snapped > range.max ? range.max : snapped;
}

const DEFAULT_VALUES: ParamValues = Object.fromEntries(
  PARAM_NAMES.map((name) => [name, PARAM_RANGES[name].default]),
) as unknown as ParamValues;

const DEFAULT_STRUCTURE: ParamStructure = {
  // Blue noise takes over as the default once video is loaded (step 9): it is
  // position-deterministic, so it does not boil frame to frame.
  algorithm: "floyd-steinberg",
  bayerSize: 4,
  serpentine: true,
  outputMode: "mono",
  cutLightest: false,
  downsample: "area",
  halftoneShape: "circle",
  halftoneInk: { r: 0, g: 0, b: 0 },
  halftonePaper: { r: 255, g: 255, b: 255 },
  textFont: "devanagari",
  text: "off",
  brailleBharati: false,
  flowKeepWords: true,
  flowFit: "repeat",
  duoDark: { r: 0, g: 0, b: 0 },
  duoLight: { r: 255, g: 255, b: 255 },
  motion: "none",
  hover: "none",
  noiseSeed: 1,
};

export const DEFAULT_PARAMS: ParamSet = { ...DEFAULT_VALUES, ...DEFAULT_STRUCTURE };

/**
 * Phase 1's `ParamSource`: the current UI values, at every timestamp.
 *
 * Updates mutate one long-lived set in place rather than replacing it, so the
 * object handed out by `resolve` keeps the same identity for the life of the
 * source. That is what makes the borrowed-object contract safe to rely on.
 */
export class StaticParams implements ParamSource {
  private current: ParamSet;

  constructor(initial: ParamSet = { ...DEFAULT_PARAMS }) {
    this.current = initial;
  }

  resolve(_t: number): ParamSet {
    return this.current;
  }

  /** Feed from the UI. Clamped on the way in, so nothing downstream re-checks. */
  update(patch: Partial<ParamSet>): void {
    Object.assign(this.current, patch);
    for (const name of PARAM_NAMES) {
      this.current[name] = clampParam(name, this.current[name]);
    }
  }
}
