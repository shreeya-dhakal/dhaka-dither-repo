/**
 * Rotatable dot screen.
 *
 * Halftone leaves the index/palette path alone: tone is carried by dot *area*,
 * not by a quantization level, so there is nothing to map. It draws at output
 * resolution rather than at the working grid, which is what keeps the dots
 * round instead of stair-stepped — the working grid is only ever sampled.
 *
 * One consequence the UI has to surface rather than swallow: `levels` does
 * nothing here, and renders disabled with a reason. The ink is this mode's own,
 * never duo's — which is why Mono and Duo produce the same picture, and why
 * only Color changes anything.
 */

import type { Rgb } from "../core/palette.ts";
import type { ParamSet } from "../params.ts";

/**
 * One ink on its own turn of the screen.
 *
 * `values` is read at `stride`, so the colour path screens the working grid's
 * packed RGB buffer in place rather than splitting it into three planes. Ink
 * density is the *complement* of the value: a channel at 0 takes full ink.
 */
export interface HalftoneScreen {
  values: Float32Array;
  stride: number;
  /** Which component within the stride this ink screens. */
  offset: number;
  ink: Rgb;
  /** Degrees added to the user's angle, so that control turns the whole rosette. */
  turn: number;
}

/**
 * The subtractive primaries, each screening the complement of one RGB channel.
 *
 * The 30° separation between inks is what suppresses moiré, and yellow takes
 * the turn nearest 0° because it is the least visually disruptive of the three.
 * Which of cyan and magenta takes 30° is a free choice — the spec pins only
 * yellow — but it must not become a *random* choice: swapping them rotates
 * every rosette in every existing export.
 */
const CMY = [
  { offset: 2, ink: { r: 255, g: 255, b: 0 }, turn: 0 },
  { offset: 0, ink: { r: 0, g: 255, b: 255 }, turn: 30 },
  { offset: 1, ink: { r: 255, g: 0, b: 255 }, turn: 60 },
] as const;

/** The three screens for colour mode, reading the packed working grid directly. */
export function colorScreens(rgba: Float32Array): HalftoneScreen[] {
  return CMY.map(({ offset, ink, turn }) => ({ values: rgba, stride: 4, offset, ink, turn }));
}

function css({ r, g, b }: Rgb): string {
  return `rgb(${r} ${g} ${b})`;
}

export function paintHalftone(
  screens: readonly HalftoneScreen[],
  w: number,
  h: number,
  params: ParamSet,
  target: HTMLCanvasElement,
  outW: number,
  outH: number,
  scale: number,
): void {
  target.width = outW;
  target.height = outH;

  const ctx = target.getContext("2d");
  if (!ctx) throw new Error("could not get a 2D context");

  ctx.clearRect(0, 0, outW, outH);
  // Cutting the lightest tone means no paper at all — the dots float on
  // transparency, which is what makes the export usable over another layer.
  if (!params.cutLightest) {
    ctx.fillStyle = css(params.halftonePaper);
    ctx.fillRect(0, 0, outW, outH);
  }

  const cell = Math.max(1, params.halftoneCell * scale);
  const cx = outW / 2;
  const cy = outH / 2;
  const reach = Math.hypot(outW, outH) / 2 + cell;

  // Multiply is what makes overlapping inks subtract the way real ones do: full
  // cyan over full magenta is blue, where source-over would just paint the last
  // one down. Left at source-over for a single ink, so that path stays exactly
  // what it was — against opaque paper the two agree anyway, but not against
  // the transparency cut-out leaves behind.
  if (screens.length > 1) ctx.globalCompositeOperation = "multiply";

  for (const screen of screens) {
    const angle = ((params.halftoneAngle + screen.turn) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Draw in the screen's own rotated frame: the lattice stays axis-aligned
    // and only the sampling coordinate has to be rotated back into image space.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = css(screen.ink);
    ctx.beginPath();

    for (let v = -reach; v <= reach; v += cell) {
      for (let u = -reach; u <= reach; u += cell) {
        const x = cx + u * cos - v * sin;
        const y = cy + u * sin + v * cos;
        if (x < -cell || x > outW + cell || y < -cell || y > outH + cell) continue;

        const gx = Math.min(w - 1, Math.max(0, Math.floor((x / outW) * w)));
        const gy = Math.min(h - 1, Math.max(0, Math.floor((y / outH) * h)));
        const value = screen.values[(gy * w + gx) * screen.stride + screen.offset]! / 255;

        // Dot *area* tracks ink density, so the radius goes as its square root.
        const radius = (cell / 2) * Math.sqrt(Math.max(0, 1 - value));
        if (radius < 0.05) continue;

        switch (params.halftoneShape) {
          case "circle":
            ctx.moveTo(u + radius, v);
            ctx.arc(u, v, radius, 0, Math.PI * 2);
            break;
          case "square":
            ctx.rect(u - radius, v - radius, radius * 2, radius * 2);
            break;
          case "line":
            // A line screen modulates bar thickness, not dot size, so the cell
            // stays fully covered along u and only v varies.
            ctx.rect(u - cell / 2, v - radius, cell, radius * 2);
            break;
        }
      }
    }

    // One path, one fill per ink: a fill per dot is thousands of state changes
    // a frame, and with multiply it would also compound overlaps within an ink.
    ctx.fill();
    ctx.restore();
  }

  ctx.globalCompositeOperation = "source-over";
}
