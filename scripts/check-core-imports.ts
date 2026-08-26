/**
 * Hard rule 1, second half: `lib: []` stops core from *naming* a DOM type, but
 * nothing in the compiler stops `import { paintCell } from "../render/text.ts"`.
 * This closes that gap.
 *
 * The spec calls for an ESLint `no-restricted-imports` rule. This is the same
 * guarantee without the dependency, and slightly stronger: it rejects any
 * specifier that leaves `src/core`, including bare package imports, rather than
 * a fixed list of sibling directories.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const CORE = resolve("src/core");
const SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

const problems: string[] = [];

for (const name of readdirSync(CORE)) {
  if (!name.endsWith(".ts")) continue;
  const isTest = name.endsWith(".test.ts");
  const file = resolve(CORE, name);

  for (const [, specifier] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
    if (specifier === undefined) continue;

    if (!specifier.startsWith(".")) {
      // Tests are the one exception: they are excluded from the core tsconfig
      // and never ship, so vitest is allowed there and nowhere else.
      if (isTest && specifier === "vitest") continue;
      problems.push(`${name} imports the package "${specifier}"`);
      continue;
    }

    const target = resolve(dirname(file), specifier);
    if (relative(CORE, target).startsWith("..")) {
      problems.push(`${name} imports "${specifier}", which resolves outside src/core`);
    }
  }
}

if (problems.length > 0) {
  console.error("src/core must not import anything outside itself:\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("\nCore has to stay importable from Node. See hard rule 1.");
  process.exit(1);
}

console.log(`src/core is self-contained — ${readdirSync(CORE).length} files checked`);
