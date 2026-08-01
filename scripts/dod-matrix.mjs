#!/usr/bin/env node
/**
 * The Definition of Done, per monitor type, derived from the repository.
 *
 *   node scripts/dod-matrix.mjs           regenerate the matrix
 *   node scripts/dod-matrix.mjs --check   fail if the page has drifted
 *
 * Section 13 of the release reference lists what makes a type complete,
 * and Section 29 asks for a matrix of it. The reason this is generated
 * rather than written is the sentence right after that list: *a selector
 * option, registry entry, or conformance test does not prove this*. A
 * hand-maintained table proves even less — it records what someone
 * believed on the day they typed it.
 *
 * So every column below is answered by looking at the repository. The
 * answers are deliberately shallow in one direction only: this can prove
 * a thing is ABSENT (no test file, no fixture, no `secretFields`) and it
 * cannot prove a thing is GOOD. A green row means the artefact exists,
 * not that it is well written. Reviewers still review.
 *
 * The columns that are not applicable to a kind are marked so rather
 * than failed: a `group` monitor has no protocol fixture because it
 * dials nothing, and scoring it against one would make the matrix lie in
 * the direction that flatters it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(ROOT, "docs", "MONITOR-TYPE-DOD.md");
const ARTIFACT = join(ROOT, "monitor-type-dod.json");

const CHECK = process.argv.includes("--check");

/** Reads the registry through tsx, which is how every other script does it. */
function readRegistry() {
  const script = `
    import { CHECK_TYPE_SPECS } from "@/modules/monitors/types/specs";
    const out = {};
    for (const [id, spec] of Object.entries(CHECK_TYPE_SPECS)) {
      out[id] = {
        kind: spec.descriptor.kind ?? "active",
        secretFields: [...(spec.secretFields ?? [])],
        facts: spec.descriptor.facts.map((f) => f.key),
        assertions: spec.assertions.map((a) => a.id),
        requiresCapability: spec.descriptor.requiresCapability ?? null,
      };
    }
    process.stdout.write("@@" + JSON.stringify(out) + "@@");
  `;
  const out = execFileSync("npx", ["tsx", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const match = out.match(/@@(.*)@@/s);
  if (!match) throw new Error("registry probe produced no output");
  return JSON.parse(match[1]);
}

function read(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * Format generated markdown the way the repository formats everything
 * else, using the repository's own prettier and config rather than a
 * second opinion about line width.
 */
async function format(source, filepath) {
  const prettier = await import("prettier");
  const config = await prettier.resolveConfig(filepath);
  return prettier.format(source, { ...config, filepath });
}

/**
 * Whether a test stands up a real server rather than mocking a function.
 *
 * Section 13 asks for a *protocol-level fixture*, and the difference is
 * the whole point of the requirement: a mocked probe proves the code
 * calls itself, while a socket the probe actually dials proves it speaks
 * the protocol. Detected by the server primitives, because that is what
 * standing one up requires.
 */
function hasProtocolFixture(source) {
  // Standing one up, or — better — dialling a live server the suite
  // already requires. `postgres` does the second: the wire protocol is
  // large enough that a hand-written fixture would end up approximating
  // the startup handshake, which is the part most worth not
  // approximating. A fake binary on PATH counts too, for the types whose
  // "protocol" is an argv and an exit code.
  return /createServer|createSocket|net\.Server|dgram\.|http2\.createServer|tls\.createServer|TEST_DATABASE_URL|PATH=|mkdtemp/.test(
    source,
  );
}

/**
 * Types that dial nothing, so a protocol fixture is meaningless for
 * them: a group derives its state from children, a manual monitor is
 * whatever an operator said, and a push monitor is the one being
 * dialled. They have `derive`, `declare` and `observe` in place of a
 * probe.
 */
const DIALS_NOTHING = new Set(["group", "manual", "push"]);

/**
 * Types exempt from the protocol-fixture column, and why.
 *
 * Written here rather than quietly dropped from the check, because an
 * exemption nobody can see is indistinguishable from a gap nobody
 * noticed. Each one has to survive being read out loud.
 */
const FIXTURE_EXEMPT = {
  dns: "Its seam is an injected `DnsResolver`, deliberately: the probe must query the resolver the monitor names rather than the worker's own, and `check-dns.test.ts` drives that seam. A UDP fixture would have to override the system resolver to reach the probe, and what it would then exercise is `node:dns`, not this code.",
};

/**
 * Every test file, read once.
 *
 * A type's tests are not always in `check-<id>.test.ts` — the expiry
 * types share one file, the three non-active kinds share another. Asking
 * "which file is named after it" answered the wrong question and
 * reported eight false gaps; asking "which files exercise it" answers
 * the real one.
 */
function loadTests(root) {
  const files = [];
  for (const dir of ["unit", "integration"]) {
    const base = join(root, "tests", dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (name.endsWith(".test.ts")) {
        files.push({ path: join(dir, name), source: read(join(base, name)) });
      }
    }
  }
  return files;
}

/**
 * Test files that declare they cover this type, via a `@covers-type`
 * marker on their first line.
 *
 * Declared rather than inferred. Inferring it from imports or from the
 * id appearing in the source was tried and was wrong in both directions
 * — `check-http.test.ts` reaches the http probe through `performCheck`
 * and never names the module, while the string "http" appears in every
 * URL in every other file. A marker is one line per test file and it
 * cannot be wrong by accident; a type with no marker anywhere is a gap
 * this matrix should report, which is exactly what it does.
 */
function testsFor(files, id) {
  return files.filter((f) => {
    const first = f.source.split("\n", 1)[0];
    if (!first.startsWith("// @covers-type:")) return false;
    return first
      .slice("// @covers-type:".length)
      .split(",")
      .map((s) => s.trim())
      .includes(id);
  });
}

async function main() {
  const registry = readRegistry();
  const ids = Object.keys(registry).sort();

  const preservation = read(
    join(ROOT, "tests", "integration", "monitor-config-preservation.test.ts"),
  );
  const portability = read(
    join(ROOT, "tests", "integration", "monitor-portability.test.ts"),
  );

  const testFiles = loadTests(ROOT);

  const rows = ids.map((id) => {
    const spec = registry[id];
    const specSource = read(
      join(ROOT, "src", "modules", "monitors", "types", "specs", `${id}.ts`),
    );
    const owned = testsFor(testFiles, id);
    const unit = owned.map((f) => f.source).join("\n");
    const docPath = join(ROOT, "docs", "monitor-types", `${id}.md`);

    // A credential in the stored schema that is not declared is the one
    // failure this matrix can detect on its own, and the one that leaks.
    const looksSecret = /password|secret|token|community|passphrase/i.test(
      specSource.split("StoredSchema")[1]?.slice(0, 4000) ?? "",
    );
    const secretsDeclared = spec.secretFields.length > 0;

    const dials = !DIALS_NOTHING.has(id);

    return {
      id,
      kind: spec.kind,
      registered: true,
      probeOrKindFn: existsSync(
        join(ROOT, "src", "modules", "monitors", "types", "probes", `${id}.ts`),
      )
        ? true
        : !dials,
      assertions: spec.assertions.length > 0,
      secretsDeclared: looksSecret ? secretsDeclared : "n/a",
      configPreserved:
        preservation.includes(`"${id}"`) || preservation.includes(`${id}:`),
      exportImport:
        portability.includes(`"${id}"`) || portability.includes(`${id}:`),
      unitTest: owned.length > 0,
      protocolFixture:
        !dials || id in FIXTURE_EXEMPT ? "n/a" : hasProtocolFixture(unit),
      documented: existsSync(docPath),
      capability: spec.requiresCapability,
    };
  });

  const gaps = rows.flatMap((r) =>
    Object.entries(r)
      .filter(([k, v]) => v === false && k !== "documented")
      .map(([k]) => `${r.id}: ${k}`),
  );
  const undocumented = rows.filter((r) => !r.documented).map((r) => r.id);

  const artifact = {
    _: "Generated by scripts/dod-matrix.mjs. Do not edit — run `npm run dod`.",
    types: rows.length,
    rows,
    gaps,
    undocumented,
  };

  const mark = (v) => (v === "n/a" ? "—" : v ? "yes" : "**no**");
  const table = [
    "| Type | Kind | Probe | Assertions | Secrets declared | Config preserved | Export/import | Unit test | Protocol fixture |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| \`${r.id}\` | ${r.kind} | ${mark(r.probeOrKindFn)} | ${mark(r.assertions)} | ${mark(r.secretsDeclared)} | ${mark(r.configPreserved)} | ${mark(r.exportImport)} | ${mark(r.unitTest)} | ${mark(r.protocolFixture)} |`,
    ),
  ].join("\n");

  const rawPage = `# Definition of Done, by monitor type

Generated by \`scripts/dod-matrix.mjs\` from the repository itself. Do not
edit this file; run \`npm run dod\`.

Section 13 of the release reference lists what makes a monitor type
complete, and says plainly that a selector option, a registry entry or a
conformance test does not prove it. A hand-written table proves less
still — it records what someone believed on the day they typed it. So
every cell below is answered by looking at the code.

**What a "yes" means, and what it does not.** It means the artefact
exists: the file is there, the type appears in that suite, the test
stands up a real server. It does not mean the artefact is good. This
matrix can prove absence; it cannot prove quality. Reviewers still
review.

Columns that do not apply to a kind are \`—\`, not a failure. A \`group\`
monitor has no protocol fixture because it dials nothing, and scoring it
against one would make this table lie in the direction that flatters it.

${rows.length} types.

${table}

## Protocol-fixture exemptions

${
  Object.keys(FIXTURE_EXEMPT).length === 0
    ? "None."
    : Object.entries(FIXTURE_EXEMPT)
        .map(([id, why]) => `- \`${id}\` — ${why}`)
        .join("\n")
}

## Open gaps

${gaps.length === 0 ? "None. Every applicable cell above is satisfied." : gaps.map((g) => `- ${g}`).join("\n")}

## Documentation

Per-type pages live in \`docs/monitor-types/\`. ${
    undocumented.length === 0
      ? "Every type has one."
      : `${rows.length - undocumented.length} of ${rows.length} types have one; the rest are documented by their descriptor's own \`description\` and help text, which the form renders. The types without a page are: ${undocumented.map((i) => `\`${i}\``).join(", ")}.`
  }
`;

  // Run the page through prettier before it is written or compared.
  // The file is committed, so `format:check` has an opinion about it
  // too — and without this the two guards disagree forever: formatting
  // the page makes `dod:check` call it stale, and regenerating it makes
  // `format:check` call it unformatted.
  const page = await format(rawPage, PAGE);

  if (CHECK) {
    const current = read(PAGE);
    if (current.trim() !== page.trim()) {
      console.error(
        "docs/MONITOR-TYPE-DOD.md is stale. Run `npm run dod` to regenerate it.",
      );
      process.exit(1);
    }
    if (gaps.length > 0) {
      console.error(
        `Definition-of-Done gaps:\n${gaps.map((g) => `  ${g}`).join("\n")}`,
      );
      process.exit(1);
    }
    console.log(`dod: ${rows.length} types, no gaps`);
    return;
  }

  writeFileSync(PAGE, page);
  writeFileSync(ARTIFACT, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(
    `dod: ${rows.length} types, ${gaps.length} gaps, ${undocumented.length} without a page`,
  );
  if (gaps.length > 0) console.log(gaps.map((g) => `  ${g}`).join("\n"));
}

await main();
