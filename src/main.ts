/**
 * Entry point: load an image, pick any algorithm, adjust tone and ink, export a
 * PNG — in Nepali or English.
 *
 * No user-visible string lives here. Labels come from `data-i18n` keys in the
 * markup; anything built at runtime goes through `t()`. Numbers go through
 * `num()`, never `String(n)`: a Devanagari interface with Latin digits reads as
 * a bug even when every string moved correctly.
 */

import type { HoverId } from "./core/hover.ts";
import { KERNELS } from "./core/kernels.ts";
import type { Rgb } from "./core/palette.ts";
import { ensureFontsLoaded, isSupported, measureAll } from "./glyph/density.ts";
import { akshara } from "./glyph/akshara.ts";
import { bharatiCoverage } from "./glyph/bharati.ts";
import { effectiveSteps, skippedClusters } from "./glyph/ramp.ts";
import { segment, uniqueClusters } from "./glyph/segment.ts";
import { varnamala } from "./glyph/varnamala.ts";
import { num, t, type MessageKey } from "./i18n/index.ts";
import {
  defaultAspect,
  PARAM_RANGES,
  StaticParams,
  type ParamSet,
  type ParamValues,
  type TextFont,
} from "./params.ts";
import { GpuPipeline, textArtFor } from "./render/gpu.ts";
import {
  BLUE_NOISE_SIZE,
  FONT_STACK,
  sourceSize,
  StillPipeline,
  workingGrid,
} from "./render/image.ts";
import {
  decodeParams,
  decodePresets,
  encodeParams,
  encodePresets,
  type Preset,
} from "./serialize.ts";
import { StaticText } from "./text.ts";
import { zip, type ZipEntry } from "./zip.ts";
import { canDecode, inspect, type SourceVideo } from "./video/decode.ts";
import { exportVideo, pathFor } from "./video/pipeline.ts";

function need<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as unknown as T;
}

const stage = need<HTMLDivElement>("stage");
const empty = need<HTMLParagraphElement>("empty");
const canvas = need<HTMLCanvasElement>("out");
const frame = need<HTMLDivElement>("frame");
const fileInput = need<HTMLInputElement>("file");
const scaleSelect = need<HTMLSelectElement>("scale");

/**
 * The address bar as it was when the page opened.
 *
 * Captured here, before anything else runs, because startup commits settings of
 * its own — a default face, a palette index — and every commit rewrites the
 * URL from the current params. By the time the module reached the point of
 * *reading* the hash it had already been replaced with a clean path, so a
 * shared link silently opened on defaults.
 */
const INITIAL_HASH = location.hash;

const params = new StaticParams();
// Seam 2: the renderer never reads the textarea. It asks this at time t.
const textSource = new StaticText();
let pipeline: StillPipeline | null = null;
let gpu: GpuPipeline | null = null;
/** Kept so an export can build its own pipelines rather than borrow the preview's. */
let blueNoise: Uint8Array | null = null;
let bitmap: ImageBitmap | null = null;
/** Set when the loaded file is a video; the still preview is its first frame. */
let video: { file: File; source: SourceVideo; scrubbable: boolean } | null = null;
let exporting: AbortController | null = null;
/** An output mode braille displaced, held so it can be handed back. */
let displacedMode: "color" | null = null;
/** A pointer effect that loading a video displaced, held so it can be handed back. */
let displacedHover: HoverId | null = null;
/** A tone count the palette mode displaced, held so it can be handed back. */
let displacedLevels: number | null = null;
/** Set once the user moves the cell-ratio slider; defaults stop overriding it then. */
let aspectTouched = false;

/**
 * The preview plays the real file and renders each frame as it arrives, so what
 * is on screen is the effect applied to the whole clip rather than one frame
 * standing in for it. `requestVideoFrameCallback` fires once per decoded frame;
 * the rAF fallback covers browsers without it by rendering whatever is current.
 */
const player = document.createElement("video");
player.muted = true;
player.loop = true;
player.playsInline = true;
let playing = false;

/**
 * Anything whose text is computed rather than looked up — slider read-outs,
 * the scale options. Switching language re-runs these instead of reloading, so
 * no state is lost.
 */
const refreshers: (() => void)[] = [];

/**
 * Pushes the current params back *into* the controls.
 *
 * Filled by the binders themselves rather than kept as a second list of control
 * ids: a preset or a URL sets forty values at once, and a hand-written list here
 * would go stale exactly like the serializer's would.
 */
const writers: (() => void)[] = [];
function syncAllControls(): void {
  for (const write of writers) write();
}

const EXPORT_SCALES = [1, 2, 4, 8];
/** How many strips are bundled, so an uploaded one can be numbered from 1. */
let BUILT_IN_COUNT = 0;

/**
 * Saved presets, in memory for the session and exportable to a file.
 *
 * Not in `localStorage`: this tool keeps nothing about the user anywhere, and a
 * silent local store would be the first thing it did keep. A file is explicit —
 * the user chooses to write it and knows where it went.
 */
const presets: Preset[] = [];
let exportScale = 1;

/**
 * The still image, or the video's current frame. Named as the union actually
 * produced rather than `CanvasImageSource` or `TexImageSource`: those two
 * overlap without either containing the other, and only these two satisfy both
 * the 2D path and the GL upload.
 */
function currentSource(): ImageBitmap | HTMLVideoElement | null {
  if (video && player.readyState >= 2) return player;
  return bitmap;
}

/**
 * The preview clock for stills, in seconds. Driven by rAF only while an
 * animation is selected — a still with no animation must keep costing nothing,
 * and a permanently running render loop would burn a core to redraw an
 * identical frame.
 */
let stillTime = 0;
let stillClock: number | null = null;

function syncStillClock(): void {
  const animated = params.resolve(0).motion !== "none" && !video && currentSource() !== null;
  if (animated && stillClock === null) {
    const started = performance.now();
    const tick = () => {
      stillTime = (performance.now() - started) / 1000;
      cancelScheduledDraw();
      draw();
      stillClock = requestAnimationFrame(tick);
    };
    stillClock = requestAnimationFrame(tick);
  } else if (!animated && stillClock !== null) {
    cancelAnimationFrame(stillClock);
    stillClock = null;
    stillTime = 0;
  }
}

/**
 * The pointer, as parameters.
 *
 * Tracked on the stage and fed through `params.update`, so the renderer still
 * reads no UI state — and a PNG exports from the same numbers that were on
 * screen. Only live for stills: video has no pointer at export time.
 */
function trackPointer(event: PointerEvent): void {
  if (video || params.resolve(0).hover === "none") return;
  const box = canvas.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return;
  params.update({
    pointerU: (event.clientX - box.left) / box.width,
    pointerV: (event.clientY - box.top) / box.height,
  });
  // Pointer moves arrive faster than slider drags, and every hover effect
  // re-renders the whole picture. Coalesced for the same reason.
  scheduleDraw();
}

/**
 * The scrub bar's position and readout, driven from the element rather than
 * from the slider: the element is the truth about where playback is, and during
 * playback the slider is a display rather than an input.
 */
function syncTimeline(): void {
  if (!video) return;
  const scrub = need<HTMLInputElement>("scrub");
  const duration = video.source.duration || 1;
  scrub.disabled = !video.scrubbable;
  if (document.activeElement !== scrub) {
    scrub.value = String(Math.round((player.currentTime / duration) * 1000));
  }
  // Rounded, not `toFixed`: a string slot skips `num()` and prints Latin digits
  // into a Devanagari interface, which reads as a bug even though the sentence
  // moved correctly.
  need<HTMLParagraphElement>("scrubReadout").textContent = t("video.scrubAt", {
    n: Math.round(player.currentTime * 100) / 100,
    total: Math.round(duration * 100) / 100,
    frame: Math.min(video.source.frameCount, Math.floor(player.currentTime * video.source.fps) + 1),
  });
}

/**
 * Scales the picture to fill the frame, keeping its proportions.
 *
 * Computed rather than left to CSS: `max-width`/`max-height` only ever shrink,
 * so a small photo sat at its own pixel size surrounded by empty pane; a
 * specified `width: 100%` scales up but stretches anything tall, because the
 * height cap then clamps without re-deriving the width; and `object-fit`
 * preserves the picture but leaves the border drawn around the empty box.
 */
function fitCanvas(): void {
  if (canvas.hidden || canvas.width === 0 || canvas.height === 0) return;
  const box = frame.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return;
  const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
  canvas.style.width = `${Math.round(canvas.width * scale)}px`;
  canvas.style.height = `${Math.round(canvas.height * scale)}px`;
}
// The frame's size follows the window, and the picture follows the frame.
window.addEventListener("resize", fitCanvas);

let drawHandle: number | null = null;

/**
 * One render per animation frame, however many commits land in between.
 *
 * `commit` used to call `draw` straight out of the `input` handler, and a
 * slider drag fires those at pointer rate — sixty to a hundred and twenty a
 * second. Every one of them started a full synchronous render, so on a large
 * source the main thread spent the whole drag working through a backlog of
 * frames the user had already dragged past. The picture lagged the handle by
 * seconds and the page stopped responding to anything else.
 *
 * Coalescing changes no pixels: the render that runs is the one for the values
 * current at the frame boundary, which is the only one that was ever going to
 * be seen. It only stops the ones in between being computed and thrown away.
 */
function scheduleDraw(): void {
  if (drawHandle !== null) return;
  drawHandle = requestAnimationFrame(() => {
    drawHandle = null;
    draw();
  });
}

/** The animation clock draws every frame itself; a queued draw would double it. */
function cancelScheduledDraw(): void {
  if (drawHandle === null) return;
  cancelAnimationFrame(drawHandle);
  drawHandle = null;
}

function draw(): void {
  const source = currentSource();
  if (!source || !pipeline || !gpu) return;

  // A playing video resolves at its own clock, which is the seam doing its job
  // rather than a special case. Named `time`, not `t`, because `t` is the
  // translation function.
  //
  // A still has no clock of its own, and at a fixed t = 0 every animation would
  // sit motionless — the control would look broken. So a still under an
  // animation runs the preview clock instead. This is the one place preview and
  // export legitimately differ: a PNG is a single instant, and `stillTime` is
  // the instant it captures, so what is exported is exactly what is on screen
  // at the moment the button is pressed.
  const time = video ? player.currentTime : stillTime;
  const resolved = params.resolve(time);

  if (pathFor(resolved, textSource.at(time).clusters) === "gpu" && video) {
    // The GPU owns its own canvas — a canvas cannot hold both a WebGL2 and a
    // 2D context — so the result is blitted onto the stage.
    const { w, h } = sourceSize(source);
    const cols = Math.max(1, Math.round(w / resolved.pixelSize));
    const rows = Math.max(1, Math.round(h / (resolved.pixelSize * resolved.cellAspect)));
    const art = textArtFor(resolved, textSource, FONT_STACK[resolved.textFont], cols, rows);
    gpu.render(source, w, h, resolved, art ?? undefined, time);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(gpu.canvas, 0, 0);
    }
  } else {
    pipeline.render(source, resolved, textSource, canvas, 1, time);
  }

  // Both facts are only known once the layout has run against the real grid.
  // Truncation says "you gave me too much"; fill says "here is how much of the
  // frame you covered". Same surface, opposite directions, neither an alarm.
  fitCanvas();
  syncTimeline();

  const lost = pipeline.flowTruncated();
  const parts: string[] = [];
  if (params.resolve(0).text === "flow") {
    parts.push(t("flow.fill", { n: Math.round(pipeline.flowFill() * 100) }));
    const suggestion = fillingPixelSize();
    if (suggestion !== null) parts.push(t("flow.suggest", { n: suggestion }));
  }
  if (lost > 0) parts.push(t("flow.truncated", { n: lost }));
  need<HTMLParagraphElement>("flowTruncated").textContent = parts.join(" ");
}

/**
 * The pixel size at which this text would fill the grid exactly once, or null
 * when that is what the user already has.
 *
 * Derived, not chosen: cells = (srcW/p) × (srcH/(p·aspect)), so setting that
 * equal to the cluster count gives p. The suppression threshold is the pixel
 * size control's own step, so no number here was invented.
 */
function fillingPixelSize(): number | null {
  if (!bitmap) return null;
  const current = params.resolve(0);
  const ink = textSource.at(0).clusters.filter((c) => c.trim() !== "").length;
  if (ink === 0) return null;

  const range = PARAM_RANGES.pixelSize;
  const ideal = Math.sqrt((bitmap.width * bitmap.height) / (ink * current.cellAspect));

  // Outside the control's range there is no setting that fills the frame, and
  // clamping to the nearest end would make the message a lie — at pixel size 64
  // a 1920×1080 frame still leaves 120 clusters covering well under half the
  // grid. Say nothing rather than name a size that does not do what is claimed.
  if (ideal < range.min || ideal > range.max) return null;

  const snapped = Math.round(ideal);
  return Math.abs(snapped - current.pixelSize) > range.step ? snapped : null;
}

/**
 * The glyph-steps control is a request. A ladder cannot have more rungs than
 * the text has distinct characters, so the effective number is shown rather
 * than letting the slider claim 20 while 4 are in use.
 */
function showEffectiveSteps(): void {
  const current = params.resolve(0);
  const measured = measureAll(uniqueClusters(textSource.at(0).clusters), FONT_STACK[current.textFont]);
  const skipped = skippedClusters(measured);
  need<HTMLParagraphElement>("effectiveSteps").textContent =
    t("text.effectiveSteps", { n: effectiveSteps(measured, current.glyphSteps) }) +
    // Two whole sentences, each its own key — never one sentence built from
    // fragments. Joining finished sentences with a space is not concatenation.
    (skipped > 0 ? " " + t("text.skipped", { n: skipped }) : "");
}

/** How much of the text the Bharati table actually covers, stated plainly. */
function showBharatiCoverage(): void {
  const units = akshara(textSource.at(0).clusters.join(""));
  const { mapped, total } = bharatiCoverage(units);
  need<HTMLParagraphElement>("bharatiCoverage").textContent =
    total === 0 ? "" : t("braille.coverage", { n: mapped, total });
}

/**
 * Two different situations, deliberately handled differently.
 *
 * A control that belongs to another algorithm is **hidden** — a Bayer matrix
 * size means nothing next to Floyd–Steinberg and there is nothing to explain.
 *
 * A control the user reached for that genuinely does nothing here is
 * **disabled with a reason**, never hidden: `levels` under halftone and
 * braille. Hiding it would read as a broken app and teach nothing, and leaving
 * it live would be the app lying about what it is about to do.
 *
 * Output mode stays live under halftone even though Mono and Duo draw the same
 * picture, because Color genuinely does something there. A note says so. A
 * half-inert select is worse than either, so the duo pickers hide instead —
 * they belong to another algorithm's ink, and halftone shows its own pair.
 */
function syncControls(): void {
  const current = params.resolve(0);
  const applies: Record<string, boolean> = {
    text: current.text !== "off",
    ramp: current.text === "ramp",
    flow: current.text === "flow",
    diffusion: current.algorithm in KERNELS,
    ordered: ["bayer", "blue-noise", "white-noise"].includes(current.algorithm),
    bayer: current.algorithm === "bayer",
    halftone: current.algorithm === "halftone",
    braille: current.text === "braille",
    // Worth saying only where the cost lands: a still repaints in milliseconds
    // either way, so the note would be noise outside an export.
    glowVideo: current.glow > 0 && video !== null,
    bharati: current.text === "braille" && current.brailleBharati,
    // Both modes carry tone somewhere other than the level count.
    levelsInert:
      current.algorithm === "halftone" ||
      current.text === "braille" ||
      current.outputMode === "palette",
    palette: current.outputMode === "palette",
    video: video !== null,
    noScrub: video !== null && !video.scrubbable,
    // Named for the fact rather than the control: this is about the kernel
    // being unstable on video, not about smoothing being unavailable.
    unstable: video !== null && current.algorithm in KERNELS,
    exporting: exporting !== null,
    ladder: ladderRunning,
    // Density mode is ink on paper, so the ink pair belongs on screen there
    // too — not hidden behind picking Duo first, which is not where anyone
    // working in Density mode would think to look.
    inkPair:
      (current.outputMode === "duo" && current.algorithm !== "halftone") ||
      current.text === "ramp",
    rampColor: current.text === "ramp" && current.outputMode === "color",
    ranjana: current.text !== "off" && current.textFont === "ranjana",
    motion: current.motion !== "none",
    // Only worth explaining where it applies: a video carries its own clock.
    motionStill: current.motion !== "none" && video === null,
    // Pointer effects are a still-image interaction, so the whole group is
    // hidden on video rather than disabled: it belongs to another medium,
    // not to a setting the user could fix. The note explains the absence.
    photo: video === null,
    hover: video === null && current.hover !== "none",
    hoverVideo: video !== null && current.hover !== "none",
  };

  for (const el of document.querySelectorAll<HTMLElement>("[data-when]")) {
    el.hidden = !applies[el.dataset.when ?? ""];
  }

  // Braille is ink on paper — dots are on or off — so there is no per-level
  // colour to give. Ramp does have one (its hue tint), which is why only
  // braille disables here. A selection already on Color moves rather than
  // rendering as something the control does not say — and is **given back**
  // when the constraint lifts. Forcing a choice and then keeping it is how a
  // user ends up thinking a feature disappeared.
  const modeSelect = need<HTMLSelectElement>("outputMode");
  const colorOption = modeSelect.querySelector<HTMLOptionElement>('option[value="color"]');
  if (colorOption) colorOption.disabled = applies.braille === true;

  if (applies.braille) {
    if (current.outputMode === "color") {
      displacedMode = "color";
      params.update({ outputMode: "mono" });
      modeSelect.value = "mono";
    }
  } else if (displacedMode !== null) {
    // Only restore an untouched forcing. If the user picked something else
    // while in braille, that is their choice and it stands.
    if (current.outputMode === "mono") {
      params.update({ outputMode: displacedMode });
      modeSelect.value = displacedMode;
    }
    displacedMode = null;
  }

  // One swatch per level, or the mapping skews: SPEC is explicit that the
  // strip's count and the quantization count are the same number. So the
  // palette drives `levels` rather than the two being set independently and
  // disagreeing — and the original is handed back on leaving, like every other
  // displaced choice.
  if (current.outputMode === "palette" && pipeline) {
    const swatches = pipeline.paletteFor(current).swatches.length;
    if (current.levels !== swatches) {
      if (displacedLevels === null) displacedLevels = current.levels;
      params.update({ levels: swatches });
      const levelsInput = document.getElementById("levels") as HTMLInputElement | null;
      if (levelsInput) levelsInput.value = String(swatches);
    }
  } else if (displacedLevels !== null) {
    params.update({ levels: displacedLevels });
    const levelsInput = document.getElementById("levels") as HTMLInputElement | null;
    if (levelsInput) levelsInput.value = String(displacedLevels);
    displacedLevels = null;
  }

  // Hiding the pointer group on video is not enough on its own: the parameter
  // would survive, and the CPU export path applies whatever it is handed. So a
  // video displaces the choice outright — and hands it back on returning to a
  // photo, unless the user picked something else meanwhile.
  const hoverSelect = need<HTMLSelectElement>("hover");
  if (video !== null) {
    if (current.hover !== "none") {
      displacedHover = current.hover;
      params.update({ hover: "none" });
      hoverSelect.value = "none";
    }
  } else if (displacedHover !== null) {
    if (current.hover === "none") {
      params.update({ hover: displacedHover });
      hoverSelect.value = displacedHover;
    }
    displacedHover = null;
  }

  for (const label of document.querySelectorAll<HTMLElement>("[data-disable]")) {
    const inert = applies[label.dataset.disable ?? ""] ?? false;
    label.classList.toggle("is-disabled", inert);
    for (const control of label.querySelectorAll<HTMLInputElement>("input, select")) {
      control.disabled = inert;
    }
  }
}

function commit(patch: Partial<ParamSet>): void {
  params.update(patch);
  syncControls();
  syncStillClock();
  syncUrl();
  if (params.resolve(0).text === "ramp") showEffectiveSteps();
  if (params.resolve(0).brailleBharati) showBharatiCoverage();
  scheduleDraw();
}

/** Range input bound to a parameter, taking its bounds from PARAM_RANGES. */
function bindSlider(name: keyof ParamValues): void {
  const input = need<HTMLInputElement>(name);
  const output = need<HTMLOutputElement>(`${name}Out`);
  const range = PARAM_RANGES[name];

  // Bounds stay Latin: they are the input element's own arithmetic, not text.
  input.min = String(range.min);
  input.max = String(range.max);
  input.step = String(range.step);
  input.value = String(params.resolve(0)[name]);

  const show = () => {
    output.value = num(params.resolve(0)[name]);
  };
  refreshers.push(show);
  writers.push(() => {
    input.value = String(params.resolve(0)[name]);
    show();
  });
  show();

  input.addEventListener("input", () => {
    // A default must never overwrite a ratio the user has set by hand.
    if (name === "cellAspect") aspectTouched = true;
    commit({ [name]: Number(input.value) });
    show();
  });
  // Applied defaults move the slider without an `input` event, so the read-out
  // is refreshed explicitly rather than silently going stale.
  input.addEventListener("refresh", show);
}

function bindCheckbox(name: keyof ParamSet, asNumber = false): void {
  const input = need<HTMLInputElement>(name);
  input.checked = Boolean(params.resolve(0)[name]);
  input.addEventListener("change", () => {
    commit({ [name]: asNumber ? Number(input.checked) : input.checked } as Partial<ParamSet>);
  });
}

function bindSelect(name: keyof ParamSet, asNumber = false): void {
  const select = need<HTMLSelectElement>(name);
  select.value = String(params.resolve(0)[name]);
  writers.push(() => {
    select.value = String(params.resolve(0)[name]);
  });
  select.addEventListener("change", () => {
    commit({ [name]: asNumber ? Number(select.value) : select.value } as Partial<ParamSet>);
  });
}

function toRgb(hex: string): Rgb {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function bindColor(
  name: "duoDark" | "duoLight" | "halftoneInk" | "halftonePaper",
): void {
  const input = need<HTMLInputElement>(name);
  const hex = ({ r, g, b }: Rgb) =>
    `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
  writers.push(() => {
    input.value = hex(params.resolve(0)[name]);
  });
  input.addEventListener("input", () => {
    const patch: Partial<ParamSet> = { [name]: toRgb(input.value) };

    // Mono means black on white by definition, so choosing an ink in Density
    // mode is an unambiguous request for two colours. Switch the mode with it
    // rather than accepting a colour and ignoring it — and let the Mode select
    // visibly move, so the consequence is on screen instead of implied. The
    // defaults are black and white, so the switch itself changes nothing.
    const current = params.resolve(0);
    if ((name === "duoDark" || name === "duoLight") && current.outputMode === "mono") {
      patch.outputMode = "duo";
      need<HTMLSelectElement>("outputMode").value = "duo";
    }
    commit(patch);
  });
}

const textInput = need<HTMLTextAreaElement>("textContent");
/** While untouched, the text follows the UI language. Once edited, it is the user's. */
let textEdited = false;

function setText(value: string): void {
  textInput.value = value;
  // Seam 2: the caller segments, the source carries clusters. Version bumps
  // only on real change, so retyping the same thing rebuilds no ladder.
  textSource.setClusters(segment(value));
}

function applyDefaultText(): void {
  if (textEdited) return;
  // Devanagari, always. This used to follow the interface language, which was
  // never really what it meant: the seed text demonstrates what the tool does,
  // and the tool dithers Devanagari and Ranjana. Letting it follow the English
  // interface would have booted the app as a Latin mono ASCII-art toy with its
  // subject switched off.
  const font: TextFont = "devanagari";
  setText(t("text.defaultContent"));
  need<HTMLSelectElement>("textFont").value = font;
  commit({ textFont: font });
  applyAspectDefault();
}

/**
 * The cell ratio follows the mode and face unless the user has moved it. Both
 * the font switch and the mode switch go through here rather than each
 * carrying its own copy — braille wanting 2.0 is the same problem as a mono
 * face wanting 1.9, so it uses the same mechanism.
 */
function applyAspectDefault(): void {
  if (aspectTouched) return;
  const current = params.resolve(0);
  const aspect = defaultAspect(current.text, current.textFont);
  if (aspect === current.cellAspect) return;
  params.update({ cellAspect: aspect });
  const slider = need<HTMLInputElement>("cellAspect");
  slider.value = String(aspect);
  slider.dispatchEvent(new Event("refresh"));
}
refreshers.push(applyDefaultText);

textInput.addEventListener("input", () => {
  textEdited = true;
  setText(textInput.value);
  showEffectiveSteps();
  draw();
});

need<HTMLSelectElement>("textFont").addEventListener("change", (event) => {
  commit({ textFont: (event.target as HTMLSelectElement).value as TextFont });
  applyAspectDefault();
  draw();
});

need<HTMLButtonElement>("copyText").addEventListener("click", () => {
  const grid = pipeline?.gridAsText();
  if (grid) void navigator.clipboard.writeText(grid);
});

/** "2×" and "1× original size" are one key with a slot, never a label plus a number. */
function renderScaleOptions(): void {
  scaleSelect.replaceChildren();
  for (const value of EXPORT_SCALES) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent =
      value === 1 ? t("export.scaleOriginal", { n: value }) : t("export.scaleMultiple", { n: value });
    scaleSelect.append(option);
  }
  scaleSelect.value = String(exportScale);
}
refreshers.push(renderScaleOptions);

/**
 * Paints every `data-i18n` element from the catalog and re-runs the refreshers.
 *
 * Still a function rather than markup, with one language and nothing to switch
 * to: it is what keeps labels out of `index.html` and a typo in a `data-i18n`
 * attribute a compile error. Runs once at startup.
 */
function applyStrings(): void {
  document.title = t("app.documentTitle");

  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n as MessageKey);
  }
  // optgroup carries its text in an attribute, not a child node.
  for (const group of document.querySelectorAll<HTMLOptGroupElement>("[data-i18n-label]")) {
    group.label = t(group.dataset.i18nLabel as MessageKey);
  }
  for (const refresh of refreshers) refresh();
}

/**
 * A video previews as its first frame. Scrubbing arrives with the timeline at
 * step 11; what matters here is that every control operates on the real frame
 * rather than on a placeholder.
 */
async function firstFrame(file: File): Promise<ImageBitmap> {
  const element = document.createElement("video");
  element.muted = true;
  element.src = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    element.addEventListener("loadeddata", resolve, { once: true });
    element.addEventListener("error", () => reject(new Error("could not read the video")), { once: true });
  });
  // `loadeddata` means a frame is *decodable*, not that one has been painted.
  // Capturing there gives an opaque black bitmap, and since the still preview
  // is exactly this frame until the user presses play, the picture came up
  // black — with whatever part of the frame had arrived showing as a band of
  // real image against it.
  //
  // `requestVideoFrameCallback` is the signal for "a frame has been presented",
  // which is precisely the thing being waited on. The timeout is a backstop: a
  // paused element is not obliged to present anything, and a slightly early
  // capture is a far smaller problem than hanging on the load.
  const withFrameCallback = element as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
  };
  if (withFrameCallback.requestVideoFrameCallback) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      withFrameCallback.requestVideoFrameCallback!(finish);
      setTimeout(finish, 1200);
    });
  }

  // No seek: the element is at zero regardless, and assigning `currentTime`
  // here is a seek that some codecs refuse, for no gain.
  //
  // `createImageBitmap` straight off a video element is the direct route and
  // the one to try first, but it is not universally accepted — it raises "the
  // image source is not usable" on perfectly good files in some builds, and
  // losing the whole load to that is not worth it when `drawImage` takes the
  // same element without complaint.
  let frame: ImageBitmap;
  try {
    frame = await createImageBitmap(element);
  } catch {
    const scratch = document.createElement("canvas");
    scratch.width = element.videoWidth;
    scratch.height = element.videoHeight;
    const ctx = scratch.getContext("2d");
    if (!ctx) throw new Error("could not get a 2D context for the first frame");
    ctx.drawImage(element, 0, 0);
    frame = await createImageBitmap(scratch);
  }
  URL.revokeObjectURL(element.src);
  return frame;
}

/**
 * `load` with somewhere for its failures to go.
 *
 * Opening a file is the first thing anyone does here, and the promise used to be
 * floated bare: a codec the element could not read threw, the rejection went
 * unhandled, and the page simply sat on its empty-state message as though
 * nothing had been clicked. Every awaited user action needs a catch that puts
 * the reason on screen, and this one most of all.
 */
async function openFile(file: File): Promise<void> {
  try {
    await load(file);
  } catch (error) {
    empty.hidden = false;
    canvas.hidden = true;
    frame.hidden = true;
    empty.textContent = t("image.failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function load(file: File): Promise<void> {
  bitmap?.close();
  video = null;

  if (file.type.startsWith("video/")) {
    const { source } = await inspect(file);
    // Scrubbing means seeking, and seeking is exactly what the fallback codecs
    // refuse — a 10-bit HEVC element raises a decode error on a seek while
    // playing the same file perfectly. So the scrub bar is offered only for
    // streams WebCodecs will decode on demand, which is the same probe the
    // exporter uses to choose its path. Everything else keeps play and export.
    const scrubbable = await canDecode(source);
    video = { file, source, scrubbable };
    bitmap = await firstFrame(file);
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(file);
    playing = false;
    need<HTMLButtonElement>("play").textContent = t("video.play");
    // Ordered dithering is position-deterministic, so it does not boil frame to
    // frame. Error diffusion rewrites its whole error field when one pixel
    // moves, which crawls — so video opens on blue noise.
    need<HTMLSelectElement>("algorithm").value = "blue-noise";
    commit({ algorithm: "blue-noise" });
    need<HTMLParagraphElement>("videoInfo").textContent =
      t("video.info", {
        w: source.width,
        h: source.height,
        frames: source.frameCount,
        fps: Math.round(source.fps),
      }) +
      " " +
      t(source.audio ? "video.audioKept" : "video.audioDropped");
  } else {
    bitmap = await createImageBitmap(file);
  }

  empty.hidden = true;
  canvas.hidden = false;
  frame.hidden = false;
  syncControls();
  draw();
}

function pump(): void {
  if (!playing) return;
  draw();
  const withCallback = player as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
  };
  if (withCallback.requestVideoFrameCallback) withCallback.requestVideoFrameCallback(pump);
  else requestAnimationFrame(pump);
}

function togglePlay(): void {
  if (!video) return;
  playing = !playing;
  need<HTMLButtonElement>("play").textContent = t(playing ? "video.pause" : "video.play");
  if (playing) {
    // Not `void`: a rejected `play()` used to vanish, leaving the button
    // reading "pause" over a picture that never moved and no clue why.
    player.play().catch((error: unknown) => {
      playing = false;
      need<HTMLButtonElement>("play").textContent = t("video.play");
      need<HTMLParagraphElement>("videoInfo").textContent = t("video.playFailed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    pump();
  } else {
    player.pause();
  }
}

async function runVideoExport(): Promise<void> {
  if (!video || !pipeline || !gpu || exporting) return;
  exporting = new AbortController();
  syncControls();

  // The preview keeps playing throughout. It used to be paused here to "hand
  // back its decoder", which was wrong twice over: pausing does not release a
  // decode session — an element holds its decoder while `src` is set, playing
  // or not — and the export has used its own element since the fallback was
  // rewritten. All the pause achieved was freezing the picture.
  //
  // The export gets its own pipelines for the same reason: sharing them makes
  // the preview and the export resize each other's scratch buffers every
  // frame, and they draw at different resolutions.
  const exportCpu = new StillPipeline(blueNoise!);
  const exportGpu = new GpuPipeline(document.createElement("canvas"), blueNoise!);

  const info = need<HTMLParagraphElement>("videoInfo");
  try {
    const result = await exportVideo({
      file: video.file,
      params,
      text: textSource,
      cpu: exportCpu,
      gpu: exportGpu,
      bitrate: 5_000_000,
      signal: exporting.signal,
      onProgress: ({ frame, total }) => {
        info.textContent = t("video.progress", { n: frame, total });
      },
    });

    download(result.blob, `dhaka.${result.container}`);
    // A shortfall is reported rather than swallowed. One frame of slack: the
    // element path can present its first frame before the callback is
    // registered, and the container's own count is not always exact.
    const short = result.expectedFrames - result.frames;
    info.textContent =
      t("video.done") +
      " " +
      t(result.audioKept ? "video.audioKept" : "video.audioDropped") +
      (result.usedFallback ? " " + t("video.fallback") : "") +
      (short > 1
        ? " " + t("video.short", { n: result.frames, total: result.expectedFrames })
        : "");
  } catch (error) {
    // Without this the whole export fails as an unhandled rejection: no file,
    // no message, nothing on screen to say anything went wrong.
    info.textContent = t("video.failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    exporting = null;
    syncControls();
  }
}

/**
 * The anchor is attached before clicking and the object URL is released on the
 * next task rather than immediately: revoking synchronously can cancel a
 * download that has not started reading yet, which is silent and looks exactly
 * like nothing happening.
 */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 10_000);
}

async function exportPng(): Promise<void> {
  if (!bitmap || !pipeline) return;

  // Render into a throwaway canvas so the preview is not resized under the user.
  const full = document.createElement("canvas");
  pipeline.render(bitmap, params.resolve(0), textSource, full, exportScale);

  const blob = await new Promise<Blob | null>((resolve) => full.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("could not encode the PNG");

  // Latin digits deliberately: this is a filename, not interface text.
  download(blob, `dhaka-${exportScale}x.png`);
}

/**
 * One PNG at every pixel size the control offers.
 *
 * A ladder like this is the point of a dithering tool: the same picture at
 * pixel size 1 and 64 are different artefacts, and which one is right is a
 * judgement made by looking. Saving them one at a time by hand is 64 round
 * trips through the slider.
 *
 * Separate files rather than one sheet, and separate rather than zipped: a ZIP
 * writer is a dependency this project has already declined, so the browser's own
 * download of each file is the only honest route. It asks once whether to allow
 * several, which the note beside the button says up front.
 */
let ladderRunning = false;
let ladderCancelled = false;

async function exportPixelLadder(): Promise<void> {
  if (!bitmap || !pipeline || ladderRunning) return;
  ladderRunning = true;
  ladderCancelled = false;
  syncControls();

  const status = need<HTMLParagraphElement>("ladderStatus");
  const range = PARAM_RANGES.pixelSize;
  const sizes: number[] = [];
  for (let size = range.min; size <= range.max; size += range.step) sizes.push(size);

  // Its own pipeline and its own canvas: sharing the preview's would resize its
  // scratch buffers 64 times and repaint the stage under the user.
  const ladderPipeline = new StillPipeline(blueNoise!);
  const target = document.createElement("canvas");

  // One instant for the whole run. Reading the preview clock per render would
  // advance an animation between files, so the ladder would show pixel size
  // *and* time changing and prove nothing about either.
  const at = video ? player.currentTime : stillTime;
  // A copy, never the borrowed set: mutating that would drive the live UI.
  const base = { ...params.resolve(at) };

  // Consecutive pixel sizes collapse onto the same working grid once they get
  // coarse — `round(srcW / pixelSize)` is the same number for a run of them —
  // and the renders are then byte-identical. Saving those is 31 duplicate files
  // out of 64 on a modest photo, which is not "every level", it is the same
  // level under several names. The grid is asked for rather than guessed, from
  // the one function the renderer itself uses.
  const { w: srcW, h: srcH } = sourceSize(bitmap);
  const wanted: number[] = [];
  let lastGrid = "";
  for (const size of sizes) {
    const grid = workingGrid(srcW, srcH, { ...base, pixelSize: size });
    const key = `${grid.w}x${grid.h}`;
    if (key === lastGrid) continue;
    lastGrid = key;
    wanted.push(size);
  }

  const entries: ZipEntry[] = [];
  let saved = 0;
  try {
    for (const size of wanted) {
      if (ladderCancelled) break;
      status.textContent = t("export.ladderProgress", {
        n: size,
        done: saved + 1,
        total: wanted.length,
      });
      // Yield so the status line paints and the cancel button can be clicked;
      // 64 renders of a large photo is long enough to look frozen otherwise.
      await new Promise((resolve) => setTimeout(resolve, 0));

      ladderPipeline.render(bitmap, { ...base, pixelSize: size }, textSource, target, exportScale, at);
      const blob = await new Promise<Blob | null>((resolve) =>
        target.toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("could not encode the PNG");

      // Zero-padded so a listing sorts the way the ladder runs; Latin digits
      // deliberately, because this is a filename and not interface text.
      entries.push({
        name: `dhaka-p${String(size).padStart(2, "0")}-${exportScale}x.png`,
        data: new Uint8Array(await blob.arrayBuffer()),
      });
      saved++;
    }

    if (entries.length > 0) {
      // One archive rather than one download per size. The entries are stored
      // uncompressed: a PNG is already deflated, so re-compressing it buys
      // almost nothing and would mean carrying an implementation of DEFLATE.
      const archive = zip(entries, new Date());
      download(
        new Blob([archive], { type: "application/zip" }),
        `dhaka-pixel-sizes-${exportScale}x.zip`,
      );
    }
    status.textContent = ladderCancelled
      ? t("export.ladderStopped", { n: saved })
      : t("export.ladderDone", { n: saved, skipped: sizes.length - wanted.length });
  } catch (error) {
    status.textContent = t("export.ladderFailed", {
      n: wanted[saved] ?? 0,
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    ladderRunning = false;
    syncControls();
  }
}

bindSlider("pixelSize");
bindSlider("levels");
bindSlider("patternStrength");
bindSlider("thresholdBias");
bindSlider("brightness");
bindSlider("contrast");
bindSlider("gamma");
bindSlider("halftoneCell");
bindSlider("halftoneAngle");
bindSlider("glyphSteps");
bindSlider("cellAspect");
bindSlider("glow");
bindSlider("dotRadius");
bindSlider("dotSpacing");
bindSlider("flowWeight");
bindSlider("flowSize");
bindSlider("flowOpacity");
bindSlider("flowWordGap");
bindCheckbox("invert", true);
bindCheckbox("serpentine");
bindCheckbox("cutLightest");
bindCheckbox("flowKeepWords");
bindCheckbox("brailleBharati");
bindSelect("algorithm");
bindSelect("outputMode");
bindSelect("halftoneShape");
bindSelect("motion");
bindSelect("hover");

/**
 * The strip list. Rebuilt rather than written once, because uploading a strip
 * changes how many there are — the same reason `paletteIndex` is clamped at use
 * rather than by its declared range.
 */
function refreshPalettes(): void {
  if (!pipeline) return;
  const select = need<HTMLSelectElement>("paletteIndex");
  const strips = pipeline.palettes();
  const chosen = Math.min(strips.length - 1, params.resolve(0).paletteIndex);
  select.replaceChildren();
  strips.forEach((strip, i) => {
    const option = document.createElement("option");
    option.value = String(i);
    const key = `palette.${strip.name}` as MessageKey;
    // A bundled strip has a name key; an uploaded one is numbered, because
    // naming someone's file for them in two languages is not something a
    // catalog can do.
    option.textContent = strip.name.startsWith("custom")
      ? t("palette.custom", { n: i - BUILT_IN_COUNT + 1 })
      : t(key);
    select.append(option);
  });
  select.value = String(chosen);
  if (chosen !== params.resolve(0).paletteIndex) commit({ paletteIndex: chosen });
}
refreshers.push(refreshPalettes);

/**
 * Everything on screen, in the address bar.
 *
 * `replaceState`, never `pushState`: a slider drag would otherwise write a
 * hundred history entries and take the back button away from the user. Only
 * the diff from defaults is written, so a link stays short enough to paste.
 *
 * The picture is never in it. Neither is the text — a link that quietly carried
 * someone's typed words would be a surprise, and a bad one.
 */
function syncUrl(): void {
  const query = encodeParams(params.resolve(0)).toString();
  history.replaceState(null, "", query === "" ? location.pathname : `#${query}`);
}

function refreshPresets(): void {
  const select = need<HTMLSelectElement>("presetPick");
  select.replaceChildren();
  if (presets.length === 0) {
    const option = document.createElement("option");
    option.textContent = t("preset.none");
    option.value = "";
    select.append(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  presets.forEach((preset, i) => {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = preset.name;
    select.append(option);
  });
}
refreshers.push(refreshPresets);

function applyPreset(preset: Preset): void {
  params.update(preset.params);
  if (preset.text !== "") {
    setText(preset.text);
    textEdited = true;
  }
  syncAllControls();
  syncControls();
  syncStillClock();
  syncUrl();
  draw();
}

need<HTMLSelectElement>("presetPick").addEventListener("change", (event) => {
  const at = Number((event.target as HTMLSelectElement).value);
  const preset = presets[at];
  if (preset) applyPreset(preset);
});

need<HTMLButtonElement>("presetSave").addEventListener("click", () => {
  const status = need<HTMLParagraphElement>("presetStatus");
  const name = need<HTMLInputElement>("presetName").value.trim();
  if (name === "") {
    status.textContent = t("preset.needsName");
    return;
  }
  const entry: Preset = {
    name,
    params: Object.fromEntries(encodeParams(params.resolve(0))) as Preset["params"],
    text: textInput.value,
  };
  // Stored as the decoded diff rather than as raw strings, so a preset applied
  // from memory and one applied from a file take the identical path.
  entry.params = decodeParams(encodeParams(params.resolve(0)).toString());
  const existing = presets.findIndex((p) => p.name === name);
  if (existing >= 0) presets[existing] = entry;
  else presets.push(entry);
  refreshPresets();
  need<HTMLSelectElement>("presetPick").value = String(presets.indexOf(entry));
  status.textContent = t("preset.savedAs", { name });
});

need<HTMLButtonElement>("presetCopyLink").addEventListener("click", async () => {
  const status = need<HTMLParagraphElement>("presetStatus");
  syncUrl();
  try {
    await navigator.clipboard.writeText(location.href);
    status.textContent = t("preset.linkCopied");
  } catch {
    // Every awaited user action needs a catch that puts the reason on screen.
    status.textContent = t("preset.linkFailed");
  }
});

need<HTMLButtonElement>("presetExport").addEventListener("click", () => {
  download(new Blob([encodePresets(presets)], { type: "application/json" }), "dhaka-presets.json");
});

need<HTMLButtonElement>("presetImport").addEventListener("click", () =>
  need<HTMLInputElement>("presetFile").click(),
);
need<HTMLInputElement>("presetFile").addEventListener("change", async (event) => {
  const status = need<HTMLParagraphElement>("presetStatus");
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const opened = decodePresets(await file.text());
    presets.push(...opened);
    refreshPresets();
    status.textContent = t("preset.imported", { n: opened.length });
  } catch (error) {
    status.textContent = t("preset.importFailed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    (event.target as HTMLInputElement).value = "";
  }
});
need<HTMLSelectElement>("paletteIndex").addEventListener("change", (event) => {
  commit({ paletteIndex: Number((event.target as HTMLSelectElement).value) });
});

/**
 * A strip from any image: read its pixels, sort them dark to light.
 *
 * Sorted rather than taken in order, because the level index *is* the position
 * in the strip — a strip that does not climb maps mid-tones brighter than the
 * tones above them. Sorting means any image works as a source, which is the
 * point of letting one be uploaded at all.
 */
need<HTMLButtonElement>("paletteUpload").addEventListener("click", () =>
  need<HTMLInputElement>("paletteFile").click(),
);
need<HTMLInputElement>("paletteFile").addEventListener("change", async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || !pipeline) return;
  try {
    const image = await createImageBitmap(file);
    const strip = document.createElement("canvas");
    // One row is enough, and it is what makes a tall image usable as a source.
    strip.width = Math.min(64, image.width);
    strip.height = 1;
    const sctx = strip.getContext("2d", { willReadFrequently: true });
    if (!sctx) throw new Error("no 2D context");
    sctx.drawImage(image, 0, 0, strip.width, 1);
    image.close();
    const data = sctx.getImageData(0, 0, strip.width, 1).data;

    const seen = new Map<string, Rgb>();
    for (let x = 0; x < strip.width; x++) {
      const p = x * 4;
      const swatch = { r: data[p]!, g: data[p + 1]!, b: data[p + 2]! };
      seen.set(`${swatch.r},${swatch.g},${swatch.b}`, swatch);
    }
    const swatches = [...seen.values()].sort(
      (a, b) =>
        0.2126 * a.r + 0.7152 * a.g + 0.0722 * a.b - (0.2126 * b.r + 0.7152 * b.g + 0.0722 * b.b),
    );
    if (swatches.length < 2) throw new Error("a strip needs at least two distinct colours");

    const index = pipeline.addPalette({ name: `custom-${swatches.length}`, swatches });
    refreshPalettes();
    commit({ outputMode: "palette", paletteIndex: index });
    need<HTMLSelectElement>("outputMode").value = "palette";
  } catch {
    need<HTMLParagraphElement>("flowTruncated").textContent = t("palette.failed");
  } finally {
    // Cleared so re-picking the same file fires `change` again.
    (event.target as HTMLInputElement).value = "";
  }
});

/**
 * Fill the text box with the letters the *selected* face actually covers.
 *
 * Ranjana is the reason this exists — it has no Unicode block of its own and
 * many users have no input method for Devanagari at all — but it is offered for
 * every face, because the pool is a property of the script rather than of one
 * font. Filtered at the point of use, so it is always the truth about the face
 * on screen rather than a table copied out of the audit.
 *
 * It appends. A button that silently replaced what the user had typed would be
 * taking their text away, and their text is the whole point of the feature.
 */
need<HTMLButtonElement>("varnamala").addEventListener("click", () => {
  const family = FONT_STACK[params.resolve(0).textFont];
  const pool = varnamala().filter((cluster) => isSupported(cluster, family));
  const existing = textInput.value.trimEnd();
  setText(existing === "" ? pool.join("") : `${existing} ${pool.join("")}`);
  textEdited = true;
  if (params.resolve(0).text === "ramp") showEffectiveSteps();
  draw();
});
bindSlider("motionAmount");
bindSlider("motionSpeed");
bindSlider("hoverRadius");
bindSlider("hoverStrength");
bindSlider("temporalSmoothing");
bindSelect("bayerSize", true);
bindSelect("text");
need<HTMLSelectElement>("text").addEventListener("change", () => {
  applyAspectDefault();
  draw();
});
bindSelect("flowFit");
bindColor("duoDark");
bindColor("duoLight");
bindColor("halftoneInk");
bindColor("halftonePaper");

scaleSelect.addEventListener("change", () => {
  exportScale = Number(scaleSelect.value);
});

need<HTMLButtonElement>("pick").addEventListener("click", () => fileInput.click());
need<HTMLButtonElement>("export").addEventListener("click", () => void exportPng());
need<HTMLButtonElement>("exportLadder").addEventListener("click", () => void exportPixelLadder());
need<HTMLButtonElement>("cancelLadder").addEventListener("click", () => {
  ladderCancelled = true;
});
need<HTMLButtonElement>("exportVideo").addEventListener("click", () => void runVideoExport());
need<HTMLButtonElement>("cancelVideo").addEventListener("click", () => exporting?.abort());
need<HTMLButtonElement>("play").addEventListener("click", togglePlay);
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
});

stage.addEventListener("dragover", (event) => {
  event.preventDefault();
  stage.classList.add("dragging");
});
stage.addEventListener("dragleave", () => stage.classList.remove("dragging"));
// On the canvas rather than the stage, so the coordinates are the picture's own
// and the effect does not follow the pointer across the surrounding margin.
canvas.addEventListener("pointermove", trackPointer);

/**
 * Seeking the preview element is normally forbidden — it is what the fallback
 * codecs refuse, and the symptom is a frozen frame. It is safe *here* and only
 * here, because the control is disabled for any stream WebCodecs will not
 * decode on demand, which is the same set that refuses seeks.
 */
need<HTMLInputElement>("scrub").addEventListener("input", (event) => {
  if (!video?.scrubbable) return;
  const at = (Number((event.target as HTMLInputElement).value) / 1000) * (video.source.duration || 0);
  if (playing) togglePlay();
  player.currentTime = at;
});
// A seek finishes asynchronously; drawing before it lands renders the old frame.
player.addEventListener("seeked", () => draw());

/**
 * The element is the authority on whether it is playing; the flag follows it.
 *
 * `playing` used to be set only by the button, which made it a claim rather
 * than a fact. An element stops on its own for plenty of ordinary reasons — a
 * decode hiccup, the browser reclaiming a codec, the media ending — and when
 * that happened the flag stayed true, the button went on reading "pause",
 * `requestVideoFrameCallback` stopped firing so the picture froze, and the next
 * click *paused* an element that was already paused. Two clicks to get anything,
 * which is indistinguishable from the button not working.
 */
function syncPlaying(): void {
  const actually = !player.paused && !player.ended;
  if (actually === playing) return;
  playing = actually;
  need<HTMLButtonElement>("play").textContent = t(playing ? "video.pause" : "video.play");
  // Restart the frame pump: it stops when the element does, and nothing else
  // would ever start it again.
  if (playing) pump();
}
for (const event of ["play", "playing", "pause", "ended"]) {
  player.addEventListener(event, syncPlaying);
}
stage.addEventListener("drop", (event) => {
  event.preventDefault();
  stage.classList.remove("dragging");
  const file = event.dataTransfer?.files?.[0];
  if (file && (file.type.startsWith("image/") || file.type.startsWith("video/"))) void openFile(file);
});

applyStrings();
syncControls();

// Hard rule 4: nothing may be measured until the bundled faces are actually
// loaded. Measuring a fallback produces a tonal ladder that is wrong in a way
// no downstream code can detect.
await ensureFontsLoaded([`32px ${FONT_STACK.devanagari}`, `32px ${FONT_STACK.mono}`, `32px ${FONT_STACK.ranjana}`]);
applyDefaultText();

/**
 * The mask ships as a binary asset; nothing fetches anything else, ever.
 *
 * The single-file build embeds it instead, because `fetch` is blocked under
 * `file://` exactly as a module script is — a page that had inlined its own
 * JavaScript would still have died on this line. Reading the embedded copy
 * first means the same source serves both builds without a flag.
 */
const embedded = document.getElementById("blue-noise")?.textContent?.trim();
const mask = embedded
  ? Uint8Array.from(atob(embedded), (character) => character.charCodeAt(0))
  : new Uint8Array(await (await fetch(new URL("masks/bluenoise64.bin", document.baseURI))).arrayBuffer());
if (mask.length < BLUE_NOISE_SIZE * BLUE_NOISE_SIZE) {
  throw new Error(`blue-noise mask is ${mask.length} bytes, expected ${BLUE_NOISE_SIZE ** 2}`);
}
blueNoise = mask;
pipeline = new StillPipeline(mask);
gpu = new GpuPipeline(document.createElement("canvas"), mask);
BUILT_IN_COUNT = pipeline.palettes().length;
refreshPalettes();
refreshPresets();

/**
 * Settings from the address bar, applied last so they win over every default —
 * including the ones a face or a mode would otherwise set.
 *
 * Read once at startup and never watched: reacting to later hash changes would
 * fight `syncUrl`, which writes on every commit.
 */
if (INITIAL_HASH.length > 1) {
  const fromLink = decodeParams(INITIAL_HASH);
  params.update(fromLink);
  // A ratio that arrived in the link is a ratio the user chose, so the
  // per-face default must not overwrite it on the next mode change.
  if (fromLink.cellAspect !== undefined) aspectTouched = true;
  syncAllControls();
  syncControls();
  syncStillClock();
  // Put the settings back in the bar. Startup's own commits cleared it while
  // the params were still defaults, and without this the link a user just
  // opened vanishes from the address bar — bookmark it then and the settings
  // are gone.
  syncUrl();
}
showEffectiveSteps();
draw();
