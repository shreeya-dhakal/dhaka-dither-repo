/**
 * Build a tonal ladder from a glyph set.
 *
 * Pure: it takes clusters that have already been measured and returns the
 * ladder, so the ordering logic is unit tested even though the measuring needs
 * a canvas.
 *
 * The result runs **darkest first**, matching level indices — index 0 is the
 * densest cluster and the last rung is always a space, so a white cell renders
 * as nothing at all.
 */

export interface MeasuredCluster {
  cluster: string;
  density: number;
  /**
   * False when the bundled fonts do not cover the cluster and a system face
   * supplied the glyph. Such a cluster is dropped: it paints differently from
   * machine to machine, so keeping it at any density still produces different
   * output from the same text. Absent means supported.
   */
  supported?: boolean;
}

/** The lightest rung is always blank, so the brightest parts of the image drop out. */
export const BLANK = " ";

/**
 * Pick `count` entries spread evenly across `list`, endpoints included. With
 * `count <= list.length` consecutive picks are at least one index apart, so no
 * entry is ever chosen twice.
 */
function evenlySpaced<T>(list: readonly T[], count: number): T[] {
  if (count >= list.length) return [...list];
  if (count <= 1) return list.length > 0 ? [list[0]!] : [];
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    out.push(list[Math.round((i * (list.length - 1)) / (count - 1))]!);
  }
  return out;
}

/**
 * `steps` is a request, not a promise. A ladder cannot have more rungs than the
 * user's text has distinct characters, so it clamps — typing "नेपाल" with the
 * glyph-steps control at 12 gives the rungs that actually exist rather than
 * repeating characters to pad the count. The UI shows the effective number.
 */
export function buildRamp(measured: readonly MeasuredCluster[], steps: number): string[] {
  const byCluster = new Map<string, number>();
  for (const { cluster, density, supported } of measured) {
    if (supported === false) continue;
    // Whitespace never earns an ink rung; the blank is appended below.
    if (cluster.trim() === "") continue;
    if (!byCluster.has(cluster)) byCluster.set(cluster, density);
  }

  const sorted = [...byCluster]
    .map(([cluster, density]) => ({ cluster, density }))
    // Densest first. Ties break on the cluster so the ladder is deterministic
    // rather than dependent on insertion order.
    .sort((a, b) => b.density - a.density || (a.cluster < b.cluster ? -1 : 1));

  const inkRungs = Math.max(1, Math.min(steps - 1, sorted.length));
  const ink = evenlySpaced(sorted, inkRungs).map((entry) => entry.cluster);
  return [...ink, BLANK];
}

/** What the ramp will actually contain, for the UI to display next to the control. */
export function effectiveSteps(measured: readonly MeasuredCluster[], steps: number): number {
  const distinctInk = new Set(
    measured.filter((m) => m.cluster.trim() !== "" && m.supported !== false).map((m) => m.cluster),
  ).size;
  if (distinctInk === 0) return 1;
  return Math.max(1, Math.min(steps - 1, distinctInk)) + 1;
}

/** Distinct clusters dropped for want of a bundled glyph, for the UI to report. */
export function skippedClusters(measured: readonly MeasuredCluster[]): number {
  return new Set(
    measured.filter((m) => m.supported === false && m.cluster.trim() !== "").map((m) => m.cluster),
  ).size;
}
