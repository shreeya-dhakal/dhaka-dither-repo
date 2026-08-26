/**
 * A minimal ZIP writer — stored entries only, no compression.
 *
 * Written out rather than taken from a package because hard rule 8 puts the
 * dependency budget above convenience, and this is about sixty lines. SPEC
 * turned a ZIP down once before, for a video frame-sequence fallback nobody
 * would reach; bundling a pixel-size ladder is a feature someone asked for, and
 * thirty-odd separate downloads is a genuinely bad way to hand it over.
 *
 * **Stored, never deflated.** Every entry here is a PNG, which is already
 * DEFLATE-compressed internally — running it through DEFLATE again buys close
 * to nothing and would mean implementing the whole algorithm. Storing costs
 * only the ~90 bytes of headers per file.
 *
 * No ZIP64. The format's 32-bit fields cap an archive at 4 GB and 65535
 * entries, and the ladder tops out at 64 files; `zip()` refuses rather than
 * writing a header that silently wraps.
 */

export interface ZipEntry {
  /** Stored verbatim. ASCII only — see `zip`. */
  name: string;
  data: Uint8Array;
}

/**
 * CRC-32 as ZIP defines it, table built once on first use.
 *
 * The table is 256 entries of the reversed polynomial 0xEDB88320; computing it
 * lazily keeps module load free for the pages that never write an archive.
 */
let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * MS-DOS date and time, which is what the format carries.
 *
 * Two-second resolution and a 1980 epoch are the format's, not a shortcut.
 * Taken as a parameter rather than read from the clock so the output is
 * reproducible and can be tested against a fixed byte sequence.
 */
function dosStamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/**
 * Builds the archive.
 *
 * Names must be ASCII: the language-3 bit that declares UTF-8 is not set, so a
 * non-ASCII name would be read in whatever code page the reader guesses. Every
 * caller here generates its own filenames, so this is a guard against a future
 * one, not a limitation anybody meets.
 */
/*
 * The return type names its buffer as a plain `ArrayBuffer` rather than
 * `ArrayBufferLike`. `Blob` accepts only the former, and without this the
 * caller has to cast — which is the same trap `out` parameters hit elsewhere in
 * this codebase, and a cast at the call site hides it instead of fixing it.
 */
export function zip(entries: readonly ZipEntry[], when: Date): Uint8Array<ArrayBuffer> {
  if (entries.length > 0xffff) {
    throw new Error(`a zip holds at most 65535 files, not ${entries.length}`);
  }
  for (const entry of entries) {
    // eslint-disable-next-line no-control-regex
    if (!/^[\x20-\x7e]+$/.test(entry.name)) {
      throw new Error(`zip entry names must be ASCII: ${entry.name}`);
    }
  }

  const { time, date } = dosStamp(when);
  const names = entries.map((entry) => new TextEncoder().encode(entry.name));
  const crcs = entries.map((entry) => crc32(entry.data));

  let localSize = 0;
  for (let i = 0; i < entries.length; i++) localSize += 30 + names[i]!.length + entries[i]!.data.length;
  let centralSize = 0;
  for (let i = 0; i < entries.length; i++) centralSize += 46 + names[i]!.length;

  const total = localSize + centralSize + 22;
  if (total > 0xffffffff) throw new Error("a zip without ZIP64 holds at most 4 GB");

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];

  for (let i = 0; i < entries.length; i++) {
    const name = names[i]!;
    const data = entries[i]!.data;
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true); // version needed
    view.setUint16(at + 6, 0, true); // flags
    view.setUint16(at + 8, 0, true); // method: stored
    view.setUint16(at + 10, time, true);
    view.setUint16(at + 12, date, true);
    view.setUint32(at + 14, crcs[i]!, true);
    view.setUint32(at + 18, data.length, true); // compressed
    view.setUint32(at + 22, data.length, true); // uncompressed
    view.setUint16(at + 26, name.length, true);
    view.setUint16(at + 28, 0, true); // extra
    out.set(name, at + 30);
    out.set(data, at + 30 + name.length);
    at += 30 + name.length + data.length;
  }

  const centralAt = at;
  for (let i = 0; i < entries.length; i++) {
    const name = names[i]!;
    const data = entries[i]!.data;
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true); // version made by
    view.setUint16(at + 6, 20, true); // version needed
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, 0, true); // stored
    view.setUint16(at + 12, time, true);
    view.setUint16(at + 14, date, true);
    view.setUint32(at + 16, crcs[i]!, true);
    view.setUint32(at + 20, data.length, true);
    view.setUint32(at + 24, data.length, true);
    view.setUint16(at + 28, name.length, true);
    view.setUint16(at + 30, 0, true); // extra
    view.setUint16(at + 32, 0, true); // comment
    view.setUint16(at + 34, 0, true); // disk
    view.setUint16(at + 36, 0, true); // internal attrs
    view.setUint32(at + 38, 0, true); // external attrs
    view.setUint32(at + 42, offsets[i]!, true);
    out.set(name, at + 46);
    at += 46 + name.length;
  }

  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 4, 0, true); // this disk
  view.setUint16(at + 6, 0, true); // disk with the central directory
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, centralSize, true);
  view.setUint32(at + 16, centralAt, true);
  view.setUint16(at + 20, 0, true); // comment length

  return out;
}
