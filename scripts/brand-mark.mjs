#!/usr/bin/env node
/**
 * The Vigil mark: two curved blades around a narrow waist, drawn once,
 * written everywhere.
 *
 *   node scripts/brand-mark.mjs           regenerate every surface
 *   node scripts/brand-mark.mjs --check   fail if any surface disagrees
 *
 * The mark is defined here as one set of numbers for the LEFT blade; the
 * right blade is derived by mirroring, and everything downstream is
 * derived from both. That single-source rule exists because the failure
 * it prevents happened twice already: a mark pasted by hand into
 * twenty-four pages, three icon files and a React component, so that
 * "change the logo" meant finding every copy and trusting the count.
 *
 * Everything downstream is derived:
 *
 *   - `src/lib/brand-mark.ts`     the path, for the application
 *   - `landing/**\/*.html`         the inline mark inside every .brand link
 *   - the favicons and app icons
 *   - `docs/brand/`               standalone assets, light and dark
 *   - the share cards, between their brand-mark markers
 *
 * Constraints the geometry keeps, and `--check` enforces:
 *
 *   - the two blades are exact mirrors of one another
 *   - each blade is symmetric about the mark's horizontal centre line
 *   - the blades never touch: the waist stays a waist
 *   - the end caps slant toward the centre, so the silhouette notches
 *
 * This mark replaced the pixel eye on 2026-08-17, and the eye's blink
 * retired with it: the blades are a still form, and animating them would
 * be decoration. The guard below keeps the eye from coming back the same
 * way it keeps the stroked pulse polylines from coming back.
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

// ── the geometry ─────────────────────────────────────────────────────────
// One blade, in a 80 x 128 box, as four corner points and the two cubic
// control pairs that bow its edges toward the waist. The reference board
// measures roughly 0.61 wide to tall; 80/128 is 0.625.

export const W = 80;
export const H = 128;

/**
 * Two cuts of one drawing. `display` is the mark as the identity board
 * draws it: a tight waist, a fine aperture. `small` is the optical cut
 * for chrome sizes (navbars, footers, favicons, app sidebars): the same
 * form with a wider aperture and thicker stems, because below ~32px the
 * display cut's counter seals into a blob. Same rule type has followed
 * every text face in this repository; the mark gets it too.
 */
export const BLADES = {
  display: {
    outerTop: [8, 4],
    innerTop: [33, 14],
    innerCtrlA: [40, 46],
    innerCtrlB: [40, 82],
    innerBottom: [33, 114],
    outerBottom: [8, 124],
    outerCtrlA: [19, 82],
    outerCtrlB: [19, 46],
  },
  small: {
    outerTop: [8, 4],
    innerTop: [30, 14],
    innerCtrlA: [37, 46],
    innerCtrlB: [37, 82],
    innerBottom: [30, 114],
    outerBottom: [8, 124],
    outerCtrlA: [17, 82],
    outerCtrlB: [17, 46],
  },
};

/** One blade as a closed path; `mirror` flips it across the centre line. */
function bladePath(B, mirror) {
  const X = (x) => (mirror ? W - x : x);
  const at = ([x, y]) => `${X(x)} ${y}`;
  return (
    `M${at(B.outerTop)}` +
    `L${at(B.innerTop)}` +
    `C${at(B.innerCtrlA)} ${at(B.innerCtrlB)} ${at(B.innerBottom)}` +
    `L${at(B.outerBottom)}` +
    `C${at(B.outerCtrlA)} ${at(B.outerCtrlB)} ${at(B.outerTop)}` +
    `Z`
  );
}

function markPath(cut) {
  const B = BLADES[cut];
  return bladePath(B, false) + bladePath(B, true);
}

export const MARK_PATHS = {
  display: markPath("display"),
  small: markPath("small"),
};

// ── the geometry's own invariants ────────────────────────────────────────

function invariants() {
  const bad = [];

  for (const [cut, B] of Object.entries(BLADES)) {
    // Each blade is symmetric about the horizontal centre line: every top
    // coordinate has a bottom partner whose y values sum to H, and the two
    // cubic controls pair up the same way. Symmetry here is what keeps the
    // mark from quietly leaning as its numbers are tuned.
    for (const [a, b] of [
      ["outerTop", "outerBottom"],
      ["innerTop", "innerBottom"],
      ["innerCtrlA", "innerCtrlB"],
      ["outerCtrlA", "outerCtrlB"],
    ]) {
      if (B[a][0] !== B[b][0])
        bad.push(`${cut}.${a}/${b}: x differs, the blade leans`);
      if (B[a][1] + B[b][1] !== H)
        bad.push(`${cut}.${a}/${b}: y does not mirror about the centre line`);
    }

    // The waist stays a waist: the inner edges bow toward the centre but
    // never reach it. The cubic's midpoint x is (p0 + 3c1 + 3c2 + p3) / 8.
    const waistX =
      (B.innerTop[0] +
        3 * B.innerCtrlA[0] +
        3 * B.innerCtrlB[0] +
        B.innerBottom[0]) /
      8;
    if (waistX >= W / 2 - 1) bad.push(`${cut}: the blades touch at the waist`);
    if (waistX <= B.innerTop[0])
      bad.push(`${cut}: the inner edge does not bow inward`);

    // The caps slant toward the centre, so the silhouette notches at top
    // and bottom instead of reading as a sheared rectangle.
    if (B.outerTop[1] >= B.innerTop[1])
      bad.push(`${cut}: the top cap does not slant toward the centre`);

    // The mark stays inside its box.
    for (const [name, [x, y]] of Object.entries(B)) {
      if (x < 0 || x > W / 2 || y < 0 || y > H)
        bad.push(`${cut}.${name}: outside the box`);
    }
  }

  // The small cut must actually be the opener: a wider aperture and a
  // thicker stem than the display cut, or it has no reason to exist.
  const waist = (B) =>
    (B.innerTop[0] +
      3 * B.innerCtrlA[0] +
      3 * B.innerCtrlB[0] +
      B.innerBottom[0]) /
    8;
  if (waist(BLADES.small) >= waist(BLADES.display))
    bad.push("small cut does not widen the aperture");

  return bad;
}

// ── emitters ─────────────────────────────────────────────────────────────

const GENERATED = "Generated by scripts/brand-mark.mjs. Do not edit by hand.";

/**
 * The inline mark for the static site: one path, no frames, no script.
 *
 * Emitted at the caller's indentation and in the shape prettier would
 * choose, because these pages are not reformatted when the logo changes.
 * A brand diff should be a brand diff, not four hundred rewrapped lines.
 */
function inlineMark({ indent = "" } = {}) {
  const p = indent + "  ";
  const attrs = [
    'class="brand__mark"',
    `viewBox="0 0 ${W} ${H}"`,
    'width="15"',
    'height="24"',
    'fill="currentColor"',
    'aria-hidden="true"',
  ];
  const d = MARK_PATHS.small;
  const oneLine = `${p}<path d="${d}" />`;
  const path =
    oneLine.length <= 80 ? oneLine : `${p}<path\n${p}  d="${d}"\n${p}/>`;
  return (
    `<svg\n` +
    attrs.map((a) => `${p}${a}\n`).join("") +
    `${indent}>\n${path}\n${indent}</svg>`
  );
}

/**
 * A plain, sized, static mark for the card renderers. They are
 * screenshotted by a headless browser, so what ships is what shows.
 */
function staticMark(fill, width) {
  const height = (width * H) / W;
  if (!Number.isInteger(height))
    throw new Error(`a ${width}px mark lands on a fractional height`);
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="${width}" height="${height}" ` +
    `fill="${fill}"><path d="${MARK_PATHS.small}"/></svg>`
  );
}

/** A square icon tile with the mark centred at 62% of the tile's height. */
function iconSvg(bg, fg, radius) {
  const S = 64;
  const h = 40; // 62% of the tile, so the waist reads at favicon size
  const s = h / H;
  const w = W * s;
  const x = (S - w) / 2;
  const y = (S - h) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">\n` +
    `  <rect width="${S}" height="${S}"${radius ? ` rx="${radius}"` : ""} fill="${bg}"/>\n` +
    `  <path transform="translate(${x} ${y}) scale(${s})" fill="${fg}" d="${MARK_PATHS.small}"/>\n` +
    `</svg>\n`
  );
}

/** The bare display cut, no tile, for documents and display sizes. */
function assetSvg(fg) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
    `  <path fill="${fg}" d="${MARK_PATHS.display}"/>\n` +
    `</svg>\n`
  );
}

function brandMarkTs() {
  return `/**
 * ${GENERATED}
 *
 * The Vigil mark: two curved blades around a narrow waist, one path in a
 * ${W} x ${H} box. The geometry, its invariants and the reasoning live in
 * scripts/brand-mark.mjs. The mark is still; the pixel eye and its blink
 * retired together on 2026-08-17.
 *
 * MARK_PATH is the small optical cut: the application renders the mark at
 * chrome sizes, where the display cut's aperture would seal shut. The
 * display cut lives in docs/brand/ for anything set large.
 */

export const MARK_WIDTH = ${W};
export const MARK_HEIGHT = ${H};
export const MARK_VIEWBOX = "0 0 ${W} ${H}";

export const MARK_PATH =
  "${MARK_PATHS.small}";
`;
}

// ── surfaces ─────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "demo", // a static export of the product; it re-exports with the app's mark
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

/** `<a class="brand">` owns the mark. */
const BRAND = /(<a\b[^>]*class="brand"[^>]*>\s*)(<svg\b[\s\S]*?<\/svg>)/g;

function rewriteHtml(src) {
  return src.replace(BRAND, (_m, open) => {
    const indent = /\n([ \t]*)$/.exec(open)?.[1] ?? "";
    return open + inlineMark({ indent });
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
 * Retired marks must never come back. The stroked pulse polylines are the
 * generation before last; the pixel eye's opening subpath and its blink
 * plumbing are the generation this mark replaced.
 */
const RETIRED = [
  /points="2,17 10,17 13,8 19,26 22,17 30,17"/,
  /points="6,16 11\.5,16 14\.5,9 18,23 21,16 26,16"/,
  /points="4,16 10\.5,16 14,8 18\.5,24 22,16 28,16"/,
  /M9 0h7v2h-7z/,
  /data-blink/,
  /BlinkingVigilMark/,
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
];

/** Files of the blink era that must stay deleted. */
const RETIRED_FILES = ["src/components/vigil-mark-blink.tsx"];

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
      for (const re of RETIRED)
        if (re.test(src)) bad.push(`${rel}: a retired mark is back (${re})`);
    }
  }

  for (const rel of RETIRED_FILES) {
    if (existsSync(join(ROOT, rel)))
      bad.push(`${rel}: the blink retired with the pixel eye; delete this`);
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
  // raster logo cannot take a colour and goes soft on every display the
  // designer did not own.
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
await put("landing/favicon.svg", iconSvg("#f5f5f3", "#131417", 14));
await put("src/app/icon.svg", iconSvg("#0a0a0a", "#fafafa", 14));
await put("landing/demo/icon.svg", iconSvg("#0a0a0a", "#fafafa", 14));
await put("docs/brand/vigil-mark.svg", assetSvg("#ffffff"));
await put("docs/brand/vigil-mark-dark.svg", assetSvg("#000000"));

// The share cards. Each is HTML rendered to a PNG by hand, so the mark
// inside them is generated here and the PNGs are rebuilt with the
// command each file documents.
for (const [rel, fill] of [
  ["scripts/brand/og-card.html", "#131417"],
  [".github/social-preview.html", "#16181c"],
  ["scripts/core-overlay/social-preview.html", "#16181c"],
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
  const want = src.replace(marker, `$1\n${staticMark(fill, 30)}\n$2`);
  if (squish(src) === squish(want)) continue;
  await put(rel, want);
}

// Every page's brand links.
for (const file of htmlPages(join(ROOT, "landing"))) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");
  const found = marksIn(src);
  if (found.length === 0) continue;
  const want = found.map(() => inlineMark());
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
  console.log(`brand mark: ${W}x${H}, two cuts, every surface agrees`);
} else {
  if (problems.length) {
    console.error("The brand mark does not agree with itself:\n");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(
    `brand mark: ${W}x${H}, two cuts, ${MARK_PATHS.display.length}+${MARK_PATHS.small.length} chars`,
  );
}
