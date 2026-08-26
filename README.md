# धाका · Dhaka

**Dhaka** is the Nepali handwoven textile, popular for its patterns that are built from discrete units on a grid, which is exactly what dithering does: it builds the appearance of continuous tone out of a small number of marks placed on a fixed lattice.

A browser-only studio that turns photos and video into dithered, halftoned and text-rendered images.

**Nothing is uploaded.** No server, no account, no analytics. Your picture never leaves the machine — the whole pipeline runs in the tab, and the fonts and noise masks are committed to the repo so it works with the network off.


## What it does

- **Seven error-diffusion kernels** — Floyd–Steinberg, Atkinson, Jarvis–Judice–Ninke, Stucki, Burkes, Sierra, Sierra Lite — plus ordered dithering (Bayer, blue noise, white noise), a plain threshold, and a rotatable halftone screen with circle, square and line dots.
- **Colour** — mono, duotone, per-channel colour, and palette strips (Game Boy, CGA, a Nepali-flag set, or any image you load). Colour halftone screens each channel on its own rotated screen and composites them like real ink.
- **Character art** — the picture rendered out of text you type, in Devanagari, Latin or Ranjana. Density mode picks a glyph per cell by measured ink coverage; flow mode lays your sentence across the grid and modulates its weight, size and opacity.
- **Braille** — a genuine sub-cell dither at 2×4 samples per cell, with an optional Bharati Braille mapping (labelled approximate, and it means it).
- **Glow** — a halo on every drawn mark, sized from the cell so a look survives a change of pixel size. One control across density, flow and braille, because all three draw marks on the same lattice. The halo is deliberately tighter than a cell: each character carries its own, rather than the separate halos merging into one field where whichever region of the picture is densest appears to light up. Where the ink is lighter than its ground the halo adds light, which is what makes the character read as a source rather than a smudge; dark ink on pale paper emits nothing, so there it stays an ordinary halo — ink bleeding into the page. For the phosphor look, pair it with Duo and a dark paper. Braille glows by the same rules through a different mechanism — its dots are one path and one fill, where a shadow is cheaper than a layer.
- **Video** — the same pipeline over every frame, exported as a real MP4 with the original audio carried through untouched.
- **Animation** — eight time-varying tone fields: Breathe, Pulse, Wave, Spiral, Rain, Ripple, Sparkle, Cellular.
- **Pointer effects** — Flashlight, Magnifier, Neon, Ice, Gravity, for photos.
- **Presets and links** — every setting fits in the address bar, so a look is a URL you can paste to someone. The link carries settings only, never your picture and never your text.

The interface is a phosphor terminal — green on a dark tube, scanlines across the
rail, hard edges throughout. The raster and the bloom stop at the chrome: nothing
is laid over the canvas, and no filter or tint touches it, so what is on screen is
exactly what a PNG export contains.

## Running it

```bash
npm install
npm run dev      # vite dev server
```

```bash
npm test              # typecheck + unit tests + the browser harness
npm run test:unit     # just the fast ones
npm run build         # → dist/, works from any static file server
npm run build:single  # → dist/dhaka.html, one file you can just open
npm run smoke         # proves src/core runs under plain Node
```

## Why grapheme clusters

Text is segmented with `Intl.Segmenter`, never `[...str]` or `.split("")`.

A Devanagari conjunct like **क्षि** is one written unit made of several codepoints. Splitting by code unit tears matras and viramas off the consonant they belong to, and the grid fills with broken pieces of letters instead of characters. The same applies to emoji sequences and anything else with combining marks — grapheme clusters are the only unit that survives being placed one-per-cell.

This is the whole reason the project exists rather than reaching for an existing library.

## Licence

MIT — see [LICENSE](LICENSE).

The bundled fonts are **SIL Open Font License 1.1** and carry their own licence text beside them in `public/fonts/`:

- **Noto Sans Devanagari** — Google Fonts
- **IBM Plex Mono** — IBM
- **Nithya Ranjana** — [Ek Type](https://www.ektype.in), developed with [Callijatra](https://www.callijatra.com). It is the reason the Ranjana feature exists.
