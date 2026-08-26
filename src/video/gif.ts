/**
 * A GIF89a writer, written here rather than taken from a package.
 *
 * The reason is the same one that keeps the fonts and the noise mask in the
 * repo: this app works with the network off and uploads nothing, and a GIF
 * encoder is a few hundred lines of well-specified bit-packing. It is also a
 * better fit than a general one would be — dithered output is *already*
 * quantized, usually to a handful of colours, so the palette step that
 * dominates a normal GIF encoder is here almost always a no-op that reproduces
 * the picture exactly.
 *
 * No DOM. Pixels in, bytes out, so it runs under plain Node and is tested
 * there — the same rule `src/core` lives by, for the same reason.
 */

/** GIF's own limit: the colour table is indexed by one byte. */
const MAX_COLORS = 256;
/** LZW codes are at most 12 bits, so the table cannot exceed this. */
const MAX_CODE = 4096;

/**
 * Delays are stored in hundredths of a second, which is the format's real
 * constraint on frame rate and not a choice made here — 30 fps is 3.33
 * centiseconds and has to land on 3.
 *
 * Two is the floor rather than one because a delay of 0 or 1 is not honoured:
 * browsers and most viewers clamp anything under 2 up to 10 (a 100 ms frame),
 * so a GIF asking for 100 fps plays at 10 and looks broken. Asking for 50 is
 * the fastest thing that actually plays at the rate it claims.
 */
export const MIN_DELAY_CS = 2;

/** The centisecond delay a given frame rate rounds to, and what it really plays at. */
export function delayFor(fps: number): { delayCs: number; actualFps: number } {
  const wanted = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const delayCs = Math.max(MIN_DELAY_CS, Math.round(100 / wanted));
  return { delayCs, actualFps: 100 / delayCs };
}

/** A growable byte sink. `Uint8Array` cannot grow and a plain array is slow to join. */
class Bytes {
  private buf = new Uint8Array(64 * 1024);
  private length = 0;

  private room(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + extra) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(this.buf.subarray(0, this.length));
    this.buf = bigger;
  }

  byte(value: number): void {
    this.room(1);
    this.buf[this.length++] = value & 0xff;
  }

  /** Little-endian, which is what every multi-byte field in GIF is. */
  short(value: number): void {
    this.byte(value);
    this.byte(value >> 8);
  }

  bytes(values: ArrayLike<number>): void {
    this.room(values.length);
    this.buf.set(values as Uint8Array, this.length);
    this.length += values.length;
  }

  ascii(text: string): void {
    for (let i = 0; i < text.length; i++) this.byte(text.charCodeAt(i));
  }

  get size(): number {
    return this.length;
  }

  take(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/**
 * LZW as GIF specifies it, which differs from the textbook in two ways that
 * matter: codes are packed **least-significant bit first**, and the code width
 * grows one bit at a time from `minCodeSize + 1`.
 *
 * The growth test is `next >= (1 << width)` **before** the new entry is
 * inserted. Off by one in either direction and the stream still writes, still
 * decodes for a few hundred pixels, and then falls apart — which is why it is
 * spelled out rather than left to look obvious.
 */
export function lzwCompress(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  const out = new Bytes();
  // GIF carries LZW data in sub-blocks of at most 255 bytes, each prefixed by
  // its own length, so the packed bits are accumulated here and flushed out in
  // chunks rather than written straight through.
  const block: number[] = [];
  let accumulator = 0;
  let bitsHeld = 0;

  const flushBlock = (): void => {
    if (block.length === 0) return;
    out.byte(block.length);
    out.bytes(block);
    block.length = 0;
  };

  let width = minCodeSize + 1;
  const emit = (code: number): void => {
    accumulator |= code << bitsHeld;
    bitsHeld += width;
    while (bitsHeld >= 8) {
      block.push(accumulator & 0xff);
      accumulator >>= 8;
      bitsHeld -= 8;
      if (block.length === 255) flushBlock();
    }
  };

  let table = new Map<number, number>();
  let next = eoiCode + 1;

  emit(clearCode);

  if (indices.length > 0) {
    let prefix = indices[0]!;
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i]!;
      // One integer key rather than a string: `prefix` is under 4096 and `k`
      // under 256, so they pack into a number and the map stays fast. String
      // keys here cost more than the compression saves.
      const key = (prefix << 8) | k;
      const found = table.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (next === MAX_CODE) {
        // The table is full. A clear resets both ends of the conversation —
        // the decoder rebuilds its table from this code too.
        emit(clearCode);
        table = new Map();
        next = eoiCode + 1;
        width = minCodeSize + 1;
      } else {
        if (next >= 1 << width) width++;
        table.set(key, next++);
      }
      prefix = k;
    }
    emit(prefix);
  }

  emit(eoiCode);

  // Whatever is left in the accumulator is a partial byte, and it still has to
  // go: dropping it truncates the final code and the last run of pixels with it.
  if (bitsHeld > 0) {
    block.push(accumulator & 0xff);
    if (block.length === 255) flushBlock();
  }
  flushBlock();
  out.byte(0); // block terminator

  return out.take();
}

export interface Swatch {
  r: number;
  g: number;
  b: number;
}

export interface Quantized {
  /** One byte per pixel, indexing `palette`. */
  indices: Uint8Array;
  palette: Swatch[];
  /** The index reserved for fully transparent pixels, or −1 when none was needed. */
  transparent: number;
  /** True when the palette holds every colour in the frame, so nothing was approximated. */
  exact: boolean;
}

/** 24-bit key for an opaque colour. Alpha is handled separately — GIF has one bit of it. */
function key(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

/**
 * Median cut, and only when it is needed.
 *
 * The first pass is an exact count, which for this app's output nearly always
 * finishes under 256 — a two-tone dither has two colours, a palette strip has
 * as many as it has swatches. When it does, the palette *is* the frame's
 * colours and the GIF is lossless. Median cut is the fallback for the cases
 * that are not quantized already: colour halftone, and the source's own colours
 * showing through a cutout.
 */
export function quantize(rgba: Uint8ClampedArray, alphaThreshold = 128): Quantized {
  const count = rgba.length >> 2;
  const indices = new Uint8Array(count);

  // A colour histogram, exact until it overflows. `Map` rather than a
  // 16-million-entry array: the whole point is that these frames hold very few
  // distinct colours, and allocating 64 MB to discover that would be absurd.
  const histogram = new Map<number, number>();
  let transparentSeen = false;
  let overflowed = false;

  for (let i = 0, p = 0; i < count; i++, p += 4) {
    if (rgba[p + 3]! < alphaThreshold) {
      transparentSeen = true;
      continue;
    }
    const k = key(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!);
    const seen = histogram.get(k);
    if (seen === undefined) {
      // Counting past the point where an exact palette is possible buys
      // nothing and costs a hash insert per pixel on a photographic frame.
      if (histogram.size >= MAX_COLORS * 8) {
        overflowed = true;
        break;
      }
      histogram.set(k, 1);
    } else {
      histogram.set(k, seen + 1);
    }
  }

  // One slot goes to transparency when the frame has any, so the colours get
  // 255 rather than 256. Taking it out of the budget up front is what stops a
  // full palette and a transparent pixel colliding on index 255.
  const budget = MAX_COLORS - (transparentSeen ? 1 : 0);

  let palette: Swatch[];
  let exact: boolean;
  if (!overflowed && histogram.size <= budget) {
    palette = [...histogram.keys()].map((k) => ({
      r: (k >> 16) & 0xff,
      g: (k >> 8) & 0xff,
      b: k & 0xff,
    }));
    exact = true;
  } else {
    palette = medianCut(rgba, alphaThreshold, budget);
    exact = false;
  }

  // A GIF needs at least two entries — a one-colour table is not a legal size,
  // and `minCodeSize` has a floor of 2 regardless.
  if (palette.length === 0) palette = [{ r: 0, g: 0, b: 0 }];

  const transparent = transparentSeen ? palette.length : -1;
  if (transparentSeen) {
    // The colour behind the transparent index is never shown, but it has to be
    // *something*; black is the conventional filler.
    palette = [...palette, { r: 0, g: 0, b: 0 }];
  }

  // The lookup is cached rather than recomputed: on an exact palette it is a
  // hit for every pixel after the first of its colour, and on an approximated
  // one it turns a 256-entry search per pixel into one per distinct colour.
  const lookup = new Map<number, number>();
  palette.forEach((swatch, i) => {
    if (i !== transparent) lookup.set(key(swatch.r, swatch.g, swatch.b), i);
  });

  for (let i = 0, p = 0; i < count; i++, p += 4) {
    if (rgba[p + 3]! < alphaThreshold) {
      indices[i] = transparent;
      continue;
    }
    const k = key(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!);
    let at = lookup.get(k);
    if (at === undefined) {
      at = nearest(palette, transparent, rgba[p]!, rgba[p + 1]!, rgba[p + 2]!);
      lookup.set(k, at);
    }
    indices[i] = at;
  }

  return { indices, palette, transparent, exact };
}

/** Nearest palette entry by squared distance. The transparent slot is never a match. */
function nearest(palette: Swatch[], transparent: number, r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i++) {
    if (i === transparent) continue;
    const swatch = palette[i]!;
    const dr = swatch.r - r;
    const dg = swatch.g - g;
    const db = swatch.b - b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Median cut: split the box with the widest channel spread at that channel's
 * median, repeatedly, until there are as many boxes as the budget allows. Each
 * box's average becomes a swatch.
 *
 * Chosen over a k-means or an octree because it is the one that never produces
 * an *empty* bucket — every box has at least one colour in it by construction,
 * so the palette is always exactly as large as it claims.
 */
function medianCut(rgba: Uint8ClampedArray, alphaThreshold: number, budget: number): Swatch[] {
  const count = rgba.length >> 2;
  // Sampled rather than exhaustive. A 4K frame is eight million pixels and the
  // palette it yields from a hundred thousand of them is the same one; the cut
  // is a statistic, not a census.
  const stride = Math.max(1, Math.floor(count / 100_000));

  const samples: number[] = [];
  for (let i = 0, p = 0; i < count; i += stride, p = i * 4) {
    if (rgba[p + 3]! < alphaThreshold) continue;
    samples.push(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!);
  }
  if (samples.length === 0) return [{ r: 0, g: 0, b: 0 }];

  interface Box {
    from: number;
    to: number;
    spread: number;
    channel: 0 | 1 | 2;
  }

  const measure = (from: number, to: number): { spread: number; channel: 0 | 1 | 2 } => {
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (let i = from; i < to; i++) {
      for (let c = 0; c < 3; c++) {
        const v = samples[i * 3 + c]!;
        if (v < lo[c]!) lo[c] = v;
        if (v > hi[c]!) hi[c] = v;
      }
    }
    // Weighted the way the eye weights them, so a green gradient gets more of
    // the palette than a blue one of the same numeric width.
    const spreads = [(hi[0]! - lo[0]!) * 0.3, (hi[1]! - lo[1]!) * 0.59, (hi[2]! - lo[2]!) * 0.11];
    let channel: 0 | 1 | 2 = 0;
    if (spreads[1]! > spreads[channel]!) channel = 1;
    if (spreads[2]! > spreads[channel]!) channel = 2;
    return { spread: spreads[channel]!, channel };
  };

  const pixels = samples.length / 3;
  const boxes: Box[] = [{ from: 0, to: pixels, ...measure(0, pixels) }];

  while (boxes.length < budget) {
    // The widest box splits next. A box of one colour has zero spread and can
    // never be split, which is also the loop's exit when the frame has fewer
    // distinct colours than the budget.
    let widest = -1;
    let widestSpread = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      if (box.spread > widestSpread && box.to - box.from > 1) {
        widestSpread = box.spread;
        widest = i;
      }
    }
    if (widest < 0) break;

    const box = boxes[widest]!;
    const c = box.channel;
    // Sorting a slice of an interleaved array means moving whole pixels, so the
    // slice is lifted out, sorted as triples, and written back.
    const slice: number[][] = [];
    for (let i = box.from; i < box.to; i++) {
      slice.push([samples[i * 3]!, samples[i * 3 + 1]!, samples[i * 3 + 2]!]);
    }
    slice.sort((a, b) => a[c]! - b[c]!);
    for (let i = 0; i < slice.length; i++) {
      const pixel = slice[i]!;
      samples[(box.from + i) * 3] = pixel[0]!;
      samples[(box.from + i) * 3 + 1] = pixel[1]!;
      samples[(box.from + i) * 3 + 2] = pixel[2]!;
    }

    const middle = box.from + (slice.length >> 1);
    boxes.splice(widest, 1, { from: box.from, to: middle, ...measure(box.from, middle) }, {
      from: middle,
      to: box.to,
      ...measure(middle, box.to),
    });
  }

  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = box.from; i < box.to; i++) {
      r += samples[i * 3]!;
      g += samples[i * 3 + 1]!;
      b += samples[i * 3 + 2]!;
    }
    const n = Math.max(1, box.to - box.from);
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  });
}

/** Colour tables are a power of two from 2 to 256; this is the exponent GIF stores. */
export function tableSizeExponent(colors: number): number {
  let exponent = 1;
  while (1 << exponent < colors) exponent++;
  return Math.min(7, Math.max(1, exponent));
}

export interface GifOptions {
  width: number;
  height: number;
  /** 0 loops forever, which is what an exported animation should do. */
  loop?: number;
}

/**
 * A streaming writer: frames are quantized and compressed as they arrive and
 * the RGBA is not kept.
 *
 * This is not an optimisation, it is the only workable shape. A live recording
 * at 1280×720 is 3.7 MB per frame of RGBA — holding a minute of that to pick a
 * global palette at the end would need thirteen gigabytes.
 *
 * The cost of streaming is that the palette cannot be shared across frames it
 * has not seen yet. So the first frame's palette becomes the global table and
 * every later frame reuses it *when its own palette is identical* — which for
 * a dithered animation with a fixed ink and paper is every frame — and carries
 * its own local table when it is not.
 */
export class GifWriter {
  private out = new Bytes();
  private globalPalette: Swatch[] | null = null;
  private globalKey = "";
  private frames = 0;
  private finished = false;
  private readonly width: number;
  private readonly height: number;
  private readonly loop: number;
  /** True if any frame's palette had to approximate, so the caller can say so. */
  approximated = false;

  constructor(options: GifOptions) {
    this.width = Math.max(1, Math.min(65535, Math.floor(options.width)));
    this.height = Math.max(1, Math.min(65535, Math.floor(options.height)));
    this.loop = options.loop ?? 0;
  }

  /** Bytes written so far, so a caller can stop before it makes a file nobody can open. */
  get size(): number {
    return this.out.size;
  }

  get frameCount(): number {
    return this.frames;
  }

  /**
   * `rgba` must be exactly `width × height × 4`. `delayCs` is hundredths of a
   * second — see `delayFor`, which is the only thing that should be computing it.
   */
  addFrame(rgba: Uint8ClampedArray, delayCs: number): void {
    if (this.finished) throw new Error("this GIF has already been finished");
    const expected = this.width * this.height * 4;
    if (rgba.length !== expected) {
      throw new Error(
        `frame is ${rgba.length} bytes, expected ${expected} for ${this.width}×${this.height}`,
      );
    }

    const { indices, palette, transparent, exact } = quantize(rgba);
    if (!exact) this.approximated = true;

    const paletteKey = palette.map((s) => `${s.r},${s.g},${s.b}`).join(";");

    if (this.frames === 0) {
      this.globalPalette = palette;
      this.globalKey = paletteKey;
      this.writeHeader(palette);
    }

    const local = paletteKey === this.globalKey ? null : palette;
    this.writeFrame(indices, local, transparent, delayCs);
    this.frames++;
  }

  private writeHeader(palette: Swatch[]): void {
    const out = this.out;
    out.ascii("GIF89a");
    out.short(this.width);
    out.short(this.height);
    const exponent = tableSizeExponent(palette.length);
    // Global table present (0x80), 8-bit colour resolution (0x70), then the size.
    out.byte(0x80 | 0x70 | (exponent - 1));
    out.byte(0); // background colour index
    out.byte(0); // pixel aspect ratio: 0 means "square, don't correct"
    this.writeTable(palette, exponent);

    // The Netscape extension is how a GIF loops. It is an application block
    // rather than part of the format proper, which is why it looks like a
    // magic string — it is one.
    out.byte(0x21);
    out.byte(0xff);
    out.byte(11);
    out.ascii("NETSCAPE2.0");
    out.byte(3);
    out.byte(1);
    out.short(this.loop);
    out.byte(0);
  }

  private writeTable(palette: Swatch[], exponent: number): void {
    const entries = 1 << exponent;
    for (let i = 0; i < entries; i++) {
      const swatch = palette[i];
      this.out.byte(swatch?.r ?? 0);
      this.out.byte(swatch?.g ?? 0);
      this.out.byte(swatch?.b ?? 0);
    }
  }

  private writeFrame(
    indices: Uint8Array,
    local: Swatch[] | null,
    transparent: number,
    delayCs: number,
  ): void {
    const out = this.out;
    const palette = local ?? this.globalPalette!;

    // Graphic control extension: the delay, and the transparent index if there
    // is one. Disposal 2 — restore to background — is required wherever a frame
    // has transparency, or the frame under it shows through the holes and the
    // animation accumulates into a smear. Without transparency, 1 (leave it) is
    // both correct and smaller.
    out.byte(0x21);
    out.byte(0xf9);
    out.byte(4);
    const disposal = transparent >= 0 ? 2 : 1;
    out.byte((disposal << 2) | (transparent >= 0 ? 1 : 0));
    out.short(Math.max(0, Math.min(65535, Math.round(delayCs))));
    out.byte(transparent >= 0 ? transparent : 0);
    out.byte(0);

    // Image descriptor. Every frame covers the whole canvas — no differencing,
    // which would shrink the file but is a second algorithm to get right.
    out.byte(0x2c);
    out.short(0);
    out.short(0);
    out.short(this.width);
    out.short(this.height);
    const exponent = tableSizeExponent(palette.length);
    out.byte(local ? 0x80 | (exponent - 1) : 0);
    if (local) this.writeTable(local, exponent);

    // The minimum code size follows the table, and has a floor of 2: a
    // one-bit-per-pixel LZW stream is not something the format allows, even for
    // a two-colour image.
    const minCodeSize = Math.max(2, exponent);
    out.byte(minCodeSize);
    out.bytes(lzwCompress(indices, minCodeSize));
  }

  finish(): Uint8Array {
    if (this.finished) throw new Error("this GIF has already been finished");
    if (this.frames === 0) throw new Error("a GIF needs at least one frame");
    this.finished = true;
    this.out.byte(0x3b); // trailer
    return this.out.take();
  }
}
