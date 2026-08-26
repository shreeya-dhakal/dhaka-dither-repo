/**
 * Builds `dist/dhaka.html` — the whole studio as one file you can double-click.
 *
 * `npm run build` produces a normal `dist/`, which works from any static file
 * server and is the right thing to deploy. It does **not** work when opened
 * off the filesystem, and that is a browser rule rather than a bug: a
 * `<script type="module">` is fetched, and every browser blocks a fetch from a
 * `file://` origin as cross-origin. The console says CORS; the page just sits
 * there with no labels on it.
 *
 * So this inlines everything the page would otherwise fetch — the bundle, the
 * four faces, the blue-noise mask — leaving a document with no subresources at
 * all. Nothing to block.
 *
 * It fits the project rather than fighting it: the fonts and masks are already
 * committed so the app works with the network off, and this is the same promise
 * carried one step further.
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { build } from "vite";

const OUT = "dist/dhaka.html";

await build({ logLevel: "warn" });

let html = readFileSync("dist/index.html", "utf8");

/** A file as a `data:` URI, for the CSS that references it. */
function dataUri(path: string, mime: string): string {
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

// 1. The fonts. Their @font-face rules point at ./fonts/*, which under file://
//    resolve to real paths but are still cross-origin to a null origin.
const FACES: [string, string][] = [
  ["./fonts/noto-sans-devanagari-var.woff2", "font/woff2"],
  ["./fonts/ibm-plex-mono-400.woff2", "font/woff2"],
  ["./fonts/ibm-plex-mono-700.woff2", "font/woff2"],
  ["./fonts/nithya-ranjana-du.otf", "font/otf"],
];
for (const [reference, mime] of FACES) {
  const source = `public/${reference.replace("./", "")}`;
  const before = html.length;
  html = html.replaceAll(reference, dataUri(source, mime));
  if (html.length === before) throw new Error(`${reference} is not referenced in dist/index.html`);
}

// 2. The script. Inlined rather than linked, and left as a module because the
//    entry uses top-level await — an inline module never fetches, so nothing is
//    there to block.
const tag = /<script type="module" crossorigin src="([^"]+)"><\/script>/;
const match = html.match(tag);
if (!match) throw new Error("could not find the module script tag in dist/index.html");
const bundle = readFileSync(`dist/${match[1]!.replace("./", "")}`, "utf8");
// `</script>` inside a string literal in the bundle would close the tag early.
html = html.replace(tag, `<script type="module">\n${bundle.replaceAll("</script>", "<\\/script>")}\n</script>`);

// 3. The blue-noise mask, which `main.ts` reads from here in preference to
//    fetching it. Base64 in a script tag the browser will not execute.
const mask = readFileSync("public/masks/bluenoise64.bin").toString("base64");
html = html.replace(
  "</body>",
  `<script type="application/octet-stream" id="blue-noise">${mask}</script>\n</body>`,
);

writeFileSync(OUT, html);

const size = statSync(OUT).size;
console.log(`${OUT}  ${(size / 1_048_576).toFixed(2)} MB — one file, no subresources`);
