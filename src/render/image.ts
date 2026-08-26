/**
 * Still-image pipeline: source bitmap in, dithered canvas out.
 *
 * The order is the one in SPEC's "Core pipeline": downsample to the working
 * grid, tone per channel, luminance, dither, map indices to pixels. The core
 * functions doing the work have no idea whether they were handed a photo or a
 * video frame, which is what lets the video path reuse this untouched.
 *
 * Nothing here reads UI state. It takes a resolved `ParamSet` and renders it.
 */

import { bayerSource } from "../core/bayer.ts";
import {
  errorDiffuseInPlace,
  hardThreshold,
  maskSource,
  ordered,
  whiteNoiseSource,
  type ThresholdSource,
} from "../core/dither.ts";
import { KERNELS, type KernelId } from "../core/kernels.ts";
import { displaces, hoverSample, hoverTone, needsEdges, type HoverState } from "../core/hover.ts";
import { motionField } from "../core/motion.ts";
import {
  BUILT_IN_PALETTES,
  hueTint,
  paintColor,
  paintDuo,
  paintMono,
  paintPalette,
  paletteAt,
  type PaletteStrip,
  type Rgb,
} from "../core/palette.ts";
import { applyTone, levelStep, toLuminance } from "../core/quantize.ts";
import { akshara } from "../glyph/akshara.ts";
import { bharatiCells } from "../glyph/bharati.ts";
import { CELL_COLS, CELL_ROWS, masksToText, packBraille } from "../glyph/braille.ts";
import { measureAll } from "../glyph/density.ts";
import { layoutFlow, type FlowLayout } from "../glyph/layout.ts";
import { buildRamp } from "../glyph/ramp.ts";
import { segmentWords, uniqueClusters } from "../glyph/segment.ts";
import type { ParamSet, TextFont } from "../params.ts";
import type { TextSource } from "../text.ts";
import { colorScreens, paintHalftone } from "./halftone.ts";
import { paintBraille } from "./braille.ts";
import { gridToText, paintFlow, paintTextArt } from "./text.ts";

export const BLUE_NOISE_SIZE = 64;

/** Both stacks list both faces, so a mixed-script string never reaches a system fallback. */
export const FONT_STACK: Record<TextFont, string> = {
  devanagari: '"Noto Sans Devanagari", "IBM Plex Mono", monospace',
  mono: '"IBM Plex Mono", "Noto Sans Devanagari", monospace',
  /**
   * No Devanagari behind it, unlike the other two.
   *
   * Ranjana and Devanagari share codepoints — the bundled build maps Ranjana
   * onto the Devanagari block — so listing Noto behind it would have every
   * letter Ranjana lacks silently drawn in Devanagari letterforms instead. The
   * coverage probe would then report full coverage, because a *bundled* face
   * did draw it, and the user would get a picture made of two alphabets with
   * nothing on screen saying so. Falling through to a generic instead is what
   * lets `isSupported` drop those letters and the UI report the count.
   */
  ranjana: '"Nithya Ranjana", monospace',
};

function isKernel(algorithm: string): algorithm is KernelId {
  return algorithm in KERNELS;
}

/**
 * Every buffer the pipeline needs, reallocated only when the working grid
 * changes size. A 30fps export must not allocate typed arrays per frame.
 */
class Scratch {
  private w = 0;
  private h = 0;
  rgba = new Float32Array(0);
  /** Single-channel working buffer. Error diffusion destroys it, so it is never the source of truth. */
  channel = new Float32Array(0);
  /**
   * The previous frame's *smoothed, pre-dither* luminance, for temporal
   * smoothing. Held separately because `channel` is destroyed by error
   * diffusion — the value has to be copied on the way past, never recovered
   * afterwards.
   */
  prev = new Float32Array(0);
  /** False until a frame has been stored, so the first frame smooths against nothing. */
  hasPrev = false;
  /** Three level-index planes. Mono and duo use only the first. */
  planes: Uint8Array[] = [];
  /** Luminance levels driving flow's weight/size/opacity, separate from colour. */
  mod = new Uint8Array(0);
  /** Per-cell RGB hue for ramp mode's colour output. */
  tints = new Uint8ClampedArray(0);
  pixels = new Uint8ClampedArray(0);
  /** Wraps `pixels` by reference, so writing the array is writing the image. */
  image = new ImageData(1, 1);

  ensure(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    const count = w * h;
    this.rgba = new Float32Array(count * 4);
    this.channel = new Float32Array(count);
    this.prev = new Float32Array(count);
    this.hasPrev = false;
    this.planes = [new Uint8Array(count), new Uint8Array(count), new Uint8Array(count)];
    this.mod = new Uint8Array(count);
    this.tints = new Uint8ClampedArray(count * 3);
    this.pixels = new Uint8ClampedArray(count * 4);
    this.image = new ImageData(this.pixels, w, h);
    this.w = w;
    this.h = h;
  }
}

/**
 * `willReadFrequently` belongs on the working canvas, which is read back every
 * frame, and nowhere else — it opts into software rendering, which is a loss on
 * the target canvas that is only ever drawn to.
 */
/**
 * Every drawable reports its size under a different name. `ImageBitmap` and
 * canvases use `width`/`height`, `HTMLVideoElement` uses `videoWidth`, and
 * `VideoFrame` uses `displayWidth` and has no `width` at all — reading `.width`
 * off a frame yields `undefined`, which becomes a NaN grid and a canvas that
 * cannot be sized.
 */
export function sourceSize(source: CanvasImageSource): { w: number; h: number } {
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) {
    return { w: source.videoWidth, h: source.videoHeight };
  }
  if ("displayWidth" in source) {
    return { w: source.displayWidth, h: source.displayHeight };
  }
  if ("width" in source && typeof source.width === "number") {
    return { w: source.width, h: source.height as number };
  }
  const svg = source as SVGImageElement;
  return { w: svg.width.baseVal.value, h: svg.height.baseVal.value };
}

/**
 * The working grid a set produces for a source of this size.
 *
 * Exported because it is the answer to "will this setting look any different
 * from the last one" — a pixel-size ladder needs that to avoid saving the same
 * picture under several names, since `round(srcW / pixelSize)` lands on the same
 * grid for a run of consecutive sizes once they get coarse.
 *
 * Kept as the single definition rather than copied to the caller: two
 * transcriptions of this arithmetic would drift, and the symptom would be an
 * export silently skipping a size that really did differ.
 */
export function workingGrid(
  srcW: number,
  srcH: number,
  params: ParamSet,
): { w: number; h: number } {
  const textArt = params.text !== "off";
  const braille = params.text === "braille";
  // Braille samples a 2×4 sub-grid inside every cell, so the working grid is
  // the *sub* grid — which is exactly what gives it four times the resolution
  // of a character cell, and what lets error diffusion cross cell edges.
  if (braille) {
    return {
      w: Math.max(1, Math.round(srcW / params.pixelSize)) * CELL_COLS,
      h: Math.max(1, Math.round(srcH / (params.pixelSize * params.cellAspect))) * CELL_ROWS,
    };
  }
  return {
    w: Math.max(1, Math.round(srcW / params.pixelSize)),
    // Text cells are taller than they are wide, so the vertical resolution of
    // the working grid drops by the aspect. Without this the glyphs squash.
    h: Math.max(1, Math.round(srcH / (params.pixelSize * (textArt ? params.cellAspect : 1)))),
  };
}

function context2d(canvas: HTMLCanvasElement, readFrequently = false): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: readFrequently });
  if (!ctx) throw new Error("could not get a 2D context");
  return ctx;
}

export class StillPipeline {
  private scratch = new Scratch();
  /** Holds the image at working-grid resolution, both before and after dithering. */
  private work = document.createElement("canvas");
  private mask: Uint8Array;
  private cachedSource: ThresholdSource | null = null;
  private cacheKey = "";
  private cachedRamp: string[] | null = null;
  private rampKey = "";
  private cachedFlow: FlowLayout | null = null;
  private flowKey = "";
  /** The last text-art grid, kept so "copy as text" returns what is on screen. */
  private lastGrid: { index: Uint8Array; w: number; h: number; ramp: string[] } | null = null;
  private lastBraille: { masks: Uint8Array; cols: number; rows: number } | null = null;

  /**
   * Palette strips, bundled ones first. The user's uploads are appended, which
   * is why `paletteIndex` is clamped here at use rather than by its range: the
   * bound moves.
   */
  private strips: PaletteStrip[] = [...BUILT_IN_PALETTES];

  /** Set per render: whether the source carried any transparency at all. */
  private sourceHadAlpha = false;

  /** The blue-noise mask is loaded by the caller; core and this module never fetch. */
  constructor(mask: Uint8Array) {
    this.mask = mask;
  }

  /** Every strip on offer, for the UI to list and to count. */
  palettes(): readonly PaletteStrip[] {
    return this.strips;
  }

  /** Appends a user's strip. Returns its index, so the caller can select it. */
  addPalette(strip: PaletteStrip): number {
    this.strips.push(strip);
    return this.strips.length - 1;
  }

  /** The strip a set selects, clamped against what is actually loaded. */
  paletteFor(params: ParamSet): PaletteStrip {
    return paletteAt(this.strips, params.paletteIndex);
  }

  /**
   * Indices to pixels, for whichever output mode is live.
   *
   * Colour is the one that reads three planes; the rest read the first. Kept in
   * one place so a new mode is one branch rather than four call sites that can
   * disagree — which is how the palette mode was added.
   */
  private paint(
    planes: Uint8Array[],
    params: ParamSet,
    pixels: Uint8ClampedArray,
    single?: Uint8Array,
  ): void {
    const plane = single ?? planes[0]!;
    if (params.outputMode === "color" && !single) {
      paintColor(planes[0]!, planes[1]!, planes[2]!, params, pixels);
    } else if (params.outputMode === "palette") {
      paintPalette(plane, this.paletteFor(params).swatches, params, pixels);
    } else if (params.outputMode === "duo") {
      paintDuo(plane, params.duoDark, params.duoLight, params, pixels);
    } else {
      paintMono(plane, params, pixels);
    }
  }

  /**
   * Luminance for this frame, blended with the last one's.
   *
   * A simple exponential: `y = a·y_prev + (1 - a)·x`. Ordered dithering is
   * already stable frame to frame, but error diffusion rewrites its whole error
   * field when one pixel moves, and the output crawls — smoothing the input is
   * what takes the edge off that without pretending the kernel is stable.
   *
   * **Before quantizing, never after.** Smoothing level *indices* would blend
   * two different quantizations into a value that is not a level at all. And the
   * copy is taken here, on the way past: error diffusion mutates `channel` in
   * place, so a frame's pre-dither luminance does not exist any more once it has
   * been dithered.
   *
   * The stored value is the smoothed one, which is what makes it an exponential
   * average rather than a blend with a frame that keeps receding. The copy also
   * happens with smoothing off, so turning the control up mid-clip takes effect
   * on the next frame instead of after a stale one. Skipping it when smoothing
   * is off was measured at around 1% of the frame — below the noise, and not
   * worth a frame of latency where the control is actually used.
   */
  private luminance(rgba: Float32Array, channel: Float32Array, params: ParamSet): void {
    toLuminance(rgba, 4, channel);
    const alpha = params.temporalSmoothing;
    const scratch = this.scratch;
    if (alpha > 0 && scratch.hasPrev) {
      for (let i = 0; i < channel.length; i++) {
        channel[i] = scratch.prev[i]! * alpha + channel[i]! * (1 - alpha);
      }
    }
    scratch.prev.set(channel);
    scratch.hasPrev = true;
  }

  /**
   * `scale` multiplies the output resolution for export — 1 is preview size.
   * Dithered modes upscale the working grid with no smoothing; halftone redraws
   * its screen at the higher resolution, so its dots stay round.
   *
   * `t` is the same media-relative second the caller passed to `resolve`, and it
   * is passed explicitly rather than smuggled through `ParamSet`: the animation
   * fields are functions of position *and* time, which a flat bag of scalars
   * cannot express. Stills render at 0 unless the preview clock is running.
   */
  render(
    source: CanvasImageSource,
    params: ParamSet,
    text: TextSource,
    target: HTMLCanvasElement,
    scale = 1,
    t = 0,
  ): void {
    this.renderInto(source, params, text, target, scale, t);

    // The source's own transparency, cut back out of the finished picture.
    //
    // Applied here rather than in each painter because every path returns from
    // its own branch — halftone, braille and text art would each have needed
    // the same few lines, and the one that got missed would be the bug.
    if (!this.sourceHadAlpha) return;
    const ctx = context2d(target);
    ctx.save();
    // `destination-in` keeps the destination only where the source is opaque;
    // the source's colours play no part. Nearest, because a smoothed mask
    // feathers the edge and this tool's whole output is hard-edged.
    ctx.globalCompositeOperation = "destination-in";
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, target.width, target.height);
    ctx.restore();
  }

  private renderInto(
    source: CanvasImageSource,
    params: ParamSet,
    text: TextSource,
    target: HTMLCanvasElement,
    scale = 1,
    t = 0,
  ): void {
    const { w: srcW, h: srcH } = sourceSize(source);
    const textArt = params.text !== "off";
    const braille = params.text === "braille";
    const brailleCols = Math.max(1, Math.round(srcW / params.pixelSize));
    const brailleRows = Math.max(1, Math.round(srcH / (params.pixelSize * params.cellAspect)));
    const { w, h } = workingGrid(srcW, srcH, params);

    this.scratch.ensure(w, h);
    const { rgba, channel, planes, pixels, image, mod, tints } = this.scratch;

    // 1. Downsample to the working grid.
    this.work.width = w;
    this.work.height = h;
    const workCtx = context2d(this.work, true);
    workCtx.imageSmoothingEnabled = params.downsample === "area";
    workCtx.imageSmoothingQuality = "high";
    workCtx.clearRect(0, 0, w, h);
    workCtx.drawImage(source, 0, 0, w, h);

    const source8 = workCtx.getImageData(0, 0, w, h).data;

    // A source with transparency has RGB 0 wherever it is clear, so every
    // transparent pixel used to read as pure black: upload a logo on a
    // transparent background and the surround came back a solid black field.
    // Worse, error diffusion then bled that black into the picture's edges.
    //
    // Composited onto white first, so a clear region carries no ink and no
    // error, and the alpha is kept so the output can be cut back out at the
    // end. Un-premultiplied, which is what `getImageData` hands over.
    let clear = false;
    for (let p = 3; p < source8.length; p += 4) {
      const alpha = source8[p]!;
      if (alpha === 255) continue;
      clear = true;
      const a = alpha / 255;
      source8[p - 3] = source8[p - 3]! * a + 255 * (1 - a);
      source8[p - 2] = source8[p - 2]! * a + 255 * (1 - a);
      source8[p - 1] = source8[p - 1]! * a + 255 * (1 - a);
    }
    this.sourceHadAlpha = clear;

    // 1b. Pointer displacement, if a lens-family effect is live. Done here
    // rather than at paint time because it must move what gets *dithered* —
    // warping the finished picture instead would drag the dither pattern along
    // with the image and smear it.
    const hover: HoverState = {
      id: params.hover,
      u: params.pointerU,
      v: params.pointerV,
      radius: params.hoverRadius,
      strength: params.hoverStrength,
      aspect: w / h,
    };
    if (displaces(hover.id) && hover.strength > 0) {
      for (let y = 0, p = 0; y < h; y++) {
        const v = (y + 0.5) / h;
        for (let x = 0; x < w; x++, p += 4) {
          const from = hoverSample(hover, (x + 0.5) / w, v);
          // Bilinear, so a lens does not come out stair-stepped. Clamped at the
          // edges rather than wrapped: a magnifier near the border must not
          // pull in the far side of the picture.
          const sx = Math.min(w - 1, Math.max(0, from.u * w - 0.5));
          const sy = Math.min(h - 1, Math.max(0, from.v * h - 0.5));
          const x0 = Math.floor(sx);
          const y0 = Math.floor(sy);
          const x1 = Math.min(w - 1, x0 + 1);
          const y1 = Math.min(h - 1, y0 + 1);
          const fx = sx - x0;
          const fy = sy - y0;
          for (let c = 0; c < 4; c++) {
            const a = source8[(y0 * w + x0) * 4 + c]!;
            const b = source8[(y0 * w + x1) * 4 + c]!;
            const d = source8[(y1 * w + x0) * 4 + c]!;
            const e = source8[(y1 * w + x1) * 4 + c]!;
            rgba[p + c] = (a + (b - a) * fx) + ((d + (e - d) * fx) - (a + (b - a) * fx)) * fy;
          }
        }
      }
    } else {
      for (let i = 0; i < rgba.length; i++) rgba[i] = source8[i]!;
    }

    // 2. Tone, RGB only — stride 4 so alpha survives for the cutout.
    applyTone(
      rgba,
      {
        brightness: params.brightness,
        contrast: params.contrast,
        gamma: params.gamma,
        invert: params.invert >= 0.5,
      },
      4,
    );

    // 2b. Pointer tone — Flashlight and Neon — in the same place and units as
    // the animation field below. Neon needs the local gradient first, taken
    // from the toned luminance so it follows what is actually on screen rather
    // than what the source happened to contain.
    if (hover.id !== "none" && hover.strength > 0 && !displaces(hover.id)) {
      let edges: Float32Array | null = null;
      if (needsEdges(hover.id)) {
        edges = new Float32Array(w * h);
        const lum = (x: number, y: number) => {
          const p = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
          return 0.2126 * rgba[p]! + 0.7152 * rgba[p + 1]! + 0.0722 * rgba[p + 2]!;
        };
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            // Plain central difference. A Sobel would be smoother, but this is
            // a glow's input, not an edge map anyone measures.
            const gx = lum(x + 1, y) - lum(x - 1, y);
            const gy = lum(x, y + 1) - lum(x, y - 1);
            edges[y * w + x] = Math.min(1, Math.hypot(gx, gy) / 255);
          }
        }
      }
      for (let y = 0, p = 0; y < h; y++) {
        const v = (y + 0.5) / h;
        for (let x = 0; x < w; x++, p += 4) {
          const shift = hoverTone(hover, (x + 0.5) / w, v, edges ? edges[y * w + x]! : 0) * 255;
          if (shift === 0) continue;
          rgba[p] = Math.min(255, Math.max(0, rgba[p]! + shift));
          rgba[p + 1] = Math.min(255, Math.max(0, rgba[p + 1]! + shift));
          rgba[p + 2] = Math.min(255, Math.max(0, rgba[p + 2]! + shift));
        }
      }
    }

    // 2c. The animation field, in the same place and the same units as
    // brightness — it *is* a brightness, just one that varies with position and
    // time. Applying it here rather than at the threshold means it reaches
    // error diffusion, halftone, braille and text art without any of them
    // knowing it exists.
    if (params.motion !== "none" && params.motionAmount > 0) {
      const field = motionField(params.motion, params.motionSpeed, w / h);
      const gain = params.motionAmount * 255;
      for (let y = 0, p = 0; y < h; y++) {
        // Cell centres, so the field is sampled where the block actually is.
        const v = (y + 0.5) / h;
        for (let x = 0; x < w; x++, p += 4) {
          const shift = field((x + 0.5) / w, v, t) * gain;
          rgba[p] = Math.min(255, Math.max(0, rgba[p]! + shift));
          rgba[p + 1] = Math.min(255, Math.max(0, rgba[p + 1]! + shift));
          rgba[p + 2] = Math.min(255, Math.max(0, rgba[p + 2]! + shift));
        }
      }
    }

    // Biasing the threshold and biasing the value are the same move, and doing
    // it here applies it to error diffusion as well as the ordered algorithms.
    const bias = params.thresholdBias * levelStep(params.levels);
    const outW = Math.max(1, Math.round(srcW * scale));
    const outH = Math.max(1, Math.round(srcH * scale));

    if (params.algorithm === "halftone") {
      if (params.outputMode === "color") {
        // Each channel's ink density gets its own turn of the same screen, so
        // the angle control rotates the whole rosette rather than going dead.
        // Bias shifts every channel, exactly as it shifts every channel of the
        // dithered colour path — RGB only, at stride, so alpha survives.
        if (bias !== 0) {
          for (let p = 0; p < rgba.length; p += 4) {
            rgba[p]! += bias;
            rgba[p + 1]! += bias;
            rgba[p + 2]! += bias;
          }
        }
        paintHalftone(colorScreens(rgba), w, h, params, target, outW, outH, scale);
        return;
      }

      // Mono and duo are the same picture: halftone owns its ink pair rather
      // than borrowing duo's, so there is one screen either way.
      this.luminance(rgba, channel, params);
      if (bias !== 0) for (let i = 0; i < channel.length; i++) channel[i]! += bias;
      paintHalftone(
        [{ values: channel, stride: 1, offset: 0, ink: params.halftoneInk, turn: 0 }],
        w,
        h,
        params,
        target,
        outW,
        outH,
        scale,
      );
      return;
    }

    if (braille) {
      this.luminance(rgba, channel, params);
      if (bias !== 0) for (let i = 0; i < channel.length; i++) channel[i]! += bias;
      // Dithered through the ordinary core pass at the sub-grid resolution:
      // every algorithm, serpentine and pattern strength stay live, and error
      // diffusion runs across the whole sub-grid rather than per cell. Packing
      // happens strictly afterwards, or the cell edges would show as a grid.
      this.dither(channel, w, h, params, planes[0]!, 2);
      const masks = packBraille(planes[0]!, brailleCols, brailleRows);

      let weights: Float32Array | undefined;
      if (params.brailleBharati) {
        // An akshara can be several cells — कि is two — and the grid consumes
        // a run of cells without caring which syllable each came from. So the
        // aksharas are flattened into one sequence and laid across the cells.
        const sequence: (number | null)[] = [];
        for (const unit of akshara(text.at(0).clusters.join(""))) {
          const cells = bharatiCells(unit);
          if (cells === null) sequence.push(null);
          else sequence.push(...cells);
        }

        if (sequence.length > 0) {
          weights = new Float32Array(brailleCols * brailleRows);
          for (let i = 0; i < masks.length; i++) {
            const cell = sequence[i % sequence.length];
            // An unmapped akshara keeps its dithered cell, so the picture stays
            // continuous where the table is thin instead of punching holes.
            if (cell === null || cell === undefined) {
              weights[i] = 1;
              continue;
            }
            masks[i] = cell;
            // Tone rides the dot size, since the pattern is now spoken for.
            weights[i] = planes[0]![Math.min(i, planes[0]!.length - 1)]! === 0 ? 1 : 0.45;
          }
        }
      }

      this.lastBraille = { masks, cols: brailleCols, rows: brailleRows };
      this.lastGrid = null;
      paintBraille(
        masks,
        brailleCols,
        brailleRows,
        this.levelColor(params, 0),
        params.cutLightest ? null : this.levelColor(params, params.levels - 1),
        params,
        target,
        outW,
        outH,
        weights,
      );
      return;
    }

    if (textArt) {
      this.luminance(rgba, channel, params);
      if (bias !== 0) for (let i = 0; i < channel.length; i++) channel[i]! += bias;

      if (params.text === "flow") {
        // Which cluster goes where is fixed by the layout, so the cell's level
        // is free to carry colour through the ordinary palette — flow composes
        // with every output mode and disables nothing.
        this.paletteForGrid(rgba, channel, mod, planes, pixels, w, h, params, bias);
        const flow = this.flow(params, text, w, h);
        this.lastGrid = null;
        paintFlow(
          flow.cells,
          flow.wordEnds,
          flow.clusters,
          pixels,
          mod,
          params.levels,
          w,
          h,
          FONT_STACK[params.textFont],
          params,
          target,
          outW,
          outH,
          params.cutLightest ? null : this.levelColor(params, params.levels - 1),
          this.levelColor(params, 0),
        );
        return;
      }

      // Colour mode tints each glyph with its cell's hue at full strength. The
      // glyph keeps carrying the tone, so nothing is double-counted — and an
      // unsaturated cell tints to the ink, making greyscale identical to mono.
      let tintsForRamp: Uint8ClampedArray | null = null;
      if (params.outputMode === "color") {
        const ink = this.levelColor(params, 0);
        for (let i = 0, p = 0; i < mod.length; i++, p += 4) {
          const tint = hueTint(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!, ink);
          tints[i * 3] = tint.r;
          tints[i * 3 + 1] = tint.g;
          tints[i * 3 + 2] = tint.b;
        }
        tintsForRamp = tints;
      }

      const ramp = this.ramp(params, text);
      // Dither into as many levels as the ladder has rungs, so the selected
      // algorithm still shapes the tone — a hard threshold gives the plain
      // nearest-density mapping, and everything else gives a better range.
      this.dither(channel, w, h, params, planes[0]!, ramp.length);
      this.lastGrid = { index: planes[0]!, w, h, ramp };
      // Tone already lives in glyph selection, so colour must not carry it too:
      // ink and paper are the darkest and lightest levels of the output mode.
      paintTextArt(
        planes[0]!,
        w,
        h,
        ramp,
        FONT_STACK[params.textFont],
        this.levelColor(params, 0),
        params.cutLightest ? null : this.levelColor(params, params.levels - 1),
        target,
        outW,
        outH,
        tintsForRamp,
        params.glow,
      );
      return;
    }

    this.lastGrid = null;
    this.lastBraille = null;

    // 3–4. Luminance then dither, or three independent channels in color mode.
    if (params.outputMode === "color") {
      for (let c = 0; c < 3; c++) {
        for (let i = 0, p = c; i < channel.length; i++, p += 4) channel[i] = rgba[p]! + bias;
        this.dither(channel, w, h, params, planes[c]!);
      }
      this.paint(planes, params, pixels);
    } else {
      this.luminance(rgba, channel, params);
      if (bias !== 0) for (let i = 0; i < channel.length; i++) channel[i]! += bias;
      this.dither(channel, w, h, params, planes[0]!);

      // 5. Indices to pixels.
      this.paint(planes, params, pixels);
    }

    // Upscale with no smoothing: the blocks are the point.
    workCtx.putImageData(image, 0, 0);
    target.width = outW;
    target.height = outH;
    const targetCtx = context2d(target);
    targetCtx.imageSmoothingEnabled = false;
    targetCtx.clearRect(0, 0, outW, outH);
    targetCtx.drawImage(this.work, 0, 0, w, h, 0, 0, outW, outH);
  }

  /**
   * Flow layout, cached on the same terms as the ramp: text version plus
   * everything that changes where a cluster lands. Wrapping is sequential, so
   * this is CPU work by nature — step 10 uploads exactly this buffer as a data
   * texture rather than deriving it per fragment.
   */
  private flow(params: ParamSet, text: TextSource, w: number, h: number): FlowLayout {
    const key = `${text.version}:${w}:${h}:${params.flowKeepWords}:${params.flowFit}`;
    if (this.cachedFlow && key === this.flowKey) return this.cachedFlow;

    const layout = layoutFlow(
      segmentWords(text.at(0).clusters.join("")),
      w,
      h,
      {
        keepWords: params.flowKeepWords,
        fit: params.flowFit,
      },
    );
    this.cachedFlow = layout;
    this.flowKey = key;
    return layout;
  }

  /**
   * One level's colour, resolved through `palette.ts` so ramp mode's ink and
   * paper are the same colours a dithered pixel of that level would take.
   * Colour mode never reaches here — ramp disables it.
   */
  private levelColor(params: ParamSet, level: number): Rgb {
    const plane = new Uint8Array([level]);
    const out = new Uint8ClampedArray(4);
    const options = { levels: params.levels, cutLightest: false };
    if (params.outputMode === "duo") paintDuo(plane, params.duoDark, params.duoLight, options, out);
    else if (params.outputMode === "palette") {
      paintPalette(plane, this.paletteFor(params).swatches, options, out);
    } else paintMono(plane, options, out);
    return { r: out[0]!, g: out[1]!, b: out[2]! };
  }

  /**
   * Fills `pixels` with the palette's RGBA for the whole grid and `mod` with the
   * luminance level. In colour mode the two diverge: colour comes from three
   * independently dithered channels, while modulation stays on luminance so the
   * glyphs do not pulse per channel.
   */
  private paletteForGrid(
    rgba: Float32Array,
    channel: Float32Array,
    mod: Uint8Array,
    planes: Uint8Array[],
    pixels: Uint8ClampedArray,
    w: number,
    h: number,
    params: ParamSet,
    bias: number,
  ): void {
    if (params.outputMode === "color") {
      for (let c = 0; c < 3; c++) {
        for (let i = 0, p = c; i < channel.length; i++, p += 4) channel[i] = rgba[p]! + bias;
        this.dither(channel, w, h, params, planes[c]!);
      }
      this.paint(planes, params, pixels);
      this.luminance(rgba, channel, params);
      if (bias !== 0) for (let i = 0; i < channel.length; i++) channel[i]! += bias;
      this.dither(channel, w, h, params, mod);
      return;
    }

    this.luminance(rgba, channel, params);
    if (bias !== 0) for (let i = 0; i < channel.length; i++) channel[i]! += bias;
    this.dither(channel, w, h, params, mod);
    // Colour returned above, so every remaining mode paints from the single
    // luminance plane — no branch here, or one of them silently paints nothing.
    this.paint(planes, params, pixels, mod);
  }

  /** Clusters flow mode had no room for, so the UI can say so rather than drop them silently. */
  flowTruncated(): number {
    return this.cachedFlow?.truncated ?? 0;
  }

  /**
   * How much of the grid carries a glyph, 0–1. Reported neutrally: a sparse
   * frame is a legitimate result — a few readable clumps floating in white is
   * close to what concrete poetry does deliberately — so this states what the
   * user got rather than warning them their good result is wrong.
   */
  flowFill(): number {
    const flow = this.cachedFlow;
    if (!flow || flow.cells.length === 0) return 0;
    let filled = 0;
    for (const cell of flow.cells) if (cell >= 0) filled++;
    return filled / flow.cells.length;
  }

  /** The rendered grid as lines of text, or null when text art is not what is on screen. */
  gridAsText(): string | null {
    // Real U+2800 codepoints: the copied text encodes the same image the dots
    // draw, and pastes anywhere.
    if (this.lastBraille) {
      const { masks, cols, rows } = this.lastBraille;
      return masksToText(masks, cols, rows);
    }
    if (!this.lastGrid) return null;
    const { index, w, h, ramp } = this.lastGrid;
    return gridToText(index, w, h, ramp);
  }

  private dither(
    buf: Float32Array,
    w: number,
    h: number,
    params: ParamSet,
    out: Uint8Array,
    levels = params.levels,
  ): void {
    if (isKernel(params.algorithm)) {
      errorDiffuseInPlace(buf, w, h, KERNELS[params.algorithm], levels, params.serpentine, out);
      return;
    }
    ordered(buf, w, h, this.thresholdSource(params), levels, params.patternStrength, out);
  }

  /**
   * The tonal ladder, rebuilt only when the text, font, or step count changes —
   * keyed on `TextSource.version` rather than by diffing cluster arrays. In
   * Phase 1 that means on typing; in Phase 2 `LyricText` bumps it per sung line
   * and this same cache does the right thing untouched.
   */
  private ramp(params: ParamSet, text: TextSource): string[] {
    const key = `${text.version}:${params.textFont}:${params.glyphSteps}`;
    if (this.cachedRamp && key === this.rampKey) return this.cachedRamp;

    const supplied = text.at(0).clusters;
    const clusters = uniqueClusters(supplied);
    const measured = measureAll(clusters, FONT_STACK[params.textFont]);
    const ramp = buildRamp(measured, params.glyphSteps);

    this.cachedRamp = ramp;
    this.rampKey = key;
    return ramp;
  }

  /** Cached, because each of these builds a closure and the set rarely changes. */
  private thresholdSource(params: ParamSet): ThresholdSource {
    const key = `${params.algorithm}:${params.bayerSize}:${params.noiseSeed}`;
    if (this.cachedSource && key === this.cacheKey) return this.cachedSource;

    let source: ThresholdSource;
    switch (params.algorithm) {
      case "bayer":
        source = bayerSource(params.bayerSize);
        break;
      case "blue-noise":
        source = maskSource(this.mask, BLUE_NOISE_SIZE);
        break;
      case "white-noise":
        source = whiteNoiseSource(params.noiseSeed);
        break;
      default:
        source = hardThreshold;
    }

    this.cachedSource = source;
    this.cacheKey = key;
    return source;
  }
}
