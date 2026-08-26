/**
 * Glyph atlas: every cluster the text needs, rasterized once into one texture.
 *
 * This is what makes text-art video realtime. The Canvas 2D path calls
 * `fillText` per cell — tens of thousands of shaped draws per frame — while the
 * shader does a single texture lookup per fragment against a sheet that was
 * built once and reused until the text, font or step count changes.
 *
 * Needs a canvas, so it stays out of `src/core`.
 */

/** Beyond this the atlas grid outgrows what a single 8-bit index can address. */
export const MAX_GLYPHS = 255;

export interface GlyphAtlas {
  canvas: HTMLCanvasElement;
  /** Cells across, and down — the sheet is square. */
  grid: number;
  /** One cell's side in pixels. */
  cell: number;
  /**
   * A cell's side as a fraction of the sheet. **Not** `1 / grid`: the sheet is
   * rounded up to a power of two, so eight glyphs in a 3×3 grid occupy 192px of
   * a 256px sheet. Dividing UVs by the grid count instead stretches every
   * lookup by 256/192 and samples the gaps between glyphs.
   */
  cellUV: number;
  /** Atlas cell for each cluster, by the cluster itself. */
  indexOf: Map<string, number>;
  /** Clusters in atlas order, so callers can map their own ordering onto it. */
  clusters: string[];
  /**
   * Half of each glyph's ink width, as a fraction of its atlas cell, by slot.
   *
   * The shader needs it to know how far a cell may nudge its glyph before the
   * ink leaves the tile — past that the sample either falls in the gap around
   * the glyph, which clips it, or lands in the neighbouring slot and draws a
   * different letter entirely. Measured here because this is where the
   * rasterization size lives.
   */
  halfInk: Float32Array;
}

function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

/**
 * `cell` is the rasterization size, not the display size — the shader scales
 * whatever it finds. 64 is enough that a dense conjunct stays legible when a
 * block is larger than that on screen, without making the sheet enormous.
 */
export function buildAtlas(
  clusters: readonly string[],
  fontFamily: string,
  cell = 64,
): GlyphAtlas {
  const unique: string[] = [];
  const indexOf = new Map<string, number>();
  for (const cluster of clusters) {
    // Blank cells draw nothing, so they never earn an atlas slot.
    if (cluster.trim() === "" || indexOf.has(cluster)) continue;
    if (unique.length >= MAX_GLYPHS) break;
    indexOf.set(cluster, unique.length);
    unique.push(cluster);
  }

  const grid = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, unique.length))));
  // Power-of-two dimensions: mipmapping and wrapping both want them, and the
  // cost of rounding up is a few unused cells.
  const size = nextPowerOfTwo(grid * cell);

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not get a 2D context for the glyph atlas");

  // White on transparent: the shader reads alpha as an ink mask and takes the
  // colour from the palette, exactly as the Canvas 2D path does.
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${cell * 0.8}px ${fontFamily}`;

  const halfInk = new Float32Array(unique.length);
  unique.forEach((cluster, index) => {
    const x = (index % grid) * cell;
    const y = Math.floor(index / grid) * cell;
    // 0.55 of cell height, matching the Canvas 2D path — the shirorekha sits
    // high in the em box and a truly centred glyph rides low.
    ctx.fillText(cluster, x + cell / 2, y + cell * 0.55);
    const m = ctx.measureText(cluster);
    // Measured against the same context that just drew it, so the number
    // describes the pixels actually in the sheet rather than a second guess at
    // them. Half-width, because the glyph is centred and what matters is its
    // reach either side of the anchor.
    halfInk[index] = Math.min(
      0.5,
      (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) / 2 / cell,
    );
  });

  return { canvas, grid, cell, cellUV: cell / size, indexOf, clusters: unique, halfInk };
}

/**
 * Atlas slot per ramp rung, for the shader's density-rank lookup. A rung whose
 * cluster is blank maps to -1, meaning "draw nothing".
 */
export function rampToAtlas(ramp: readonly string[], atlas: GlyphAtlas): Float32Array {
  return Float32Array.from(ramp, (cluster) => atlas.indexOf.get(cluster) ?? -1);
}

/**
 * Flow's per-cell buffer as an 8-bit data texture payload: which atlas cell
 * belongs in which grid cell. Wrapping and word breaking are sequential, so
 * this is computed on the CPU by nature rather than by preference.
 *
 * 255 marks an empty cell, which is why the atlas caps one below that.
 */
export function flowToTexture(
  cells: Int32Array,
  clusters: readonly string[],
  atlas: GlyphAtlas,
): Uint8Array {
  const data = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const which = cells[i]!;
    const cluster = which >= 0 ? clusters[which] : undefined;
    const slot = cluster === undefined ? undefined : atlas.indexOf.get(cluster);
    data[i] = slot === undefined ? 255 : slot;
  }
  return data;
}
