/**
 * Pointer-local effects.
 *
 * **Photos only, and preview only.** A hover effect is a live interaction: it
 * has no meaning during an offline video export, where there is no pointer and
 * every frame must render the same way twice. Rather than let it half-work, the
 * feature is confined to stills and the interface says so.
 *
 * The pointer still arrives as ordinary parameters — `pointerU`/`pointerV` on
 * the resolved set — never read from the DOM here or in the renderer. That is
 * hard rule 2, and it is what keeps a still export reproducible: a PNG renders
 * from the same numbers that were on screen.
 *
 * Two mechanisms, both pure functions of position:
 *
 * - **Tone** — Flashlight and Neon add or remove light near the pointer.
 * - **Displacement** — Magnifier, Gravity and Ice change *where* the image is
 *   sampled. A magnifier is a lens, not a finer grid: it displaces the sample
 *   coordinate inward so the picture under it grows. The dither lattice stays
 *   the size it was, which is the honest behaviour — it magnifies the photo,
 *   not the print.
 */

import { hash01 } from "./motion.ts";

/** Which pointer effect. `none` is the identity. */
export type HoverId = "none" | "flashlight" | "magnifier" | "neon" | "ice" | "gravity";

export const HOVER_IDS: readonly HoverId[] = [
  "none",
  "flashlight",
  "magnifier",
  "neon",
  "ice",
  "gravity",
];

/** Everything an effect needs about the pointer, in normalized frame units. */
export interface HoverState {
  id: HoverId;
  /** Pointer position, 0–1 across the frame. */
  u: number;
  v: number;
  /** Reach, 0–1 of the frame's smaller dimension. */
  radius: number;
  /** 0–1. At 0 every effect is the identity, so the control rests without a flag. */
  strength: number;
  /** Width ÷ height, so the reach is a circle rather than an ellipse. */
  aspect: number;
}

/** Which effects move the sampling coordinate rather than the tone. */
export function displaces(id: HoverId): boolean {
  return id === "magnifier" || id === "gravity" || id === "ice";
}

/** Which effects need the working grid's edge map computed first. */
export function needsEdges(id: HoverId): boolean {
  return id === "neon";
}

/**
 * 1 at the pointer falling to 0 at the rim, with a smooth shoulder.
 *
 * Smoothstep rather than a linear ramp: a linear falloff leaves a visible
 * circular seam exactly where the effect ends, which reads as a rendering bug
 * rather than as the edge of a light.
 */
export function falloff(state: HoverState, u: number, v: number): number {
  const dx = (u - state.u) * state.aspect;
  const dy = v - state.v;
  const d = Math.hypot(dx, dy) / Math.max(1e-4, state.radius);
  if (d >= 1) return 0;
  const k = 1 - d;
  return k * k * (3 - 2 * k);
}

/**
 * Where to read the image for the cell at `(u, v)`, in the same normalized
 * units. Returns the input unchanged for the effects that do not displace.
 *
 * The displacement is *inverse*: it answers "which part of the source belongs
 * here", so pulling the sample toward the pointer is what makes the picture
 * appear to grow away from it.
 */
export function hoverSample(state: HoverState, u: number, v: number): { u: number; v: number } {
  if (state.id === "none" || state.strength <= 0 || !displaces(state.id)) return { u, v };

  const k = falloff(state, u, v);
  if (k <= 0) return { u, v };

  const dx = (u - state.u) * state.aspect;
  const dy = v - state.v;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { u: state.u, v: state.v };
  const nx = dx / d;
  const ny = dy / d;

  if (state.id === "magnifier") {
    // Sample from nearer the centre than the cell sits, so what is there
    // spreads outward. Capped below 1 so the lens cannot fold the image
    // through itself at full strength.
    const shrink = 1 - 0.65 * state.strength * k;
    const rd = d * shrink;
    return { u: state.u + (nx * rd) / state.aspect, v: state.v + ny * rd };
  }

  if (state.id === "gravity") {
    // The opposite sign: the picture is dragged *into* the pointer, so the
    // sample for a cell comes from further out than the cell sits.
    const stretch = 1 + 0.9 * state.strength * k;
    const rd = d * stretch;
    return { u: state.u + (nx * rd) / state.aspect, v: state.v + ny * rd };
  }

  // Ice: faceted rather than smooth. The sample snaps to a coarse lattice
  // inside the reach, which fractures the image into flat planes the way a
  // frosted surface does — a smooth displacement would only ripple it.
  //
  // The lattice has to be coarse and the snap has to be allowed to complete.
  // A fine lattice caps the displacement at half a facet, which at any sane
  // frame size is a pixel or two — measurably "working" and invisible on
  // screen, which is the worst of both.
  //
  // Snapping alone is still not enough: it lands every facet back on the same
  // regular grid, so a smooth region maps to a near-identical sample and the
  // picture barely moves. Each facet therefore reads from its own hashed
  // offset, which is what fractures the surface into planes that do not line
  // up. Hashed from the facet, so a given facet breaks the same way in every
  // render rather than crawling.
  const facets = 14;
  const snap = (value: number) => Math.round(value * facets) / facets;
  const fu = Math.floor(u * facets);
  const fv = Math.floor(v * facets);
  const spread = 1.2 / facets;
  const jitterU = (hash01(fu, fv, 11) - 0.5) * spread;
  const jitterV = (hash01(fu, fv, 12) - 0.5) * spread;
  const shard = state.strength * k;
  return {
    u: u + (snap(u) + jitterU - u) * shard,
    v: v + (snap(v) + jitterV - v) * shard,
  };
}

/**
 * Tone offset in [-1, 1] for the cell at `(u, v)`, in the same units the
 * animation fields use — the caller scales it and adds it.
 *
 * `edge` is the local gradient, 0–1, and is only read by Neon. Passing it in
 * rather than computing it here keeps this file free of any notion of a buffer.
 */
export function hoverTone(state: HoverState, u: number, v: number, edge = 0): number {
  if (state.id === "none" || state.strength <= 0) return 0;

  const k = falloff(state, u, v);

  if (state.id === "flashlight") {
    // Lit inside the circle and dimmed outside it, so the beam reads as a beam
    // rather than as a bright patch on an unchanged picture.
    return (k * 2 - 1) * state.strength;
  }

  if (state.id === "neon") {
    if (k <= 0) return 0;
    // Edges light, flats fall away. Both halves are needed: brightening the
    // edges alone just looks like local contrast, and it is the darkened
    // surround that makes the edges read as tubing.
    //
    // Scaled so a full edge reaches exactly 1 rather than overshooting the
    // range every other field promises. Letting it run past would clip at the
    // tone stage instead, which flattens the brightest edges into a solid mass
    // — the opposite of what the effect is for.
    return (edge * 1.6 - 0.6) * k * state.strength;
  }

  return 0;
}
