/**
 * Seam 2: text comes from a provider, also keyed on time.
 *
 * Phase 1 ships `StaticText` — the user's typed string, with nothing active, at
 * every timestamp. Phase 2 ships `LyricText`, which returns the line currently
 * being sung and which akshara is on. The glyph atlas and the flow layout
 * invalidate on `version` either way, so the caching logic never changes: in
 * Phase 1 it bumps on typing, in Phase 2 it bumps per line.
 *
 * Clusters arrive pre-segmented. Segmentation is `src/glyph/segment.ts`'s job
 * and needs `Intl.Segmenter`; this file just carries the result.
 */

export interface TextSlice {
  /** Grapheme clusters, never code units — क + ् + ष is one entry, not three. */
  clusters: string[];
  /** Which cluster is active right now. Always null in Phase 1. */
  activeIndex: number | null;
  /** 0→1 across the active cluster. Always 0 in Phase 1. */
  activeProgress: number;
}

export interface TextSource {
  at(t: number): TextSlice;
  /**
   * Bumps whenever the clusters change. The glyph atlas and the flow layout key
   * their caches off this rather than diffing cluster arrays every frame.
   */
  readonly version: number;
}

export class StaticText implements TextSource {
  private slice: TextSlice;
  private current = 0;

  constructor(clusters: string[] = []) {
    this.slice = { clusters, activeIndex: null, activeProgress: 0 };
  }

  get version(): number {
    return this.current;
  }

  at(_t: number): TextSlice {
    return this.slice;
  }

  /**
   * Identical content does not bump the version: typing a character and
   * deleting it should not force an atlas rebuild.
   */
  setClusters(clusters: string[]): void {
    const previous = this.slice.clusters;
    if (clusters.length === previous.length && clusters.every((c, i) => c === previous[i])) return;
    this.slice = { clusters, activeIndex: null, activeProgress: 0 };
    this.current++;
  }
}
