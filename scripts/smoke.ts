/**
 * Proves the sprite-pipeline reuse claim: core runs under plain `node`, with no
 * browser, no canvas, and no bundler. If this ever fails, something in
 * `src/core` has grown a DOM dependency that the typecheck did not catch.
 */

import { bayerSource } from "../src/core/bayer.ts";
import { errorDiffuseInPlace, ordered } from "../src/core/dither.ts";
import { KERNELS } from "../src/core/kernels.ts";
import { paintMono } from "../src/core/palette.ts";

const W = 8;
const H = 8;
const LEVELS = 2;

const source = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) source[y * W + x] = (x / (W - 1)) * 255;
}

const diffused = errorDiffuseInPlace(source.slice(), W, H, KERNELS["floyd-steinberg"], LEVELS);
const patterned = ordered(source, W, H, bayerSource(4), LEVELS);
const pixels = paintMono(patterned, { levels: LEVELS });

for (const [name, out] of [
  ["error diffusion", diffused],
  ["ordered", patterned],
] as const) {
  if (out.length !== W * H) throw new Error(`${name}: expected ${W * H} indices, got ${out.length}`);
  if (out.some((v) => v >= LEVELS)) throw new Error(`${name}: index outside 0..${LEVELS - 1}`);
  if (out[0] !== 0) throw new Error(`${name}: black end of the ramp did not stay black`);
  if (out[W - 1] !== LEVELS - 1) throw new Error(`${name}: white end of the ramp did not stay white`);
}

if (pixels.length !== W * H * 4) throw new Error(`expected RGBA for ${W * H} pixels`);

console.log(`core runs under plain node — ${W}×${H} ramp dithered to ${LEVELS} levels, both paths`);
