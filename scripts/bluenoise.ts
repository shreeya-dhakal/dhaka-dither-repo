/**
 * Void-and-cluster blue-noise mask generator (Ulichney, 1993).
 *
 * Emits `public/masks/bluenoise64.bin`: 64×64 bytes, one 8-bit threshold rank
 * per cell, row-major. Run once with `npm run bluenoise`; the output is
 * committed. Nothing in `src/` runs this — core receives the bytes as a
 * `Uint8Array` argument and never loads a file.
 *
 * Why blue noise: like Bayer it is position-deterministic, so video does not
 * boil frame to frame, but it has no visible crosshatch regularity.
 *
 * The generator is seeded and deterministic — rerunning it must reproduce the
 * committed file byte for byte, or the GPU/CPU parity test at step 8 has no
 * fixed ground to stand on.
 */

import { mkdirSync, writeFileSync } from "node:fs";

const SIZE = 64;
const N = SIZE * SIZE;
const SIGMA = 1.5;
const RADIUS = 6; // ~4σ; beyond this the Gaussian contributes nothing measurable
const INITIAL_ONES = Math.round(N / 10);
const SEED = 0x64686b61; // "dhka"
const OUT_DIR = "public/masks";
const OUT_FILE = `${OUT_DIR}/bluenoise64.bin`;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian taps as flat [dx, dy, weight] triples, built once. */
const taps: [number, number, number][] = [];
for (let dy = -RADIUS; dy <= RADIUS; dy++) {
  for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    taps.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA))]);
  }
}

/** Add (`sign` 1) or remove (`sign` -1) one cell's contribution. Wraps toroidally. */
function stamp(energy: Float64Array, i: number, sign: number): void {
  const x = i % SIZE;
  const y = (i / SIZE) | 0;
  for (const [dx, dy, w] of taps) {
    const ex = (x + dx + SIZE) % SIZE;
    const ey = (y + dy + SIZE) % SIZE;
    energy[ey * SIZE + ex]! += sign * w;
  }
}

/** Energy field contributed by every cell equal to `want`. */
function energyOf(pattern: Uint8Array, want: number): Float64Array {
  const energy = new Float64Array(N);
  for (let i = 0; i < N; i++) if (pattern[i] === want) stamp(energy, i, 1);
  return energy;
}

/** Densest spot among cells equal to `want` — the tightest cluster. */
function densest(pattern: Uint8Array, energy: Float64Array, want: number): number {
  let best = -1;
  let bestE = -Infinity;
  for (let i = 0; i < N; i++) {
    if (pattern[i] === want && energy[i]! > bestE) {
      bestE = energy[i]!;
      best = i;
    }
  }
  return best;
}

/** Emptiest spot among cells equal to `want` — the largest void. */
function sparsest(pattern: Uint8Array, energy: Float64Array, want: number): number {
  let best = -1;
  let bestE = Infinity;
  for (let i = 0; i < N; i++) {
    if (pattern[i] === want && energy[i]! < bestE) {
      bestE = energy[i]!;
      best = i;
    }
  }
  return best;
}

/**
 * Scatter points at random, then relax: repeatedly move the point from the
 * tightest cluster into the largest void. Converges when the point removed is
 * the one the void wants back, i.e. the arrangement is maximally even.
 */
function buildPrototype(): Uint8Array {
  const rand = mulberry32(SEED);
  const pattern = new Uint8Array(N);
  for (let placed = 0; placed < INITIAL_ONES; ) {
    const i = Math.floor(rand() * N);
    if (!pattern[i]) {
      pattern[i] = 1;
      placed++;
    }
  }

  const energy = energyOf(pattern, 1);
  const limit = N * 10;
  for (let iter = 0; ; iter++) {
    if (iter > limit) throw new Error("void-and-cluster relaxation did not converge");
    const cluster = densest(pattern, energy, 1);
    pattern[cluster] = 0;
    stamp(energy, cluster, -1);

    const void_ = sparsest(pattern, energy, 0);
    if (void_ === cluster) {
      pattern[cluster] = 1;
      stamp(energy, cluster, 1);
      return pattern;
    }
    pattern[void_] = 1;
    stamp(energy, void_, 1);
  }
}

function buildRanks(): Int32Array {
  const prototype = buildPrototype();
  const ranks = new Int32Array(N).fill(-1);

  // Phase 1 — unbuild the prototype. The last point left standing is the most
  // isolated, so it earns rank 0 and survives the harshest threshold.
  let work = prototype.slice();
  let energy = energyOf(work, 1);
  for (let rank = INITIAL_ONES - 1; rank >= 0; rank--) {
    const i = densest(work, energy, 1);
    work[i] = 0;
    stamp(energy, i, -1);
    ranks[i] = rank;
  }

  // Phase 2 — refill from the prototype into successive largest voids, up to
  // half full.
  work = prototype.slice();
  energy = energyOf(work, 1);
  for (let rank = INITIAL_ONES; rank < N / 2; rank++) {
    const i = sparsest(work, energy, 0);
    work[i] = 1;
    stamp(energy, i, 1);
    ranks[i] = rank;
  }

  // Phase 3 — past halfway the minority flips: the zeros are now the sparse
  // set, so keep going against the energy field of the zeros instead.
  energy = energyOf(work, 0);
  for (let rank = N / 2; rank < N; rank++) {
    const i = densest(work, energy, 0);
    work[i] = 1;
    stamp(energy, i, -1);
    ranks[i] = rank;
  }

  const seen = new Set(ranks);
  if (seen.size !== N) throw new Error(`ranks are not a permutation: ${seen.size} distinct of ${N}`);
  return ranks;
}

const ranks = buildRanks();
const mask = new Uint8Array(N);
for (let i = 0; i < N; i++) mask[i] = Math.floor((ranks[i]! * 256) / N);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, mask);

const mean = mask.reduce((a, b) => a + b, 0) / N;
console.log(`wrote ${OUT_FILE} — ${SIZE}×${SIZE}, ${mask.length} bytes, mean ${mean.toFixed(2)}`);
