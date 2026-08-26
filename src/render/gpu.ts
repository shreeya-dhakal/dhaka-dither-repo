/**
 * The WebGL2 path: pixelization, ordered dithering, quantization, palette.
 *
 * Error diffusion is absent and always will be — each pixel depends on error
 * written by pixels already visited, and fragments have no ordering. Hard rule
 * 3. The app falls back to the CPU path for those kernels rather than
 * approximating them here.
 */

import { bayerMatrix, type BayerSize } from "../core/bayer.ts";
import { MOTION_IDS } from "../core/motion.ts";
import { measureAll } from "../glyph/density.ts";
import { buildAtlas, flowToTexture, MAX_GLYPHS, rampToAtlas, type GlyphAtlas } from "../glyph/atlas.ts";
import { layoutFlow, type FlowLayout } from "../glyph/layout.ts";
import { buildRamp } from "../glyph/ramp.ts";
import { segmentWords, uniqueClusters } from "../glyph/segment.ts";
import type { ParamSet } from "../params.ts";
import type { TextSource } from "../text.ts";
import { GlSurface } from "./gl.ts";

export const BLUE_NOISE_SIZE = 64;

/** Which algorithms this path implements. Anything else belongs to the CPU. */
export function gpuSupports(algorithm: string): boolean {
  return algorithm === "bayer" || algorithm === "blue-noise" || algorithm === "threshold";
}

/**
 * What the shader needs to draw text: the atlas, and either the ramp's
 * rank-to-cell map or flow's per-cell indices.
 */
export interface TextArt {
  mode: "ramp" | "flow";
  /** Ordered darkest-first for ramp; the layout's own cluster list for flow. */
  ramp: readonly string[];
  flow?: FlowLayout;
  fontFamily: string;
  /** Bumped by `TextSource`; the atlas is rebuilt only when this changes. */
  version: number;
}

/**
 * Bayer tables are emitted as compile-time constants from `core/bayer.ts`
 * rather than typed out again or built on the GPU. One source of truth is what
 * makes parity with the CPU path a property of the code instead of a
 * coincidence between two transcriptions.
 */
function bayerGlsl(size: BayerSize): string {
  const matrix = bayerMatrix(size);
  const area = size * size;
  const values = Array.from(matrix, (rank) => ((rank + 0.5) / area - 0.5).toFixed(8));
  return `const float BAYER${size}[${area}] = float[${area}](${values.join(",")});`;
}

const FRAGMENT = (bayerSize: BayerSize) => `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uSource;
uniform sampler2D uMask;
uniform vec2 uOutput;      // output size in pixels
uniform vec2 uSource_;     // source size in pixels
uniform float uPixelSize;
uniform float uLod;        // mip level matching the block size
uniform float uLevels;
uniform float uStrength;
uniform float uBias;
uniform float uBrightness;
uniform float uContrastF;  // the factor, precomputed exactly as the CPU does
uniform float uInvGamma;
uniform int iInvert;
uniform int iAlgorithm;    // 0 bayer, 1 blue noise, 2 threshold
uniform int iOutputMode;   // 0 mono, 1 duo, 2 color
uniform int iCutLightest;
uniform int iApplyBrightness;
uniform int iApplyContrast;
uniform int iApplyGamma;
uniform vec3 uDark;
uniform vec3 uLight;

// --- animation ---
uniform int iMotion;          // index into MOTION_IDS
uniform float uMotionAmount;
uniform float uMotionSpeed;
uniform float uMotionAspect;  // width / height, so radial fields stay round
uniform float uTime;          // media-relative seconds, same t the CPU gets

// --- text art ---
uniform sampler2D uAtlas;     // one sheet of rasterized clusters
uniform sampler2D uCells;     // flow only: which atlas cell goes where
uniform sampler2D uWordEnd;   // flow only: 1 where a cell ends a word
uniform sampler2D uGlyphHalf; // half of each slot's ink width, doubled into 0..1
uniform float uAtlasGrid;     // cells across the sheet
uniform float uAtlasCell;     // a cell's side as a fraction of the sheet
uniform float uRank[32];      // ramp only: density rank -> atlas cell
uniform float uCellAspect;
uniform vec2 uGrid;           // text grid in cells
uniform int iText;            // 0 off, 1 ramp, 2 flow
uniform float uFlowSize;
uniform float uFlowOpacity;
uniform float uWordGap;
// Ramp's ink and paper, already resolved through the palette by the caller and
// normalized. Reusing uDark/uLight here would be wrong twice over: they are in
// 0–255, and in mono the ink is black regardless of what the duo pickers hold.
uniform vec3 uInk;
uniform vec3 uPaper;

out vec4 fragColor;

${bayerGlsl(bayerSize)}

float clamp255(float v) { return clamp(v, 0.0, 255.0); }

// Brightness, contrast, gamma, invert — the same order and the same clamps as
// core/quantize.ts. Each stage is skipped when it is a no-op, exactly as the
// CPU skips it, so a neutral tone leaves the sampled value untouched and the
// two paths agree bit for bit.
float tone(float v) {
  if (iApplyBrightness == 1) v = clamp255(v + uBrightness);
  if (iApplyContrast == 1) v = clamp255((v - 128.0) * uContrastF + 128.0);
  if (iApplyGamma == 1) v = clamp255(255.0 * pow(v / 255.0, uInvGamma));
  if (iInvert == 1) v = 255.0 - v;
  return v;
}

float threshold(vec2 block) {
  if (iAlgorithm == 0) {
    int n = ${bayerSize};
    int x = int(mod(block.x, float(n)));
    int y = int(mod(block.y, float(n)));
    return BAYER${bayerSize}[y * n + x];
  }
  if (iAlgorithm == 1) {
    // Position-deterministic like Bayer, so video does not boil, but without
    // the visible crosshatch. Sampled on the block, never the screen pixel.
    // Texel centres, not edges: NEAREST at an exact boundary may round either
    // way, and the CPU indexes the array directly.
    float raw = texture(uMask, (block + 0.5) / float(${BLUE_NOISE_SIZE})).r * 255.0;
    return (raw + 0.5) / 256.0 - 0.5;
  }
  return 0.0;
}

float quantIndex(float v) {
  float i = floor((v / 255.0) * (uLevels - 1.0) + 0.5);
  return clamp(i, 0.0, uLevels - 1.0);
}

// --- animation fields ---
//
// Transcribed by hand from core/motion.ts, which is the only reason this needs
// a parity check: the Bayer table is *generated* from its TS source, so the two
// paths cannot drift, and these can. verify.html compares them per mode.
//
// The integer hash is whiteNoiseSource's, done in uint so the wraparound
// matches Math.imul exactly. Float arithmetic here would agree for small
// inputs and diverge quietly for large ones. (No backticks in this comment:
// the whole shader is a template literal and one would close it.)
uint imul(uint a, uint b) { return a * b; }
float hash01(int xi, int yi, int zi) {
  uint h = imul(uint(xi), 0x27d4eb2du) ^ imul(uint(yi), 0x165667b1u) ^ imul(uint(zi), 0x9e3779b1u);
  h = imul(h ^ (h >> 15), 0x85ebca6bu);
  h = imul(h ^ (h >> 13), 0xc2b2ae35u);
  h ^= h >> 16;
  return float(h) / 4294967296.0;
}
float fract1(float x) { return x - floor(x); }

float motionAt(vec2 uv, float t) {
  if (iMotion == 0) return 0.0;
  float sp = uMotionSpeed;
  float TAU = 6.283185307179586;
  if (iMotion == 1) return sin(TAU * t * sp * 0.25);                       // breathe
  if (iMotion == 2) return exp(-5.0 * fract1(t * sp));                      // pulse
  if (iMotion == 3) return sin(TAU * (uv.x * 2.0 + uv.y * 0.6 - t * sp * 0.5)); // wave

  vec2 d = vec2((uv.x - 0.5) * uMotionAspect, uv.y - 0.5);
  float r = length(d);
  if (iMotion == 4) {                                                      // spiral
    float a = atan(d.y, d.x);
    return sin(TAU * (a / TAU * 3.0 + r * 4.0 - t * sp * 0.5));
  }
  if (iMotion == 6) return sin(TAU * (r * 6.0 - t * sp)) * exp(-r * 1.5);  // ripple

  if (iMotion == 5) {                                                      // rain
    int col = int(floor(uv.x * 48.0));
    float phase = hash01(col, 0, 1);
    float columnSpeed = 0.6 + hash01(col, 1, 2) * 0.8;
    float drop = fract1(uv.y - t * sp * columnSpeed + phase);
    return exp(-drop * 12.0);
  }
  if (iMotion == 7) {                                                      // sparkle
    int cx = int(floor(uv.x * 64.0));
    int cy = int(floor(uv.y * 64.0));
    int step = int(floor(t * sp * 6.0));
    if (hash01(cx, cy, step) < 0.92) return 0.0;
    return sin(3.141592653589793 * fract1(t * sp * 6.0));
  }
  // cellular — Worley. Closed form at any t, so it scrubs and exports like the
  // rest; a cellular *automaton* could not.
  float scale = 6.0;
  vec2 p = vec2(uv.x * scale * uMotionAspect, uv.y * scale);
  int gx = int(floor(p.x));
  int gy = int(floor(p.y));
  float nearest = 1e9;
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      int cx = gx + ox;
      int cy = gy + oy;
      float fx = float(cx) + 0.5 + 0.35 * sin(TAU * (hash01(cx, cy, 3) + t * sp * 0.2));
      float fy = float(cy) + 0.5 + 0.35 * cos(TAU * (hash01(cx, cy, 4) + t * sp * 0.2));
      nearest = min(nearest, length(vec2(fx, fy) - p));
    }
  }
  return min(1.0, nearest * 1.6) * 2.0 - 1.0;
}

// core/palette.ts hueTint, in 0-255. Ramp's tone lives in which cluster was
// chosen, so the tint must carry hue and nothing else: normalizing to full
// value strips the tone, and scaling by saturation returns the ink unchanged
// for a grey cell, which is what makes greyscale identical to mono.
vec3 hueTint(vec3 c, vec3 ink) {
  float mx = max(c.r, max(c.g, c.b));
  if (mx == 0.0) return ink;
  float mn = min(c.r, min(c.g, c.b));
  float sat = (mx - mn) / mx;
  return c * ((255.0 / mx) * sat) + ink * (1.0 - sat);
}

/**
 * The glyph's alpha at this fragment, or 0 for a blank cell.
 *
 * One texture lookup, which is the whole reason text art can run at video
 * rates: the Canvas 2D path shapes and fills every cell individually.
 */
float glyphInk(vec2 cellCoord, vec2 local, float level) {
  float slot;
  if (iText == 1) {
    // Ramp: the block's own tone picks which cluster is drawn.
    slot = uRank[int(clamp(level, 0.0, 31.0))];
  } else {
    // Flow: the layout already decided, and wrapping is sequential, so it
    // arrives as a data texture rather than being derived per fragment.
    float packed = texture(uCells, (cellCoord + 0.5) / uGrid).r * 255.0;
    slot = packed > 254.5 ? -1.0 : packed;
  }
  if (slot < 0.0) return 0.0;

  vec2 within = local;
  // How much of its cell this glyph occupies, and so how far it may move.
  // Doubled on the way in, so undo that here.
  float col0 = mod(slot, uAtlasGrid);
  float row0 = floor(slot / uAtlasGrid);
  float inkHalf = texture(uGlyphHalf, (vec2(col0, row0) + 0.5) / uAtlasGrid).r * 0.5;
  if (iText == 2 && uWordGap > 0.0) {
    // The same fractional word break the Canvas path opens: the glyph ending a
    // word slides left, the one starting the next slides right. Sampling the
    // neighbour rather than carrying a second flag, because the texture is
    // already here and a cell only needs to know about the one before it.
    float endsHere = texture(uWordEnd, (cellCoord + 0.5) / uGrid).r;
    float endsLeft = cellCoord.x < 0.5
      ? 0.0
      : texture(uWordEnd, (cellCoord + vec2(-0.5, 0.5)) / uGrid).r;
    // Only shift left when a glyph actually follows on this row: a word ending
    // at the edge, or before a ragged tail, has nothing to be separated from,
    // and shifting it there takes space out of the middle of its own word.
    float nextPacked = cellCoord.x >= uGrid.x - 1.0
      ? 255.0
      : texture(uCells, (cellCoord + vec2(1.5, 0.5)) / uGrid).r * 255.0;
    float wanted = 0.0;
    if (endsHere > 0.5 && nextPacked <= 254.5) wanted -= uWordGap * 0.5;
    wanted += (endsLeft > 0.5 ? uWordGap * 0.5 : 0.0);
    // Clamped to the room the glyph has inside its own cell, exactly as the
    // Canvas path clamps it. Unclamped the slide pushed the sample past the
    // slot: with size modulation on that tripped the guard below and cut the
    // glyph in half, and with it off the sample crossed into the next slot on
    // the sheet and drew a different letter altogether. A glyph never leaves
    // its cell on either path, which is the one rule both can hold to.
    //
    // Measured against the *displayed* half-width — the size ladder shrinks the
    // glyph, and a smaller glyph has correspondingly more room to move.
    float sized = inkHalf;
    if (uFlowSize > 0.0) {
      float d0 = 1.0 - level / max(1.0, uLevels - 1.0);
      sized = inkHalf * (1.0 - uFlowSize * 0.6 * (1.0 - d0));
    }
    float room = max(0.0, 0.5 - sized);
    within.x -= clamp(wanted, -room, room);
  }
  if (iText == 2 && uFlowSize > 0.0) {
    // Luminance modulates size within the cell rather than which glyph it is.
    float darkness = 1.0 - level / max(1.0, uLevels - 1.0);
    float scale = 1.0 - uFlowSize * 0.6 * (1.0 - darkness);
    // Applied to within, not re-read from local: reading local again discards
    // the word-gap nudge above, and since size now defaults to engaged that
    // branch always runs — so the gap did nothing at all on the GPU while
    // working perfectly on the CPU. The two compose on the Canvas path (font
    // size and draw position are independent) and must here too.
    within = (within - 0.5) / max(0.05, scale) + 0.5;
    if (within.x < 0.0 || within.x > 1.0 || within.y < 0.0 || within.y > 1.0) return 0.0;
  }

  // Scaled by the cell's real size, not by the grid count: the sheet is padded
  // up to a power of two, so those differ whenever the grid is not one.
  return texture(uAtlas, (vec2(col0, row0) + within) * uAtlasCell).a;
}

void main() {
  // Snap to the block, then sample the block's *centre* at the mip level that
  // covers it. The dither lookup uses the same snapped coordinate: computing
  // the pattern per screen pixel while the colour is per block makes the two
  // disagree and the pattern smear.
  // gl_FragCoord counts from the bottom; the CPU grid counts from the top.
  // Flipping here — rather than only when reading pixels back — keeps the
  // dither pattern, the block index and the sample all in the same space. Flip
  // only the readback and the pattern comes out mirrored against the CPU's.
  vec2 pixel = vec2(gl_FragCoord.x, uOutput.y - gl_FragCoord.y);
  // Text cells are taller than they are wide, so the vertical divisor carries
  // the aspect. Outside text mode the aspect is 1 and this is a plain grid.
  vec2 cellSize = vec2(uPixelSize, uPixelSize * uCellAspect);
  vec2 block = iText == 0 ? floor(pixel / uPixelSize) : floor(pixel / cellSize);
  vec2 uv = iText == 0
    ? (block * uPixelSize + uPixelSize * 0.5) / uSource_
    : (block * cellSize + cellSize * 0.5) / uSource_;
  vec4 src = textureLod(uSource, uv, uLod);

  vec3 rgb = vec3(tone(src.r * 255.0), tone(src.g * 255.0), tone(src.b * 255.0));
  // Sampled on the block's own centre, matching the CPU's cell-centre sample.
  if (iMotion != 0 && uMotionAmount > 0.0) {
    vec2 cell = (block + 0.5) / max(vec2(1.0), floor(uOutput / cellSize));
    rgb = clamp(rgb + motionAt(cell, uTime) * uMotionAmount * 255.0, 0.0, 255.0);
  }
  float step_ = 255.0 / (uLevels - 1.0);
  float offset = threshold(block) * step_ * uStrength + uBias;

  // Text art selects and modulates on luminance in every output mode — colour
  // mode's per-channel indices drive colour only. Reading index.r there would
  // pick the ramp's cluster off the red channel and make flow's glyphs pulse
  // per channel, neither of which is what the CPU path does.
  float luma = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  float lumaIndex = quantIndex(luma + offset);

  vec3 index;
  if (iOutputMode == 2) {
    index = vec3(quantIndex(rgb.r + offset), quantIndex(rgb.g + offset), quantIndex(rgb.b + offset));
  } else {
    index = vec3(lumaIndex);
  }

  vec3 color;
  float alpha = 1.0;
  float top = uLevels - 1.0;
  if (iOutputMode == 1) {
    float t = index.r / top;
    color = mix(uDark, uLight, t) / 255.0;
    if (iCutLightest == 1 && index.r == top) alpha = 0.0;
  } else if (iOutputMode == 2) {
    color = index * step_ / 255.0;
    if (iCutLightest == 1 && index.r == top && index.g == top && index.b == top) alpha = 0.0;
  } else {
    color = vec3(index.r * step_ / 255.0);
    if (iCutLightest == 1 && index.r == top) alpha = 0.0;
  }
  if (iText != 0) {
    vec2 local = fract(pixel / cellSize);
    float ink = glyphInk(block, local, lumaIndex);
    if (iText == 2 && uFlowOpacity > 0.0) {
      float darkness = 1.0 - lumaIndex / max(1.0, uLevels - 1.0);
      ink *= 1.0 - uFlowOpacity * (1.0 - darkness);
    }
    // The glyph is a mask: paper where there is no ink, palette colour where
    // there is. Ramp mode's colour is the ink, because the tone is already
    // carried by which cluster was chosen — in colour mode the cell's hue
    // tints that ink, taken from the unquantized block exactly as the CPU
    // path takes it from the unquantized cell.
    vec3 inkColor = color;
    if (iText == 1) inkColor = iOutputMode == 2 ? hueTint(rgb, uInk * 255.0) / 255.0 : uInk;
    vec3 paper = uPaper;
    if (iCutLightest == 1) {
      fragColor = vec4(inkColor, ink);
    } else {
      fragColor = vec4(mix(paper, inkColor, ink), 1.0);
    }
    return;
  }

  fragColor = vec4(color, alpha);
}`;

/**
 * Everything the shader needs for text, derived from the same functions the
 * Canvas 2D path uses — the ladder is measured once and both paths read it, so
 * they cannot drift into disagreeing about which glyph belongs where.
 *
 * Returns null when text is off or the atlas would overflow, which is the
 * signal to stay on the CPU.
 */
export function textArtFor(
  params: ParamSet,
  text: TextSource,
  fontFamily: string,
  cols: number,
  rows: number,
): TextArt | null {
  if (params.text === "off") return null;
  const clusters = text.at(0).clusters;
  if (!GpuPipeline.canDrawText(clusters)) return null;

  if (params.text === "flow") {
    const flow = layoutFlow(
      segmentWords(clusters.join("")),
      cols,
      rows,
      {
        keepWords: params.flowKeepWords,
        fit: params.flowFit,
      },
    );
    return { mode: "flow", ramp: [], flow, fontFamily, version: text.version };
  }

  const measured = measureAll(
    uniqueClusters(
      clusters,
    ),
    fontFamily,
  );
  return {
    mode: "ramp",
    ramp: buildRamp(measured, params.glyphSteps),
    fontFamily,
    version: text.version,
  };
}

export class GpuPipeline {
  private surface: GlSurface;
  private programs = new Map<BayerSize, WebGLProgram>();
  private mask: WebGLTexture;
  private atlas: { key: string; sheet: GlyphAtlas; texture: WebGLTexture; halfInk: WebGLTexture } | null = null;
  private cellsTexture: WebGLTexture | null = null;
  private wordEndTexture: WebGLTexture | null = null;
  private blankTexture: WebGLTexture | null = null;
  private sourceTexture: WebGLTexture | null = null;
  /** Public so the video exporter can hand the drawn surface straight to `VideoFrame`. */
  readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, mask: Uint8Array) {
    this.canvas = canvas;
    this.surface = new GlSurface(canvas);
    this.mask = this.surface.maskTexture(mask, BLUE_NOISE_SIZE);
  }

  /** Text art needs an atlas, which caps at 255 distinct clusters. */
  static canDrawText(clusters: readonly string[]): boolean {
    return new Set(clusters.filter((c) => c.trim() !== "")).size <= MAX_GLYPHS;
  }

  private program(size: BayerSize): WebGLProgram {
    let program = this.programs.get(size);
    if (!program) {
      program = this.surface.program(FRAGMENT(size));
      this.programs.set(size, program);
    }
    return program;
  }

  /**
   * Renders at source resolution. `pixelSize` blocks are produced in the
   * shader, so unlike the CPU path there is no small buffer and no upscale.
   */
  /**
   * Rebuilt only when the text, font or step count changes — never per frame.
   * That is the entire performance argument for the atlas, so the cache key is
   * as load-bearing as the sheet itself.
   */
  private glyphSheet(text: TextArt): GlyphAtlas {
    const key = `${text.version}:${text.fontFamily}:${text.mode}:${text.ramp.join("")}`;
    if (this.atlas && this.atlas.key === key) return this.atlas.sheet;

    const source = text.mode === "ramp" ? text.ramp : (text.flow?.clusters ?? []);
    const sheet = buildAtlas(source, text.fontFamily);
    if (this.atlas) {
      this.surface.gl.deleteTexture(this.atlas.texture);
      this.surface.gl.deleteTexture(this.atlas.halfInk);
    }
    // One texel per atlas slot, laid out on the same grid, so the shader
    // indexes it with the slot coordinates it has already computed. Half-ink
    // never exceeds half a cell, so it is stored doubled to use the whole byte.
    const widths = new Uint8Array(sheet.grid * sheet.grid);
    for (let i = 0; i < sheet.halfInk.length; i++) {
      widths[i] = Math.round(Math.min(1, sheet.halfInk[i]! * 2) * 255);
    }
    this.atlas = {
      key,
      sheet,
      texture: this.surface.texture(sheet.canvas, false),
      halfInk: this.surface.maskTexture(widths, sheet.grid, sheet.grid, false),
    };
    return sheet;
  }

  render(
    source: TexImageSource,
    width: number,
    height: number,
    params: ParamSet,
    text?: TextArt,
    t = 0,
  ): void {
    if (!gpuSupports(params.algorithm)) {
      throw new Error(`${params.algorithm} has no GPU path; it belongs to the CPU`);
    }
    this.canvas.width = width;
    this.canvas.height = height;

    // Held rather than rebuilt per frame — see `GlSurface.texture`.
    const texture = this.surface.texture(
      source,
      params.downsample === "area",
      false,
      this.sourceTexture,
    );
    this.sourceTexture = texture;
    const algorithm = params.algorithm === "bayer" ? 0 : params.algorithm === "blue-noise" ? 1 : 2;
    const mode = params.outputMode === "duo" ? 1 : params.outputMode === "color" ? 2 : 0;

    // A 1×1 stand-in keeps every sampler bound even when text is off; an
    // unbound sampler reads as undefined behaviour rather than as nothing.
    this.blankTexture ??= this.surface.maskTexture(new Uint8Array([255]), 1, 1, false);

    // The same colours `levelColor` gives the Canvas 2D path: mono is black on
    // white whatever the duo pickers say, duo is the pickers themselves.
    const ink = params.outputMode === "duo" ? params.duoDark : { r: 0, g: 0, b: 0 };
    const paper =
      params.outputMode === "duo" ? params.duoLight : { r: 255, g: 255, b: 255 };

    // Ramp mode quantizes into as many levels as the ladder has rungs — that is
    // what makes the glyph vary with tone. Using the ordinary tone count gives
    // two ranks across the whole frame and a uniform grid of one character.
    const levels = text?.mode === "ramp" ? Math.max(2, text.ramp.length) : params.levels;

    const aspect = text ? params.cellAspect : 1;
    const cols = Math.max(1, Math.round(width / params.pixelSize));
    const rows = Math.max(1, Math.round(height / (params.pixelSize * aspect)));

    let atlasTexture = this.blankTexture;
    let cellsTexture = this.blankTexture;
    let wordEndTexture = this.blankTexture;
    let halfInkTexture = this.blankTexture;
    let atlasGrid = 1;
    let atlasCell = 1;
    let ranks = new Float32Array(32);

    if (text) {
      const sheet = this.glyphSheet(text);
      atlasTexture = this.atlas!.texture;
      halfInkTexture = this.atlas!.halfInk;
      atlasGrid = sheet.grid;
      atlasCell = sheet.cellUV;
      if (text.mode === "ramp") {
        ranks.set(rampToAtlas(text.ramp, sheet).subarray(0, 32));
      } else if (text.flow) {
        const data = flowToTexture(text.flow.cells, text.flow.clusters, sheet);
        this.cellsTexture = this.surface.maskTexture(data, cols, rows, false, this.cellsTexture);
        cellsTexture = this.cellsTexture;
        // A second texture rather than a spare bit of the slot byte: slots run
        // to 254 and that ceiling is load-bearing.
        const ends = Uint8Array.from(text.flow.wordEnds, (v) => (v ? 255 : 0));
        this.wordEndTexture = this.surface.maskTexture(ends, cols, rows, false, this.wordEndTexture);
        wordEndTexture = this.wordEndTexture;
      }
    }

    this.surface.draw(this.program(params.bayerSize), [texture, this.mask, atlasTexture, cellsTexture, wordEndTexture, halfInkTexture], {
      uOutput: [width, height],
      uSource_: [width, height],
      uPixelSize: params.pixelSize,
      // log2 of the block size is the mip whose texels cover one block. At
      // pixelSize 1 this is 0, so the sample is the exact texel and parity with
      // the CPU path is not approximate.
      uLod: params.downsample === "area" ? Math.log2(params.pixelSize) : 0,
      uLevels: levels,
      uStrength: params.patternStrength,
      uBias: params.thresholdBias * (255 / Math.max(1, levels - 1)),
      uBrightness: params.brightness,
      uContrastF: (1.015 * (params.contrast + 1)) / (1.015 - params.contrast),
      uInvGamma: 1 / params.gamma,
      iInvert: params.invert >= 0.5 ? 1 : 0,
      iAlgorithm: algorithm,
      iOutputMode: mode,
      iCutLightest: params.cutLightest ? 1 : 0,
      iApplyBrightness: params.brightness !== 0 ? 1 : 0,
      iApplyContrast: params.contrast !== 0 ? 1 : 0,
      iApplyGamma: params.gamma !== 1 ? 1 : 0,
      uDark: [params.duoDark.r, params.duoDark.g, params.duoDark.b],
      uLight: [params.duoLight.r, params.duoLight.g, params.duoLight.b],
      uInk: [ink.r / 255, ink.g / 255, ink.b / 255],
      uPaper: [paper.r / 255, paper.g / 255, paper.b / 255],
      uAtlasGrid: atlasGrid,
      uAtlasCell: atlasCell,
      uCellAspect: aspect,
      uGrid: [cols, rows],
      uRank: Array.from(ranks),
      iText: text ? (text.mode === "ramp" ? 1 : 2) : 0,
      uFlowSize: params.flowSize,
      uFlowOpacity: params.flowOpacity,
      uWordGap: params.flowWordGap,
      iMotion: MOTION_IDS.indexOf(params.motion),
      uMotionAmount: params.motionAmount,
      uMotionSpeed: params.motionSpeed,
      uMotionAspect: width / height,
      uTime: t,
    });
  }

  pixels(width: number, height: number): Uint8ClampedArray {
    return this.surface.readPixels(width, height);
  }
}
