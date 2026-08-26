/**
 * The interface's strings, and the source of the key set.
 *
 * One catalog, one language. The indirection stays even with nothing to switch
 * between: every label lives here rather than in the markup, so wording can be
 * reviewed and changed in one file instead of hunted through `index.html`, and
 * `MessageKey` keeps a typo in a `data-i18n` attribute a compile error rather
 * than a blank label at runtime.
 *
 * `{n}` slots interpolate; sentences are never assembled by concatenation.
 * That rule outlived its original reason — it was there because Nepali is SOV —
 * and is kept because a sentence built from fragments is untranslatable and
 * hard to read wherever it lands.
 */

export const en = {
  "app.title": "Dhaka",
  "app.subtitle": "धाका",
  "app.documentTitle": "Dhaka — dithering studio",

  "group.effect": "Effect",
  "group.tone": "Tone",
  "group.ink": "Ink",
  "group.motion": "Animation",
  "group.hover": "Pointer",
  "group.video": "Video",
  "group.export": "Export",

  "image.open": "Open image or video…",
  "image.failed": "That file could not be opened: {reason}",
  "stage.empty": "Drop an image here, or open one from the rail.",

  "effect.algorithm": "Algorithm",
  "effect.pixelSize": "Pixel size",
  "effect.levels": "Tones",
  "effect.serpentine": "Serpentine scan",
  "effect.patternStrength": "Pattern strength",
  "effect.bayerSize": "Matrix",
  "effect.thresholdBias": "Threshold bias",
  "effect.halftoneCell": "Cell",
  "effect.halftoneAngle": "Angle",
  "effect.halftoneShape": "Shape",
  "effect.halftoneInk": "Ink / paper",

  "family.errorDiffusion": "Error diffusion",
  "family.ordered": "Ordered",
  "family.screen": "Screen",

  "algo.floyd-steinberg": "Floyd–Steinberg",
  "algo.atkinson": "Atkinson",
  "algo.jarvis": "Jarvis–Judice–Ninke",
  "algo.stucki": "Stucki",
  "algo.burkes": "Burkes",
  "algo.sierra": "Sierra",
  "algo.sierra-lite": "Sierra Lite",
  "algo.bayer": "Bayer",
  "algo.blue-noise": "Blue noise",
  "algo.white-noise": "White noise",
  "algo.threshold": "Threshold",
  "algo.halftone": "Halftone",

  "shape.circle": "Circle",
  "shape.square": "Square",
  "shape.line": "Line",

  "motion.mode": "Animation",
  "motion.amount": "Amount",
  "motion.speed": "Speed",
  "motion.none": "None",
  "motion.breathe": "Breathe",
  "motion.pulse": "Pulse",
  "motion.wave": "Wave",
  "motion.spiral": "Spiral",
  "motion.rain": "Rain",
  "motion.ripple": "Ripple",
  "motion.sparkle": "Sparkle",
  "motion.cellular": "Cellular",
  "motion.stillNote":
    "A still has no clock of its own, so the preview runs one. The PNG captures whatever instant you export on.",

  "hover.mode": "Pointer effect",
  "hover.radius": "Reach",
  "hover.strength": "Strength",
  "hover.none": "None",
  "hover.flashlight": "Flashlight",
  "hover.magnifier": "Magnifier",
  "hover.neon": "Neon",
  "hover.ice": "Ice",
  "hover.gravity": "Gravity",
  "hover.note":
    "Move the pointer over the picture. A PNG exports exactly what is on screen, at the position the pointer was last in.",
  "hover.videoNote":
    "Pointer effects are for photos. A video export has no pointer, and a frame would render differently every time.",

  "reason.paletteLevels": "Each level is one swatch, so the strip sets the tone count.",
  "reason.halftoneLevels": "Halftone carries tone in dot area.",
  "reason.halftoneMode":
    "Halftone has its own ink pair, so Mono and Duo look the same. Color screens each channel on its own rotated screen.",

  "group.text": "Text",
  "text.mode": "Character art",
  "textmode.off": "Off",
  "textmode.ramp": "Density",
  "text.content": "Text",
  "text.font": "Font",
  "font.devanagari": "Devanagari",
  "font.mono": "Latin mono",
  // Script names in English, like "Devanagari" beside it. The face itself is
  // still Nithya Ranjana and still renders Ranjana — only the label changed.
  "font.ranjana": "Ranjana",
  "text.varnamala": "Add the varnamala",
  "text.ranjanaNote":
    "Ranjana is written with Devanagari letters, so type as you normally would. The face covers 45 of them; anything else is skipped rather than drawn in another alphabet.",
  "text.glyphSteps": "Glyph steps",
  "text.effectiveSteps": "{n} in use",
  "text.skipped": "{n} characters skipped — the selected font does not cover them.",
  "text.glow": "Glow",
  "reason.glowCpu":
    "Glow is painted on the CPU, so an export at this setting renders more slowly than one without it.",
  "textmode.flow": "Flow",
  "flow.weight": "Weight",
  "flow.size": "Size",
  "flow.opacity": "Opacity",
  "flow.wordGap": "Word gap",
  "flow.keepWords": "Keep words whole",
  "flow.fit": "Fit",
  "fit.repeat": "Repeat",
  "fit.stretch": "Stretch once",
  "flow.truncated": "{n} clusters not shown — the grid is too small.",
  "flow.fill": "{n}% of the grid filled",
  "flow.suggest": "fills the frame at pixel size {n}",
  "video.play": "Play",
  "video.playFailed": "Could not play this file here: {reason}",
  "video.pause": "Pause",
  "video.failed": "Export failed: {reason}",
  "video.fallback": "Used the slower path, because this codec is not available to WebCodecs.",
  "video.export": "Export video",
  "video.cancel": "Cancel",
  "video.progress": "Frame {n} of {total}",
  "video.info": "{w}×{h}, {frames} frames, {fps} fps",
  "video.audioKept": "The sound is carried through unchanged.",
  "video.audioDropped": "This container cannot carry the source audio.",
  "video.scrubAt": "{n} s of {total} — frame {frame}",
  "video.noScrub": "Scrubbing is off for this file: its codec plays but will not decode on demand, and seeking it freezes the picture. Play still works, and so does export.",
  "video.smoothing": "Temporal smoothing",
  "video.unstable": "Error diffusion is not stable frame to frame — one pixel of movement rewrites the whole pattern, so the picture boils. That is sometimes what you want. Smoothing takes the edge off it; blue noise avoids it entirely.",
  "video.short": "Only {n} of {total} frames were encoded — the file is shorter than the source. Please report this with the video's codec.",
  "video.done": "Export finished.",
  "textmode.braille": "Braille",
  "braille.dotRadius": "Dot size",
  "braille.dotSpacing": "Dot spacing",
  "braille.bharati": "Bharati Braille (approximate)",
  "braille.approximate": "The Bharati mapping is approximate — vowel signs are dropped and a conjunct takes its first consonant. Decorative, not valid for a braille reader.",
  "braille.coverage": "{n} of {total} aksharas mapped",
  "reason.brailleLevels": "Braille dots are on or off, so the mode is always 1-bit.",
  "reason.brailleColor": "Braille is ink on paper, so Color is unavailable.",
  "text.cellAspect": "Cell ratio",
  "note.rampScrambles": "Your text is used as a set of shapes here, ranked by how much ink each one carries — the picture is built by matching each cell's tone to a shape. It will not read as words. Choose Flow for that.",
  "note.flowReads": "Your text runs across the picture in order, so it stays legible. Tone reaches the eye through weight, size and opacity instead.",
  "note.rampColor": "In density mode the glyph carries the tone and colour carries only hue, so a greyscale image looks the same as mono.",
  "text.copy": "Copy as text",
  "text.copyWarning": "Only aligns in a proportional-safe context for Latin; for Devanagari the PNG is the real artifact.",
  "text.defaultContent": "धाका",

  "tone.brightness": "Brightness",
  "tone.contrast": "Contrast",
  "tone.gamma": "Gamma",
  "tone.invert": "Invert",

  "ink.mode": "Mode",
  "ink.duoColors": "Dark / light",
  "ink.cutLightest": "Cut out lightest tone",
  "mode.mono": "Mono",
  "mode.duo": "Duo",
  "mode.color": "Color",

  "mode.palette": "Palette",
  "ink.palette": "Strip",
  "ink.paletteUpload": "Load a strip image…",
  "ink.paletteNote": "The tone count follows the strip, because each level is one swatch. Load any image: its pixels become the swatches, left to right, sorted from dark to light.",
  "palette.gameboy": "Game Boy",
  "palette.cga": "CGA",
  "palette.nepal": "Nepal",
  "palette.custom": "Loaded strip {n}",
  "palette.failed": "That image could not be read as a strip.",

  "group.presets": "Presets",
  "preset.saved": "Saved",
  "preset.save": "Save these settings",
  "preset.copyLink": "Copy a link to these settings",
  "preset.import": "Open a preset file…",
  "preset.export": "Save presets to a file",
  "preset.none": "None saved yet",
  "preset.linkCopied": "Link copied. It carries the settings only — never your picture.",
  "preset.linkFailed": "The clipboard refused. The link is in the address bar.",
  "preset.savedAs": "Saved as {name}.",
  "preset.needsName": "Give the preset a name first.",
  "preset.imported": "{n} presets opened.",
  "preset.importFailed": "That file could not be read: {reason}",

  "export.scale": "Scale",
  "export.scaleOriginal": "{n}× original size",
  "export.scaleMultiple": "{n}×",
  "export.ladder": "Export every pixel size",
  "export.ladderCancel": "Stop saving",
  "export.ladderNote": "Renders the picture at every pixel size that produces a different result, and saves them together as one zip.",
  "export.ladderProgress": "Saving pixel size {n} — {done} of {total}",
  "export.ladderDone": "{n} sizes saved to one zip. {skipped} were skipped — they land on the same grid as the size before them and would have been identical.",
  "export.ladderStopped": "Stopped after {n} sizes; those are in the zip.",
  "export.ladderFailed": "Saving stopped at pixel size {n}: {reason}",
  "export.png": "Export PNG",
} as const;

export type MessageKey = keyof typeof en;
