/**
 * Time-varying tone fields.
 *
 * Every animation is one function of position and time returning a tone offset
 * in [-1, 1], which the caller scales and adds before quantizing. Breathe and
 * Pulse simply ignore position — they are the spatially uniform members of the
 * same family, not a second mechanism — so nothing here needs a modulation
 * matrix and none of it touches Phase 2's `ModulatedParams`.
 *
 * **Position and time in, value out. No state.** A field is evaluated at an
 * arbitrary `t` and must give the same answer every time it is asked, because
 * export derives `t` from the frame index and the timeline may be scrubbed to
 * anywhere. Anything that had to be stepped from frame zero — a cellular
 * *automaton*, say — cannot live here; `cellular` below is Worley noise, which
 * is a closed-form distance field and has no such problem.
 *
 * Coordinates are **normalized to the frame**, not grid indices: a wave has to
 * keep its wavelength when the pixel size changes, and a ripple has to stay
 * round when the frame is not square (the caller passes the aspect).
 */

/** Which field. `none` is the identity and costs nothing to evaluate. */
export type MotionId =
  | "none"
  | "breathe"
  | "pulse"
  | "wave"
  | "spiral"
  | "rain"
  | "ripple"
  | "sparkle"
  | "cellular";

export const MOTION_IDS: readonly MotionId[] = [
  "none",
  "breathe",
  "pulse",
  "wave",
  "spiral",
  "rain",
  "ripple",
  "sparkle",
  "cellular",
];

/**
 * `u` and `v` run 0–1 across the frame, `t` is seconds. The result is a tone
 * offset in [-1, 1] — the caller multiplies by an amount and by 255.
 */
export type MotionField = (u: number, v: number, t: number) => number;

const TAU = Math.PI * 2;

/**
 * The same integer hash `whiteNoiseSource` uses, returning 0–1 rather than an
 * offset. Position-determinism is the whole point: Rain and Sparkle must not
 * depend on how many pixels came before them, or the video boils and two
 * exports of the same clip differ.
 */
export function hash01(x: number, y: number, z: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Positive fractional part. `x % 1` is negative for negative operands. */
function fract(x: number): number {
  return x - Math.floor(x);
}

/**
 * Builds the field for one id.
 *
 * `speed` scales time and nothing else, so it never changes a pattern's shape —
 * only how fast it moves. `aspect` is width ÷ height, used by the fields with a
 * radius so circles stay circular on a non-square frame.
 */
export function motionField(id: MotionId, speed = 1, aspect = 1): MotionField {
  // Radius and angle about the centre, corrected for the frame's proportions.
  // Two functions rather than one returning a pair: these run once per cell per
  // frame, and at pixel size 1 that is once per pixel, where handing back an
  // object costs more than the arithmetic inside it.
  const radius = (u: number, v: number): number => {
    const dx = (u - 0.5) * aspect;
    const dy = v - 0.5;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const angle = (u: number, v: number): number => Math.atan2(v - 0.5, (u - 0.5) * aspect);

  switch (id) {
    case "none":
      return () => 0;

    // Slow and even, never reaching a hard edge: a breath, not a blink.
    case "breathe":
      return (_u, _v, t) => Math.sin(TAU * t * speed * 0.25);

    // Sharp attack, exponential decay, one beat per unit of time. The decay is
    // what makes it read as a pulse rather than as a fast Breathe.
    //
    // Rests at 0, not at -1. Pulse, Rain and Sparkle are *events* — they add
    // light where they fire and leave the rest of the frame alone. Centring
    // them like Breathe would mean the whole picture sat at full black between
    // beats, which is a strobe, not a pulse.
    case "pulse":
      return (_u, _v, t) => Math.exp(-5 * fract(t * speed));

    // A travelling wave. Diagonal rather than axis-aligned, so it does not
    // disappear against the dither grid's own horizontals and verticals.
    case "wave":
      return (u, v, t) => Math.sin(TAU * (u * 2 + v * 0.6 - t * speed * 0.5));

    // Angle and radius together: the arms wind outward instead of merely
    // spinning, which a pure angular term would do.
    case "spiral":
      return (u, v, t) =>
        Math.sin(TAU * ((angle(u, v) / TAU) * 3 + radius(u, v) * 4 - t * speed * 0.5));

    // Rings expanding from the centre, fading with distance so the frame's
    // corners do not strobe as hard as the middle.
    case "ripple":
      return (u, v, t) => {
        const r = radius(u, v);
        return Math.sin(TAU * (r * 6 - t * speed)) * Math.exp(-r * 1.5);
      };

    // Streaks falling down independent columns. The per-column hash is what
    // stops it reading as one solid curtain, and it is a hash of the column
    // index so a given column falls identically in every render.
    case "rain":
      return (u, v, t) => {
        const column = Math.floor(u * 48);
        const phase = hash01(column, 0, 1);
        const speedOfColumn = 0.6 + hash01(column, 1, 2) * 0.8;
        const drop = fract(v - t * speed * speedOfColumn + phase);
        // A short bright head with a tail behind it, rather than a sine: rain
        // has a direction, and a symmetric wave does not show one. An event
        // field, so it rests at 0 — see Pulse.
        return Math.exp(-drop * 12);
      };

    // Per-cell twinkle. Time is quantized into steps and hashed with the cell,
    // so a cell's brightness is a pure function of where and when — never a
    // running random sequence.
    case "sparkle":
      return (u, v, t) => {
        const cx = Math.floor(u * 64);
        const cy = Math.floor(v * 64);
        const step = Math.floor(t * speed * 6);
        const now = hash01(cx, cy, step);
        // Only the top of the range lights, so most cells stay dark and the
        // few that fire actually read as sparks. An event field, resting at 0.
        if (now < 0.92) return 0;
        // Within the step, rise and fall rather than switching on flatly.
        const within = fract(t * speed * 6);
        return Math.sin(Math.PI * within);
      };

    // Worley noise: distance to the nearest of a set of drifting feature
    // points, one per cell of a coarse lattice. Closed form at any `t`, which
    // is what makes it scrub and export like the rest of them.
    case "cellular": {
      // The nine feature points depend on the lattice cell and on `t` — never
      // on where in the cell the sample falls. A cell spans many pixels, so
      // recomputing them per pixel repeated the same eighteen hashes and
      // trig calls across the whole span; memoizing on the cell is a clean
      // 15x and gives bit-identical output.
      //
      // This is a cache, not state: the key covers every input, so the field
      // still answers for an arbitrary `t` and remains safe to scrub and to
      // export out of order.
      const points = new Float64Array(18);
      let haveX = NaN;
      let haveY = NaN;
      let haveT = NaN;
      return (u, v, t) => {
        const scale = 6;
        const x = u * scale * aspect;
        const y = v * scale;
        const gx = Math.floor(x);
        const gy = Math.floor(y);
        if (gx !== haveX || gy !== haveY || t !== haveT) {
          haveX = gx;
          haveY = gy;
          haveT = t;
          let i = 0;
          // The 3×3 neighbourhood is enough: a feature point never leaves its
          // own cell, so nothing outside that ring can be the closest.
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              const cx = gx + ox;
              const cy = gy + oy;
              // Each point drifts on its own little circle, so the pattern
              // moves without any cell ever handing its point to a neighbour.
              points[i++] = cx + 0.5 + 0.35 * Math.sin(TAU * (hash01(cx, cy, 3) + t * speed * 0.2));
              points[i++] = cy + 0.5 + 0.35 * Math.cos(TAU * (hash01(cx, cy, 4) + t * speed * 0.2));
            }
          }
        }
        let nearest = Infinity;
        for (let i = 0; i < 18; i += 2) {
          const dx = (points[i] as number) - x;
          const dy = (points[i + 1] as number) - y;
          // Compared squared; the root is taken once, at the end.
          const d = dx * dx + dy * dy;
          if (d < nearest) nearest = d;
        }
        // Distances run roughly 0 to ~1 within a cell; centre the result so a
        // field at rest averages out to no tone shift.
        return Math.min(1, Math.sqrt(nearest) * 1.6) * 2 - 1;
      };
    }
  }
}
