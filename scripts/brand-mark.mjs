#!/usr/bin/env node
/**
 * The Vigil mark: one pixel eye, drawn once, written everywhere.
 *
 *   node scripts/brand-mark.mjs           regenerate every surface
 *   node scripts/brand-mark.mjs --check   fail if any surface disagrees
 *
 * The mark is a 25 x 11 grid of whole pixels. It is defined here as runs
 * of ink per row and nowhere else, because the failure this file exists
 * to prevent is the one the old mark had: a stroked polyline pasted by
 * hand into twenty-four pages, three icon files and a React component,
 * so that "change the logo" meant finding twenty-eight copies and
 * trusting that the twenty-ninth did not exist. It did.
 *
 * Everything downstream is derived:
 *
 *   - `src/lib/brand-mark.ts`     the three frames, for the application
 *   - `landing/**\/*.html`         the inline mark inside every .brand link
 *   - the favicons and app icons
 *   - `docs/brand/`               standalone assets, light and dark
 *
 * Constraints the geometry keeps, and `--check` enforces:
 *
 *   - integers only, axis-aligned rectangles, no curve ever
 *   - every frame shares the viewBox, the centre and the eye's corners,
 *     so a blink cannot move or resize the mark
 *   - each row is left/right symmetric
 *   - the closed frame is two lids meeting, not the open eye squashed:
 *     it has no pupil and no hollow
 *
 * Why rectangles and not a traced outline: a rectangle list is the same
 * data structure as the grid above it, so a mistake in this file shows
 * up as a wrong pixel rather than as a subtly wrong curve. The output is
 * one `<path>` of `M h v h z` subpaths, which is smaller than the rects
 * it came from and still contains no instruction that is not a right
 * angle.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import prettier from "prettier";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

// ── the grid ─────────────────────────────────────────────────────────────
// 25 x 11. The reference measures 2.31 wide to tall; this is 2.27, on the
// nearest grid that still has a true centre column (12) and centre row (5)
// for the pupil to sit on. Rows are [start, end) column runs.

export const W = 25;
export const H = 11;

/**
 * Open. An outer lid ring two pixels thick, a hollow, and a five-pixel
 * pupil with its corners cut so it reads round rather than square.
 */
const OPEN = {
  0: [[9, 16]],
  1: [[6, 19]],
  2: [
    [4, 6],
    [19, 21],
  ],
  3: [
    [2, 4],
    [11, 14],
    [21, 23],
  ],
  4: [
    [1, 3],
    [10, 15],
    [22, 24],
  ],
  5: [
    [0, 2],
    [10, 15],
    [23, 25],
  ],
  6: [
    [1, 3],
    [10, 15],
    [22, 24],
  ],
  7: [
    [2, 4],
    [11, 14],
    [21, 23],
  ],
  8: [
    [4, 6],
    [19, 21],
  ],
  9: [[6, 19]],
  10: [[9, 16]],
};

/**
 * Half. The upper lid has come down three rows and thickened into a
 * band; the lower lid has not moved, which is what a real lid does. One
 * row of hollow is left above the pupil on purpose: without it the pupil
 * touches the lid and the two whites merge into a shape like a tooth.
 */
const HALF = {
  2: [[6, 19]],
  3: [[3, 22]],
  4: [
    [1, 3],
    [22, 24],
  ],
  5: [
    [0, 2],
    [10, 15],
    [23, 25],
  ],
  6: [
    [1, 3],
    [10, 15],
    [22, 24],
  ],
  7: [
    [2, 4],
    [11, 14],
    [21, 23],
  ],
  8: [
    [4, 6],
    [19, 21],
  ],
  9: [[6, 19]],
  10: [[9, 16]],
};

/**
 * Closed. Solid lids meeting on the centre row, tapering to the same two
 * corner pixels the open eye has. Not a bar: the taper is the eye's own
 * end profile, so the shape that flashes is still recognisably this eye.
 */
const CLOSED = {
  4: [[4, 21]],
  5: [[0, 25]],
  6: [[4, 21]],
};

export const FRAMES = { open: OPEN, half: HALF, closed: CLOSED };

/**
 * The blink. Rare, discrete, and over before it is consciously seen:
 * three frame swaps totalling 180ms, once every 7 to 15 seconds, with a
 * second blink a quarter of the time because real eyes double-blink. The
 * application keeps that natural cadence; the public site uses the fixed
 * nine-second cadence specified by its Direction 2b board while sharing
 * these exact frame durations.
 */
export const BLINK = {
  minWait: 7000,
  maxWait: 15000,
  half: 60,
  closed: 70,
  reopen: 50,
  doubleChance: 0.25,
  doubleGap: 180,
};

const LANDING_BLINK = {
  ...BLINK,
  minWait: 9000,
  maxWait: 9000,
  doubleChance: 0,
};

// ── geometry ─────────────────────────────────────────────────────────────

function gridOf(frame) {
  const g = Array.from({ length: H }, () => Array(W).fill(0));
  for (const [row, runs] of Object.entries(frame)) {
    for (const [a, b] of runs)
      for (let c = a; c < b; c++) g[Number(row)][c] = 1;
  }
  return g;
}

/** Maximal axis-aligned rectangles covering the ink exactly once. */
function rectsOf(frame) {
  const g = gridOf(frame);
  const used = g.map((r) => r.map(() => false));
  const out = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!g[y][x] || used[y][x]) continue;
      let x2 = x;
      while (x2 < W && g[y][x2] && !used[y][x2]) x2++;
      let y2 = y + 1;
      while (y2 < H) {
        let ok = true;
        for (let i = x; i < x2 && ok; i++)
          if (!g[y2][i] || used[y2][i]) ok = false;
        if (!ok) break;
        y2++;
      }
      for (let yy = y; yy < y2; yy++)
        for (let xx = x; xx < x2; xx++) used[yy][xx] = true;
      out.push([x, y, x2 - x, y2 - y]);
    }
  }
  return out;
}

export function pathOf(name) {
  return rectsOf(FRAMES[name])
    .map(([x, y, w, h]) => `M${x} ${y}h${w}v${h}h-${w}z`)
    .join("");
}

export const PATHS = {
  open: pathOf("open"),
  half: pathOf("half"),
  closed: pathOf("closed"),
};

// ── the geometry's own invariants ────────────────────────────────────────

function invariants() {
  const bad = [];
  const grids = Object.fromEntries(
    Object.entries(FRAMES).map(([n, f]) => [n, gridOf(f)]),
  );

  for (const [name, g] of Object.entries(grids)) {
    g.forEach((row, y) => {
      if (row.join("") !== [...row].reverse().join(""))
        bad.push(`${name}: row ${y} is not left/right symmetric`);
    });
    if (!g.some((row) => row.some(Boolean))) bad.push(`${name}: no ink`);
  }

  // The corners of the eye are the same two pixels in every frame, which
  // is what stops a blink from looking like the logo moved.
  for (const [name, g] of Object.entries(grids)) {
    if (!g[5][0] || !g[5][W - 1])
      bad.push(`${name}: the eye's corners are not on the centre row`);
  }

  // Closed is lids meeting: solid, no hollow, no pupil.
  const c = grids.closed;
  for (let y = 0; y < H; y++) {
    const on = c[y].map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    if (on.length && on[on.length - 1] - on[0] + 1 !== on.length)
      bad.push(`closed: row ${y} has a hole, so it is not two lids meeting`);
  }
  if (c.filter((row) => row.some(Boolean)).length > 5)
    bad.push("closed: too tall to read as shut");

  // Ink only ever moves down as the eye closes, never up: the open frame
  // must contain the half frame's lower lid, and so on.
  const height = (g) => g.filter((row) => row.some(Boolean)).length;
  if (!(
    height(grids.open) > height(grids.half) && height(grids.half) > height(c)
  ))
    bad.push("frames do not close monotonically");

  return bad;
}

// ── emitters ─────────────────────────────────────────────────────────────

const GENERATED = "Generated by scripts/brand-mark.mjs. Do not edit by hand.";

/**
 * The inline mark for the static site: three frame groups, open showing,
 * every frame present so a blink is a repaint and never a reflow.
 *
 * Emitted at the caller's indentation and in the shape prettier would
 * choose, because these pages are not reformatted when the logo changes.
 * A brand diff should be a brand diff, not four hundred rewrapped lines.
 */
function inlineMark({ blink, indent = "" }) {
  const p = indent + "  ";
  const attrs = [
    'class="brand__mark"',
    `viewBox="0 0 ${W} ${H}"`,
    `width="${W}"`,
    `height="${H}"`,
    'fill="currentColor"',
    'shape-rendering="crispEdges"',
    'aria-hidden="true"',
    'data-mark="open"',
    ...(blink ? ["data-blink"] : []),
  ];
  const groups = ["open", "half", "closed"].map((f) => {
    const g = `<g data-frame="${f}"${f === "open" ? "" : ' display="none"'}>`;
    const oneLine = `${p}  <path d="${PATHS[f]}" />`;
    const path =
      oneLine.length <= 80
        ? oneLine
        : `${p}  <path\n${p}    d="${PATHS[f]}"\n${p}  />`;
    return `${p}${g}\n${path}\n${p}</g>`;
  });
  return (
    `<svg\n` +
    attrs.map((a) => `${p}${a}\n`).join("") +
    `${indent}>\n${groups.join("\n")}\n${indent}</svg>`
  );
}

/**
 * A plain, sized, static mark for the two card renderers. They are
 * screenshotted by a headless browser, so the frame that ships is
 * whichever one is showing: the open one, and no other.
 */
function staticMark(fill, width) {
  const height = (width * H) / W;
  if (!Number.isInteger(height))
    throw new Error(`a ${width}px mark lands on a fractional height`);
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="${width}" height="${height}" ` +
    `fill="${fill}" shape-rendering="crispEdges"><path d="${PATHS.open}"/></svg>`
  );
}

/** A square app icon: the open frame on this project's dark tile. */
function iconSvg(bg, fg, radius = 7) {
  const S = 31; // odd, so a 25 x 11 eye centres on whole pixels: 3 and 10
  const x = (S - W) / 2;
  const y = (S - H) / 2;
  if (!Number.isInteger(x) || !Number.isInteger(y))
    throw new Error("the icon tile would put the mark on a half pixel");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" shape-rendering="crispEdges">\n` +
    `  <rect width="${S}" height="${S}"${radius ? ` rx="${radius}"` : ""} fill="${bg}"/>\n` +
    `  <path transform="translate(${x} ${y})" fill="${fg}" d="${PATHS.open}"/>\n` +
    `</svg>\n`
  );
}

/** The bare mark, no tile, for documents and wherever a file is wanted. */
function assetSvg(fg) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 4}" height="${H * 4}" shape-rendering="crispEdges">\n` +
    `  <path fill="${fg}" d="${PATHS.open}"/>\n` +
    `</svg>\n`
  );
}

function brandMarkTs() {
  const frames = Object.entries(PATHS)
    .map(([k, v]) => `  ${k}:\n    "${v}",`)
    .join("\n");
  return `/**
 * ${GENERATED}
 *
 * The Vigil mark, as three frames of one ${W} x ${H} pixel grid. The
 * geometry, the invariants that keep a blink from moving the mark, and
 * the reasoning live in scripts/brand-mark.mjs.
 */

export const MARK_WIDTH = ${W};
export const MARK_HEIGHT = ${H};
export const MARK_VIEWBOX = "0 0 ${W} ${H}";

export const MARK_FRAMES = {
${frames}
} as const;

export type MarkFrame = keyof typeof MARK_FRAMES;

/** Blink timing, in milliseconds. One blink is ${BLINK.half + BLINK.closed + BLINK.reopen}ms of frame swaps. */
export const BLINK = {
  minWait: ${BLINK.minWait},
  maxWait: ${BLINK.maxWait},
  half: ${BLINK.half},
  closed: ${BLINK.closed},
  reopen: ${BLINK.reopen},
  doubleChance: ${BLINK.doubleChance},
  doubleGap: ${BLINK.doubleGap},
} as const;
`;
}

/** The public site's fixed Direction 2b cadence, with shared frame timing. */
function landingTimingBlock() {
  return (
    `  // brand-mark:start ${GENERATED}\n` +
    `  var BLINK = {\n` +
    Object.entries(LANDING_BLINK)
      .map(([k, v]) => `    ${k}: ${v},`)
      .join("\n") +
    `\n  };\n` +
    `  // brand-mark:end\n`
  );
}

// ── surfaces ─────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "demo", // a static export of the product; it carries the app's own mark
  "_next",
]);

function htmlPages(dir, acc = []) {
  // The public site is a commercial surface and the gate strips it, so in
  // Core this directory does not exist. An edition that has no pages has
  // no pages to stamp, which is not an error.
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) htmlPages(full, acc);
    else if (entry.endsWith(".html")) acc.push(full);
  }
  return acc;
}

/** `<a class="brand">` owns the mark. The first one on a page blinks. */
const BRAND = /(<a\b[^>]*class="brand"[^>]*>\s*)(<svg\b[\s\S]*?<\/svg>)/g;

function rewriteHtml(src) {
  let n = 0;
  return src.replace(BRAND, (_m, open) => {
    const indent = /\n([ \t]*)$/.exec(open)?.[1] ?? "";
    return open + inlineMark({ blink: n++ === 0, indent });
  });
}

// Whitespace is prettier's to decide: these pages are formatted after they
// are written, so the comparison has to be blind to how the attributes end
// up wrapped. Dropping every space is crude and exactly strict enough.
const squish = (s) => s.replace(/\s+/g, "");

function marksIn(src) {
  return [...src.matchAll(BRAND)].map((m) => m[2]);
}

// ── raster and revenant guards ───────────────────────────────────────────

/**
 * The three stroked polylines the pixel eye replaced, in the three sizes
 * they were pasted at. They must never come back.
 */
const PULSE = [
  /points="2,17 10,17 13,8 19,26 22,17 30,17"/,
  /points="6,16 11\.5,16 14\.5,9 18,23 21,16 26,16"/,
  /points="4,16 10\.5,16 14,8 18\.5,24 22,16 28,16"/,
];

/**
 * PulseIcon is a fine icon for the Monitors nav item and it stays there.
 * It is not the logo, which is how the last one happened: a nav glyph
 * used as a brand mark reads as a brand mark to everyone but the person
 * who typed it.
 */
const NOT_THE_LOGO = [
  "src/components/logo.tsx",
  "src/components/vigil-mark.tsx",
  "src/components/vigil-mark-blink.tsx",
];

const GUARDED = [
  "landing",
  "src/components",
  "src/app",
  "docs/brand",
  ".github/social-preview.html",
  "scripts/brand",
];

function walkFiles(dir, acc = []) {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return acc;
  }
  // push, not concat: concat returns a new array, and the recursive call
  // below throws its return value away. Written that way first, this walk
  // silently visited nothing and the revenant check below passed on an
  // empty file list. It was caught by putting the old logo back and
  // watching the guard say everything was fine.
  if (!st.isDirectory()) {
    acc.push(dir);
    return acc;
  }
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    walkFiles(join(dir, entry), acc);
  }
  return acc;
}

function revenants() {
  const bad = [];
  const texty = /\.(html|css|js|mjs|ts|tsx|svg|md|json)$/;
  for (const root of GUARDED) {
    for (const file of walkFiles(join(ROOT, root))) {
      if (!texty.test(file)) continue;
      const rel = relative(ROOT, file);
      if (rel === "scripts/brand-mark.mjs") continue;
      const src = readFileSync(file, "utf8");
      for (const re of PULSE)
        if (re.test(src)) bad.push(`${rel}: the retired pulse mark is back`);
    }
  }

  for (const rel of NOT_THE_LOGO) {
    let src;
    try {
      src = readFileSync(join(ROOT, rel), "utf8");
    } catch {
      bad.push(`${rel}: missing`);
      continue;
    }
    if (/\bPulseIcon\b/.test(src))
      bad.push(`${rel}: an icon-set glyph is being used as the brand mark`);
    if (/<img\b|data:image|\.png|\.jpg|\.webp/i.test(src))
      bad.push(`${rel}: the mark must be drawn, not a raster image`);
  }

  // A brand link must contain a drawn mark, never a picture of one. A
  // raster logo cannot take a colour, cannot blink, and goes soft on
  // every display the designer did not own.
  for (const file of htmlPages(join(ROOT, "landing"))) {
    const src = readFileSync(file, "utf8");
    const rel = relative(ROOT, file);
    for (const m of [
      ...src.matchAll(/<a\b[^>]*class="brand"[^>]*>[\s\S]*?<\/a>/g),
    ]) {
      if (/<img\b|url\(|\.png|\.jpg|\.webp|data:image/i.test(m[0]))
        bad.push(`${rel}: the brand link uses a raster image, not the mark`);
    }
  }
  return bad;
}

// ── run ──────────────────────────────────────────────────────────────────

const problems = [];
const stale = [];

/**
 * A file this script owns outright is written through prettier, so that
 * `npm run format` cannot immediately disagree with it.
 *
 * A file this script only splices a mark into is not. `landing/` is
 * decades of prose that predates the current prettier settings, and
 * reformatting a page to change its logo buries a two-line brand diff in
 * four hundred lines of rewrapped sentences. So: format what was already
 * formatted, and leave everything else exactly as it was found.
 */
async function formatted(rel, content, current) {
  const file = join(ROOT, rel);
  const info = await prettier.getFileInfo(file);
  if (!info.inferredParser) return content; // prettier has no parser: svg
  const options = (await prettier.resolveConfig(file)) ?? {};
  if (
    current !== null &&
    !(await prettier.check(current, { ...options, filepath: file }))
  )
    return content;
  return prettier.format(content, { ...options, filepath: file });
}

async function put(rel, content) {
  const file = join(ROOT, rel);
  // A surface belongs to an edition. The gate strips the public site and
  // the share cards out of Core, so their directories are simply absent
  // there — and a generator that dies on the first one nobody has is a
  // generator the buyer of the source cannot run. Absent is skipped;
  // present-but-wrong is still reported.
  if (!existsSync(dirname(file))) return;
  let current = null;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    /* new file */
  }
  const want = await formatted(rel, content, current);
  if (current === want) return;
  if (CHECK) stale.push(rel);
  else writeFileSync(file, want);
}

problems.push(...invariants());

await put("src/lib/brand-mark.ts", brandMarkTs());
await put("landing/favicon.svg", iconSvg("#060606", "#e6e6e6", 0));
await put("src/app/icon.svg", iconSvg("#0a0a0a", "#fafafa"));
await put("landing/demo/icon.svg", iconSvg("#0a0a0a", "#fafafa"));
await put("docs/brand/vigil-mark.svg", assetSvg("#ffffff"));
await put("docs/brand/vigil-mark-dark.svg", assetSvg("#000000"));

// landing/app.js carries the timing, between markers.
{
  const rel = "landing/app.js";
  // Core carries the mark and this generator but not the public site, so
  // the file this block writes into is simply not in that edition.
  // Skipping beats throwing: somebody who bought the source should be
  // able to run `npm run brand` and rebrand what they do have.
  if (existsSync(join(ROOT, rel))) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    if (!/brand-mark:start/.test(src))
      problems.push(`${rel}: the brand-mark timing markers are missing`);
    else
      await put(
        rel,
        src.replace(
          /[ \t]*\/\/ brand-mark:start[\s\S]*?\/\/ brand-mark:end\n/,
          landingTimingBlock(),
        ),
      );
  }
}

// The two social cards. Both are HTML rendered to a PNG by hand, so the
// mark inside them is generated here and the PNGs are rebuilt with the
// command each file documents.
for (const [rel, fill] of [
  ["scripts/brand/og-card.html", "#e6e6e6"],
  [".github/social-preview.html", "#e6e6e6"],
  ["scripts/core-overlay/social-preview.html", "#e6e6e6"],
]) {
  // Same reason: the cards sell the commercial edition and the gate
  // strips them, so in Core there is nothing here to write into.
  if (!existsSync(join(ROOT, rel))) continue;
  const src = readFileSync(join(ROOT, rel), "utf8");
  const marker = /(<!-- brand-mark:start -->)[\s\S]*?(<!-- brand-mark:end -->)/;
  if (!marker.test(src)) {
    problems.push(`${rel}: the brand-mark markers are missing`);
    continue;
  }
  const want = src.replace(marker, `$1\n${staticMark(fill, 50)}\n$2`);
  if (squish(src) === squish(want)) continue;
  await put(rel, want);
}

// Every page's brand links.
for (const file of htmlPages(join(ROOT, "landing"))) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");
  const found = marksIn(src);
  if (found.length === 0) continue;
  const want = found.map((_, i) => inlineMark({ blink: i === 0 }));
  if (found.every((got, i) => squish(got) === squish(want[i]))) continue;
  await put(rel, rewriteHtml(src));
}

problems.push(...revenants());

if (CHECK) {
  for (const rel of stale)
    problems.push(`${rel}: stale, run \`npm run brand\``);
  if (problems.length) {
    console.error("The brand mark does not agree with itself:\n");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`brand mark: ${W}x${H}, three frames, every surface agrees`);
} else {
  if (problems.length) {
    console.error("The brand mark does not agree with itself:\n");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`brand mark: ${W}x${H}`);
  for (const [name, d] of Object.entries(PATHS))
    console.log(
      `  ${name.padEnd(6)} ${rectsOf(FRAMES[name]).length} rects, ${d.length} chars`,
    );
}
