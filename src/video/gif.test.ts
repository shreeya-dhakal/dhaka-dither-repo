import { expect, test } from "vitest";
import { delayFor, GifWriter, lzwCompress, quantize, tableSizeExponent } from "./gif.ts";

/**
 * A decoder, in the tests, because nothing else here can tell a correct GIF
 * from a plausible one.
 *
 * Every bug this file exists to catch — a code width grown one pixel late, the
 * final partial byte dropped, a colour table written at the wrong size —
 * produces a stream that is well-formed for hundreds of pixels and then quietly
 * wrong. Asserting on byte counts or on the header would pass for all of them.
 * Decoding back to pixels is the only check that actually holds.
 */
function lzwDecompress(data: Uint8Array, minCodeSize: number, expected: number): Uint8Array {
  // Sub-blocks first: the compressed stream is split by length prefixes and has
  // to be rejoined before a single bit of it can be read.
  const packed: number[] = [];
  let at = 0;
  for (;;) {
    const length = data[at++]!;
    if (length === 0) break;
    for (let i = 0; i < length; i++) packed.push(data[at++]!);
  }

  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  let width = minCodeSize + 1;
  let dictionary: number[][] = [];
  const reset = (): void => {
    dictionary = [];
    for (let i = 0; i < clearCode; i++) dictionary.push([i]);
    dictionary.push([], []); // clear and EOI occupy their slots
    width = minCodeSize + 1;
  };
  reset();

  const out: number[] = [];
  let bitAt = 0;
  const read = (): number => {
    let value = 0;
    for (let i = 0; i < width; i++) {
      const byte = packed[(bitAt + i) >> 3];
      if (byte === undefined) return eoiCode;
      value |= ((byte >> ((bitAt + i) & 7)) & 1) << i;
    }
    bitAt += width;
    return value;
  };

  let previous: number[] | null = null;
  for (;;) {
    const code = read();
    if (code === eoiCode) break;
    if (code === clearCode) {
      reset();
      previous = null;
      continue;
    }

    let entry: number[];
    if (code < dictionary.length) {
      entry = dictionary[code]!;
    } else if (previous) {
      // The self-referential case: a code for an entry that is about to be
      // created. Legal, and the one every naive decoder gets wrong.
      entry = [...previous, previous[0]!];
    } else {
      throw new Error(`code ${code} arrived with no previous entry`);
    }

    out.push(...entry);
    if (previous) {
      dictionary.push([...previous, entry[0]!]);
      if (dictionary.length === 1 << width && width < 12) width++;
    }
    previous = entry;
    if (out.length > expected * 2) throw new Error("decode ran away");
  }

  return Uint8Array.from(out);
}

test("a delay is centiseconds, and never fast enough to be clamped", () => {
  // 30 fps does not divide 100, so it lands on 3 and plays at 33.3.
  expect(delayFor(30)).toEqual({ delayCs: 3, actualFps: 100 / 3 });
  expect(delayFor(25)).toEqual({ delayCs: 4, actualFps: 25 });
  expect(delayFor(10)).toEqual({ delayCs: 10, actualFps: 10 });
  // Anything under 2 is clamped up to 10 by viewers, so asking for it is worse
  // than useless — it turns a 60 fps request into a 10 fps GIF.
  expect(delayFor(60).delayCs).toBe(2);
  expect(delayFor(1000).delayCs).toBe(2);
  expect(delayFor(0).delayCs).toBe(3);
});

test("a colour table is the smallest power of two that fits", () => {
  expect(tableSizeExponent(2)).toBe(1); // 2 entries
  expect(tableSizeExponent(3)).toBe(2); // 4 entries
  expect(tableSizeExponent(4)).toBe(2);
  expect(tableSizeExponent(5)).toBe(3);
  expect(tableSizeExponent(129)).toBe(7);
  expect(tableSizeExponent(256)).toBe(7); // 256 entries is the maximum
});

test("LZW round-trips a run that crosses several code widths", () => {
  // Long enough to grow the code width more than once, and patterned enough
  // that the dictionary genuinely fills — random noise compresses badly and
  // exercises fewer of the paths than a repeating structure does.
  const indices = new Uint8Array(9000);
  for (let i = 0; i < indices.length; i++) indices[i] = (i * 7 + (i >> 5)) & 0x0f;

  const packed = lzwCompress(indices, 4);
  expect(lzwDecompress(packed, 4, indices.length)).toEqual(indices);
});

test("LZW round-trips a stream long enough to fill and clear the table", () => {
  // Over 4096 dictionary entries means the encoder must emit a clear code and
  // start again. Getting that wrong desynchronises the decoder from that point
  // on, so the tail is what proves it.
  const indices = new Uint8Array(200_000);
  let seed = 1;
  for (let i = 0; i < indices.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    indices[i] = (seed >> 16) & 0xff;
  }

  const packed = lzwCompress(indices, 8);
  expect(lzwDecompress(packed, 8, indices.length)).toEqual(indices);
});

test("LZW round-trips a single flat colour", () => {
  const indices = new Uint8Array(5000); // all zero
  const packed = lzwCompress(indices, 2);
  expect(lzwDecompress(packed, 2, indices.length)).toEqual(indices);
});

test("a dithered frame quantizes exactly, because it is already quantized", () => {
  // Two colours in, two colours out, and every pixel lands on the one it came
  // from. This is the case that matters: it is what the whole app produces.
  const rgba = new Uint8ClampedArray(64 * 4);
  for (let i = 0; i < 64; i++) {
    const on = i % 3 === 0;
    rgba.set(on ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4);
  }

  const { palette, indices, exact, transparent } = quantize(rgba);
  expect(exact).toBe(true);
  expect(palette.length).toBe(2);
  expect(transparent).toBe(-1);
  for (let i = 0; i < 64; i++) {
    const swatch = palette[indices[i]!]!;
    expect(swatch.r).toBe(rgba[i * 4]);
  }
});

test("more colours than a palette holds are approximated, not dropped", () => {
  // A gradient wide enough that no exact palette exists. Every pixel must still
  // get an index, and the result must stay close — a wrong-but-near colour is
  // the deal GIF offers; a black frame is not.
  const count = 4096;
  const rgba = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    rgba.set([i & 0xff, (i >> 4) & 0xff, (i >> 8) & 0xff, 255], i * 4);
  }

  const { palette, indices, exact } = quantize(rgba);
  expect(exact).toBe(false);
  expect(palette.length).toBeLessThanOrEqual(256);
  expect(palette.length).toBeGreaterThan(1);

  let worst = 0;
  for (let i = 0; i < count; i++) {
    const swatch = palette[indices[i]!];
    expect(swatch).toBeDefined();
    const dr = swatch!.r - rgba[i * 4]!;
    const dg = swatch!.g - rgba[i * 4 + 1]!;
    const db = swatch!.b - rgba[i * 4 + 2]!;
    worst = Math.max(worst, Math.sqrt(dr * dr + dg * dg + db * db));
  }
  expect(worst).toBeLessThan(64);
});

test("transparency takes its own index and never collides with a colour", () => {
  const rgba = new Uint8ClampedArray(4 * 4);
  rgba.set([10, 20, 30, 255], 0);
  rgba.set([10, 20, 30, 0], 4);
  rgba.set([200, 100, 50, 255], 8);
  rgba.set([200, 100, 50, 0], 12);

  const { indices, palette, transparent } = quantize(rgba);
  expect(transparent).toBeGreaterThanOrEqual(0);
  expect(indices[1]).toBe(transparent);
  expect(indices[3]).toBe(transparent);
  expect(indices[0]).not.toBe(transparent);
  expect(palette[indices[0]!]).toEqual({ r: 10, g: 20, b: 30 });
  expect(palette[indices[2]!]).toEqual({ r: 200, g: 100, b: 50 });
});

/** Enough of a GIF parser to get the pixels back out. */
function parseGif(bytes: Uint8Array): {
  width: number;
  height: number;
  loop: number | null;
  frames: { delayCs: number; pixels: Uint8Array; palette: number[][]; transparent: number }[];
} {
  const ascii = String.fromCharCode(...bytes.subarray(0, 6));
  expect(ascii).toBe("GIF89a");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const packed = bytes[10]!;
  let at = 13;

  const readTable = (exponent: number): number[][] => {
    const entries = 1 << exponent;
    const table: number[][] = [];
    for (let i = 0; i < entries; i++) {
      table.push([bytes[at]!, bytes[at + 1]!, bytes[at + 2]!]);
      at += 3;
    }
    return table;
  };

  let global: number[][] = [];
  if (packed & 0x80) global = readTable((packed & 0x07) + 1);

  const frames: ReturnType<typeof parseGif>["frames"] = [];
  let loop: number | null = null;
  let pendingDelay = 0;
  let pendingTransparent = -1;

  for (;;) {
    const marker = bytes[at++]!;
    if (marker === 0x3b) break; // trailer

    if (marker === 0x21) {
      const label = bytes[at++]!;
      if (label === 0xf9) {
        const size = bytes[at++]!;
        expect(size).toBe(4);
        const flags = bytes[at]!;
        pendingDelay = view.getUint16(at + 1, true);
        pendingTransparent = flags & 1 ? bytes[at + 3]! : -1;
        at += 4;
        expect(bytes[at++]).toBe(0);
      } else if (label === 0xff) {
        const size = bytes[at++]!;
        const name = String.fromCharCode(...bytes.subarray(at, at + size));
        at += size;
        if (name === "NETSCAPE2.0") {
          at++; // sub-block size
          at++; // sub-block id
          loop = view.getUint16(at, true);
          at += 2;
        }
        // Skip whatever sub-blocks remain.
        for (;;) {
          const length = bytes[at++]!;
          if (length === 0) break;
          at += length;
        }
      } else {
        throw new Error(`unexpected extension 0x${label.toString(16)}`);
      }
      continue;
    }

    if (marker !== 0x2c) throw new Error(`unexpected marker 0x${marker.toString(16)}`);

    const fw = view.getUint16(at + 4, true);
    const fh = view.getUint16(at + 6, true);
    const imagePacked = bytes[at + 8]!;
    at += 9;
    const table = imagePacked & 0x80 ? readTable((imagePacked & 0x07) + 1) : global;

    const minCodeSize = bytes[at++]!;
    const start = at;
    for (;;) {
      const length = bytes[at++]!;
      if (length === 0) break;
      at += length;
    }
    const pixels = lzwDecompress(bytes.subarray(start, at), minCodeSize, fw * fh);
    expect(pixels.length).toBe(fw * fh);

    frames.push({ delayCs: pendingDelay, pixels, palette: table, transparent: pendingTransparent });
    pendingDelay = 0;
    pendingTransparent = -1;
  }

  return { width, height, loop, frames };
}

test("a written GIF decodes back to the exact pixels it was given", () => {
  const width = 17; // deliberately not a multiple of 8, to catch row assumptions
  const height = 9;
  const writer = new GifWriter({ width, height });

  const sources: Uint8ClampedArray[] = [];
  for (let f = 0; f < 3; f++) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const on = (i + f) % 4 < 2;
      rgba.set(on ? [17, 34, 51, 255] : [238, 221, 204, 255], i * 4);
    }
    sources.push(rgba);
    writer.addFrame(rgba, 5);
  }

  const parsed = parseGif(writer.finish());
  expect(parsed.width).toBe(width);
  expect(parsed.height).toBe(height);
  expect(parsed.loop).toBe(0);
  expect(parsed.frames.length).toBe(3);
  expect(writer.approximated).toBe(false);

  parsed.frames.forEach((frame, f) => {
    expect(frame.delayCs).toBe(5);
    const source = sources[f]!;
    for (let i = 0; i < width * height; i++) {
      const swatch = frame.palette[frame.pixels[i]!]!;
      expect([swatch[0], swatch[1], swatch[2]], `frame ${f} pixel ${i}`).toEqual([
        source[i * 4],
        source[i * 4 + 1],
        source[i * 4 + 2],
      ]);
    }
  });
});

test("a frame whose palette differs carries its own colour table", () => {
  const writer = new GifWriter({ width: 2, height: 2 });
  const first = new Uint8ClampedArray(16);
  const second = new Uint8ClampedArray(16);
  for (let i = 0; i < 4; i++) {
    first.set([0, 0, 0, 255], i * 4);
    second.set([255, 0, 0, 255], i * 4);
  }
  writer.addFrame(first, 10);
  writer.addFrame(second, 10);

  const parsed = parseGif(writer.finish());
  // Both frames must come back as the colour they went in as. The second one
  // can only do that through a local table, since the global one is the first
  // frame's.
  expect(parsed.frames[0]!.palette[parsed.frames[0]!.pixels[0]!]).toEqual([0, 0, 0]);
  expect(parsed.frames[1]!.palette[parsed.frames[1]!.pixels[0]!]).toEqual([255, 0, 0]);
});

test("a transparent frame round-trips its transparent index", () => {
  const writer = new GifWriter({ width: 2, height: 1 });
  const rgba = new Uint8ClampedArray(8);
  rgba.set([9, 9, 9, 255], 0);
  rgba.set([0, 0, 0, 0], 4);
  writer.addFrame(rgba, 4);

  const parsed = parseGif(writer.finish());
  const frame = parsed.frames[0]!;
  expect(frame.transparent).toBeGreaterThanOrEqual(0);
  expect(frame.pixels[1]).toBe(frame.transparent);
  expect(frame.palette[frame.pixels[0]!]).toEqual([9, 9, 9]);
});

test("a frame of the wrong size is refused rather than written crooked", () => {
  const writer = new GifWriter({ width: 4, height: 4 });
  expect(() => writer.addFrame(new Uint8ClampedArray(4 * 3 * 4), 5)).toThrow(/expected/);
});

test("an empty GIF is refused, and a finished one cannot be added to", () => {
  expect(() => new GifWriter({ width: 2, height: 2 }).finish()).toThrow(/at least one frame/);

  const writer = new GifWriter({ width: 1, height: 1 });
  writer.addFrame(new Uint8ClampedArray([1, 2, 3, 255]), 5);
  writer.finish();
  expect(() => writer.finish()).toThrow(/already been finished/);
  expect(() => writer.addFrame(new Uint8ClampedArray([1, 2, 3, 255]), 5)).toThrow(
    /already been finished/,
  );
});
