import { expect, test } from "vitest";
import { zip } from "./zip.ts";

/**
 * These assert the format's own invariants — signatures, offsets, sizes, CRC.
 * They cannot prove a real reader accepts the result, so the archives this
 * writer produces were also checked with the system `unzip -t`, which reported
 * no errors and listed the right names, sizes and timestamps. Worth repeating
 * by hand if the writer is ever changed.
 */

const AT = new Date(2026, 7, 19, 14, 30, 20);
const bytes = (s: string) => new TextEncoder().encode(s);
const u32 = (d: Uint8Array, at: number) => new DataView(d.buffer).getUint32(at, true);
const u16 = (d: Uint8Array, at: number) => new DataView(d.buffer).getUint16(at, true);

test("an archive opens with a local file header and ends with the central directory", () => {
  const out = zip([{ name: "a.txt", data: bytes("hello") }], AT);
  expect(u32(out, 0)).toBe(0x04034b50);
  // The end record sits in the last 22 bytes when there is no comment.
  expect(u32(out, out.length - 22)).toBe(0x06054b50);
  expect(u16(out, out.length - 22 + 8)).toBe(1);
});

test("the central directory offset really points at the central directory", () => {
  // A reader finds every entry through this pointer, so an offset that is off
  // by even the header size yields an archive that opens to nothing.
  const out = zip(
    [
      { name: "one.bin", data: new Uint8Array([1, 2, 3]) },
      { name: "two.bin", data: new Uint8Array([4, 5]) },
    ],
    AT,
  );
  const at = u32(out, out.length - 22 + 16);
  expect(u32(out, at)).toBe(0x02014b50);
  expect(u16(out, out.length - 22 + 8)).toBe(2);
  // And the recorded size spans exactly to the end record.
  expect(at + u32(out, out.length - 22 + 12)).toBe(out.length - 22);
});

test("each entry's recorded offset lands on its own local header", () => {
  const files = [
    { name: "first.png", data: new Uint8Array(40).fill(7) },
    { name: "second.png", data: new Uint8Array(9).fill(3) },
    { name: "third.png", data: new Uint8Array(1) },
  ];
  const out = zip(files, AT);
  let at = u32(out, out.length - 22 + 16);
  for (let i = 0; i < files.length; i++) {
    const localAt = u32(out, at + 42);
    expect(u32(out, localAt), files[i]!.name).toBe(0x04034b50);
    // The name in the local header matches the one in the directory.
    const nameLength = u16(out, localAt + 26);
    const name = new TextDecoder().decode(out.subarray(localAt + 30, localAt + 30 + nameLength));
    expect(name).toBe(files[i]!.name);
    // And the bytes that follow it are the file's own.
    const data = out.subarray(localAt + 30 + nameLength, localAt + 30 + nameLength + files[i]!.data.length);
    expect([...data]).toEqual([...files[i]!.data]);
    at += 46 + nameLength;
  }
});

test("stored entries record equal compressed and uncompressed sizes", () => {
  // Anything else and a reader tries to inflate bytes that were never deflated.
  const data = new Uint8Array(1234).fill(9);
  const out = zip([{ name: "p.png", data }], AT);
  expect(u16(out, 8)).toBe(0); // method 0 = stored
  expect(u32(out, 18)).toBe(1234);
  expect(u32(out, 22)).toBe(1234);
});

test("the CRC matches the known value for a standard input", () => {
  // "123456789" has a documented CRC-32 of 0xCBF43926; getting this wrong
  // produces an archive every reader rejects as corrupt.
  const out = zip([{ name: "c", data: bytes("123456789") }], AT);
  expect(u32(out, 14) >>> 0).toBe(0xcbf43926);
});

test("an empty archive is still a valid one", () => {
  const out = zip([], AT);
  expect(out.length).toBe(22);
  expect(u32(out, 0)).toBe(0x06054b50);
  expect(u16(out, 8)).toBe(0);
});

test("the timestamp is the caller's, in DOS form", () => {
  const out = zip([{ name: "a", data: bytes("x") }], AT);
  // 2026-08-19 14:30:20 → date ((2026-1980)<<9)|(8<<5)|19, time (14<<11)|(30<<5)|10
  expect(u16(out, 12)).toBe(((2026 - 1980) << 9) | (8 << 5) | 19);
  expect(u16(out, 10)).toBe((14 << 11) | (30 << 5) | 10);
});

test("a non-ASCII name is refused rather than written unflagged", () => {
  // The UTF-8 flag is not set, so a reader would guess a code page. Better to
  // refuse than to produce an archive whose names are wrong somewhere else.
  expect(() => zip([{ name: "धाका.png", data: bytes("x") }], AT)).toThrow(/ASCII/);
});

test("more entries than the format can count is refused", () => {
  const many = Array.from({ length: 65536 }, (_, i) => ({
    name: `f${i}`,
    data: new Uint8Array(0),
  }));
  expect(() => zip(many, AT)).toThrow(/65535/);
});
