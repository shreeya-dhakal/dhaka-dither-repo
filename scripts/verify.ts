/**
 * Runs `verify.html` in a pinned Chromium and fails the build if any check
 * fails.
 *
 * These properties cannot live in vitest: they need real font loading, real
 * canvas rasterization, and a real WebGL2 context. Node has none of them.
 *
 * The browser is Playwright's pinned Chromium rather than whatever Chrome the
 * machine happens to have, for the same reason the fonts are committed: an
 * unpinned browser is an unpinned input. Chrome 151 shipping without `ne`
 * locale data was the last reminder of what that costs.
 *
 * A caveat worth keeping in mind rather than designing around: the pinned
 * Chromium is *not* the user's browser, and may carry ICU data a real install
 * lacks. This proves the code works, never that every browser has the data.
 * Nothing may assume locale data exists — pass what you need in the options bag.
 */

import { chromium } from "playwright";
import { createServer } from "vite";

// `vite preview` serves `dist/`, and the harness is deliberately not built into
// it, so this uses the dev server instead.
const server = await createServer({ server: { port: 5179, strictPort: true } });
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();

const failures: string[] = [];
page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") failures.push(`console: ${message.text()}`);
});

await page.goto("http://localhost:5179/verify.html", { waitUntil: "load" });

// The harness flips the title when it is finished; until then it is "loading".
// On a stall, print what it managed before hanging — the harness paints each
// check as it completes, so the last line names where it stopped. Throwing a
// bare timeout discards exactly the information needed to fix it.
try {
  await page.waitForFunction(() => document.title !== "loading", null, { timeout: 60_000 });
} catch {
  const partial = (await page.textContent("#report")) ?? "(nothing reported)";
  console.error(partial.split("\n").slice(-6).join("\n"));
  for (const failure of failures) console.error(failure);
  console.error("\nverify.html stalled — the last line above is where it stopped");
  await browser.close();
  await server.close();
  process.exit(1);
}

const title = await page.title();
const report = await page.textContent("#report");
console.log(report?.trim() ?? "(no report)");

await browser.close();
await server.close();

if (title === "FAILED" || failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error("\nverify.html reported failures");
  process.exit(1);
}

console.log(`\nbrowser checks passed (pinned Chromium ${chromium.name()})`);
