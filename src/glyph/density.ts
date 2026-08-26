/**
 * Ink-coverage measurement.
 *
 * Needs a canvas, so it is kept out of `src/core`. The measurement itself is
 * synchronous — font *readiness* is the async part, and that is a one-time gate
 * at startup rather than a per-cluster await. Getting this order wrong is the
 * classic failure: measure before the webfont loads and you have measured the
 * fallback, producing a tonal ladder that is wrong in a way nothing downstream
 * can detect.
 */

const CELL = 48;
const SIZE = 32;

/**
 * Families that cannot exist, one per generic a real stack might terminate in.
 *
 * One probe is not enough: Chromium picks its last-resort face for a missing
 * glyph based on the generic that ends the list, so a stack ending in
 * `monospace` and a probe ending in `monospace` can still land on *different*
 * faces. Measured in a pinned Chromium, U+2588 and U+2603 matched only the
 * sans-serif probe while U+1F338 and U+6F22 matched both — so a single probe
 * reports the first two as covered, includes them in the ladder, and paints
 * them from a system face that differs machine to machine. Matching any probe
 * means the bundled fonts contributed nothing.
 */
const ABSENT_FAMILIES = [
  '"__dhaka_no_such_family__", monospace',
  '"__dhaka_no_such_family__", sans-serif',
];

let scratch: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();
const supportCache = new Map<string, boolean>();

function context(): CanvasRenderingContext2D {
  if (scratch) return scratch;
  const canvas = document.createElement("canvas");
  canvas.width = CELL;
  canvas.height = CELL;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("could not get a 2D context for density measurement");
  scratch = ctx;
  return ctx;
}

/**
 * Hard rule 4. `document.fonts.ready` alone is not enough: it resolves once the
 * fonts *currently requested* have settled, and a face nothing has drawn with
 * yet has not been requested. Loading each family explicitly is what forces the
 * fetch before the gate.
 */
export async function ensureFontsLoaded(fontSpecs: readonly string[]): Promise<void> {
  await Promise.all(fontSpecs.map((spec) => document.fonts.load(spec, "क्षतिज Dhaka 0")));
  await document.fonts.ready;
  // A face that arrives after something was already measured would leave stale
  // numbers behind, so anything cached before this point is discarded.
  cache.clear();
  supportCache.clear();
}

/**
 * The cluster's alpha plane, rendered once at the measuring size.
 *
 * `centred` is what density wants — the glyph sitting in the middle of its
 * cell. The support probe must **not** centre: centring offsets the draw by the
 * measured advance, and the advance is taken from the font stack, so the same
 * fallback glyph lands a fraction of a pixel apart under two different stacks
 * and the comparison sees hundreds of differing pixels that mean nothing.
 * Drawing from a fixed origin removes that entirely.
 */
function rasterize(cluster: string, fontFamily: string, centred: boolean): Uint8ClampedArray {
  const ctx = context();
  ctx.clearRect(0, 0, CELL, CELL);
  ctx.font = `${SIZE}px ${fontFamily}`;
  ctx.fillStyle = "#fff";
  if (centred) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cluster, CELL / 2, CELL / 2);
  } else {
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(cluster, 4, 38);
  }
  return ctx.getImageData(0, 0, CELL, CELL).data;
}

/**
 * Whether the bundled fonts actually cover this cluster.
 *
 * Render it twice — once in the real stack, once in a family that cannot
 * exist — and compare the pixels. Identical output means both fell through to
 * the same system face, so the glyph is not ours. This matters beyond
 * measurement: a system-fallback glyph *paints* differently from machine to
 * machine, so pinning it to some fixed density would still produce visibly
 * different output from the same text.
 */
export function isSupported(cluster: string, fontFamily: string): boolean {
  if (cluster.trim() === "") return true;
  const key = `${fontFamily} ${cluster}`;
  const hit = supportCache.get(key);
  if (hit !== undefined) return hit;

  const bundled = Uint8ClampedArray.from(rasterize(cluster, fontFamily, false));

  let covered = true;
  for (const probe of ABSENT_FAMILIES) {
    const fallback = rasterize(cluster, probe, false);
    let differs = false;
    for (let i = 3; i < bundled.length; i += 4) {
      if (bundled[i] !== fallback[i]) {
        differs = true;
        break;
      }
    }
    // Identical to any probe means a system face drew it, not ours.
    if (!differs) {
      covered = false;
      break;
    }
  }

  supportCache.set(key, covered);
  return covered;
}

/**
 * Ink coverage in 0–1: the cluster rasterized once and its alpha summed.
 * Cached by font *and* cluster — the same character has different coverage in
 * a different face, which is the whole reason the ladder is measured rather
 * than guessed.
 */
export function measureDensity(cluster: string, fontFamily: string): number {
  const key = `${fontFamily}\0${cluster}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const data = rasterize(cluster, fontFamily, true);
  let ink = 0;
  // Alpha only — every pixel drawn is white, so the alpha channel *is* the
  // coverage. Walk by stride; `i++` here would sum the colour channels too.
  for (let i = 3; i < data.length; i += 4) ink += data[i]!;

  const coverage = ink / (CELL * CELL * 255);
  cache.set(key, coverage);
  return coverage;
}

/**
 * Measure a set in one pass, flagging any cluster the bundled fonts do not
 * cover so the ramp can drop it rather than render it differently on every
 * machine. Order follows the input.
 */
export function measureAll(
  clusters: readonly string[],
  fontFamily: string,
): { cluster: string; density: number; supported: boolean }[] {
  return clusters.map((cluster) => ({
    cluster,
    density: measureDensity(cluster, fontFamily),
    supported: isSupported(cluster, fontFamily),
  }));
}
