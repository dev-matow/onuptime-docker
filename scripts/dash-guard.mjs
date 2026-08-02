#!/usr/bin/env node
/**
 * No em dashes or en dashes on the surfaces a customer reads.
 *
 *   node scripts/dash-guard.mjs           list every occurrence
 *   node scripts/dash-guard.mjs --check   exit non-zero if any remain
 *
 * The rule is a house style, not a correctness property, which is
 * exactly why it needs a machine: style rules that live in someone's
 * head come back one paragraph at a time, and nobody reviewing a
 * marketing diff notices a single U+2014 arriving in a sentence that
 * reads fine. The characters are also invisible in most diffs and
 * indistinguishable from a hyphen at small sizes, so "just look for it"
 * is not a review anybody can actually perform.
 *
 * ── what is covered ─────────────────────────────────────────────────
 *
 * Everything a buyer or an operator reads in the product's own voice:
 * the marketing site, the public documentation, the sales material, and
 * the strings the application renders.
 *
 * ── what is not, and why each one ───────────────────────────────────
 *
 * - **Code comments.** They are the product's voice to whoever is
 *   reading the source, not to a customer, and this repository's
 *   comments are long-form prose where the dash earns its place. The
 *   scanner strips them before looking, rather than the file being
 *   skipped, so a *string* in a heavily commented file is still checked.
 * - **CHANGELOG.md and landing/changelog.html.** A release note is a
 *   record of what was said at the time. Editing the punctuation of
 *   shipped history to satisfy a style rule adopted afterwards is
 *   rewriting the record.
 * - **docs/RELEASE-EVIDENCE.md and docs/evidence/.** Same reason, plus
 *   the evidence files are raw measurement output.
 * - **Generated artefacts** (`public-facts.json`, `kuma-mapping.json`,
 *   `monitor-type-dod.json`), **lockfiles**, **fixtures**, **fonts and
 *   build output**. Not written by hand and not read as prose.
 * - **Tests.** They quote the surfaces they assert on, and a test that
 *   pins the old wording has to be allowed to contain it.
 *
 * `scripts/` is covered, and that is not obvious enough to leave
 * unsaid: a generator is not a customer-facing surface, but its output
 * is. `dod-matrix.mjs` writes a table into `docs/`, `seed-demo.ts`
 * writes the monitor names a demo report prints, and
 * `capture-sample-report.ts` writes the sample on the marketing site.
 * Cleaning the output and leaving the generator alone means the next
 * `npm run dod` puts it all back.
 *
 * A file that is neither covered nor listed above is covered. The
 * default is deliberately the strict one: a new public page should be
 * checked the day it is added, not the day somebody remembers to add it
 * here.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * U+2014 EM DASH and U+2013 EN DASH, written as escapes.
 *
 * Not as literals, and that is load-bearing: this file is covered by its
 * own rule, so a bulk rewrite over the covered set replaced the two
 * characters inside the class with hyphens. `[--]` is a valid regex that
 * matches a hyphen, so the guard went on passing its own check while
 * reporting every hyphen in the repository as a violation. An escape
 * cannot be rewritten by a pass that is looking for the character.
 */
const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const BANNED = new RegExp(`[${EM_DASH}${EN_DASH}]`, "g");

/** Directories never walked at all. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "test-results",
  "coverage",
  "_next",
  "fonts",
  "assets",
  "evidence",
  "screenshots",
  "fixtures",
  "bench",
  "core-overlay",
  "drizzle",
  "e2e",
  "tests",
]);

/**
 * Individually exempt paths, each for a reason stated in the header
 * comment above. Repo-relative, POSIX separators.
 */
const EXEMPT = new Set([
  "CHANGELOG.md",
  "landing/changelog.html",
  "docs/RELEASE-EVIDENCE.md",
  "docs/EDITIONS.md",
  "public-facts.json",
  "kuma-mapping.json",
  "monitor-type-dod.json",
]);

/** Extensions worth reading. */
const PROSE = /\.(html|md)$/;
const CODE = /\.(ts|tsx)$/;
const SCRIPT = /^landing\/[^/]*\.js$/;
/** Generators whose output lands on a covered surface. */
const GENERATOR = /\.(ts|mjs)$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Blank out comments so only the strings and the markup remain.
 *
 * Replaces each comment character with a space rather than deleting it,
 * so every reported line and column still points at the real position in
 * the file. A reviewer given "line 412" that is off by the length of the
 * comments above it will not find what the guard found.
 *
 * The scanner tracks template literals because this repository keeps a
 * whole stylesheet in one, and a `//` inside a CSS url() would otherwise
 * blank out the rest of the file.
 */
export function blankComments(source) {
  let out = "";
  let i = 0;
  let mode = "code";
  let quote = "";
  while (i < source.length) {
    const c = source[i];
    const d = source[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "/") {
        mode = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && d === "*") {
        mode = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        mode = "string";
        quote = c;
      }
      out += c;
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += "\n";
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") {
        mode = "code";
        out += "  ";
        i += 2;
      } else {
        out += c === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    // inside a string literal
    if (c === "\\") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === quote) mode = "code";
    out += c;
    i += 1;
  }
  return out;
}

export function coveredFiles() {
  return walk(ROOT)
    .map((f) => relative(ROOT, f).split(sep).join("/"))
    .filter((f) => {
      if (EXEMPT.has(f)) return false;
      if (SCRIPT.test(f)) return true;
      if (f.startsWith("landing/") && PROSE.test(f)) return true;
      if (f.startsWith("docs/") && f.endsWith(".md")) return true;
      if (f.startsWith("src/") && CODE.test(f)) return true;
      if (f.startsWith("scripts/") && GENERATOR.test(f)) return true;
      return !f.includes("/") && f.endsWith(".md");
    })
    .sort();
}

export function findViolations() {
  const found = [];
  for (const file of coveredFiles()) {
    const raw = readFileSync(join(ROOT, file), "utf8");
    const strip = CODE.test(file) || GENERATOR.test(file);
    const text = strip ? blankComments(raw) : raw;
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      BANNED.lastIndex = 0;
      let match;
      while ((match = BANNED.exec(line)) !== null) {
        found.push({
          file,
          line: index + 1,
          column: match.index + 1,
          char: match[0] === EM_DASH ? "U+2014" : "U+2013",
          excerpt: line
            .slice(Math.max(0, match.index - 40), match.index + 40)
            .trim(),
        });
      }
    }
  }
  return found;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const found = findViolations();
  const checking = process.argv.includes("--check");
  if (found.length === 0) {
    console.log(
      `dash-guard: ${coveredFiles().length} covered file(s) are clean`,
    );
    process.exit(0);
  }
  for (const v of found.slice(0, 60)) {
    console.log(`  ${v.file}:${v.line}:${v.column}  ${v.char}  ${v.excerpt}`);
  }
  if (found.length > 60) console.log(`  … and ${found.length - 60} more`);
  console.log(
    `\ndash-guard: ${found.length} em/en dash(es) on customer-facing surfaces.`,
  );
  console.log(
    "Rewrite with a period, comma, colon, parentheses or an ASCII hyphen.",
  );
  process.exit(checking ? 1 : 0);
}
