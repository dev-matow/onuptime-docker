import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every path the images COPY, and every file they start, exists.
 *
 * This is the cheapest half of `docker build` and the only half that can
 * be checked without a daemon. A `COPY` whose source was renamed, moved
 * or deleted does not fail a single test in this repository: it fails in
 * the `docker` CI job, minutes later, in a log nobody reads until the
 * release is blocked - and on a machine with no container runtime it
 * cannot be caught at all.
 *
 * NOT marked `ee`, and it does not need to be. Core ships `Dockerfile`
 * and does not ship the other two, so the file discovers which images
 * are present instead of carrying an edition marker. That way the free
 * edition keeps the guard for the image it does ship, and a
 * commercial-only image that went missing from Core would be a fact
 * about the strip rather than a failure here.
 *
 * It deliberately does NOT try to be a Dockerfile parser. It reads
 * `COPY` lines, drops the ones that copy from an earlier build stage
 * (those name a stage, not a repository path), and checks the rest.
 */

const ROOT = join(import.meta.dirname, "..", "..");

/** Present in both editions / commercial only. The strip decides. */
const IMAGES = ["Dockerfile", "Dockerfile.probe", "Dockerfile.synthetics"];

function copySources(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const raw of dockerfile.split("\n")) {
    const line = raw.trim();
    if (!/^COPY\s/i.test(line)) continue;
    // `COPY --from=deps /app/node_modules ./node_modules` names a stage,
    // not something in this repository.
    if (/--from=/.test(line)) continue;
    const parts = line
      .replace(/^COPY\s+/i, "")
      .split(/\s+/)
      .filter((part) => part.length > 0 && !part.startsWith("--"));
    // The last argument is the destination inside the image.
    sources.push(...parts.slice(0, -1));
  }
  return sources;
}

/** The `.ts`/`.js` files an image's CMD or HEALTHCHECK actually starts. */
function entrypointFiles(dockerfile: string): string[] {
  return [...dockerfile.matchAll(/"(src\/[^"]+\.[cm]?[jt]s)"/g)].map(
    (match) => match[1]!,
  );
}

describe.each(IMAGES.filter((name) => existsSync(join(ROOT, name))))(
  "%s",
  (name) => {
    const dockerfile = readFileSync(join(ROOT, name), "utf8");

    it("copies only paths that exist in this repository", () => {
      const missing = copySources(dockerfile).filter(
        (source) => !existsSync(join(ROOT, source)),
      );
      expect(
        missing,
        `${name} copies ${missing.join(", ")}, which is not in the tree, so the image cannot build`,
      ).toEqual([]);
    });

    it("starts a file that exists", () => {
      // `CMD ["node_modules/.bin/tsx", "src/.../index.ts"]` - the binary
      // comes from the install, the script comes from the repository, and
      // it is the script that gets renamed.
      const entries = entrypointFiles(dockerfile);
      const missing = entries.filter((file) => !existsSync(join(ROOT, file)));
      expect(
        missing,
        `${name} starts ${missing.join(", ")}, which is not in the tree`,
      ).toEqual([]);
    });

    it("names a base image with a tag rather than floating on latest", () => {
      // An untagged base is the same class of drift as an unpinned
      // dependency: the image changes under a rebuild nobody made.
      //
      // `FROM deps AS builder` is not that. It names an earlier STAGE in
      // the same file, which has no tag and should not have one - the
      // first version of this assertion did not know the difference and
      // reported the multi-stage build as a defect.
      const stages = new Set(
        [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((match) =>
          match[1]!.toLowerCase(),
        ),
      );
      const bases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gim)].map(
        (match) => match[1]!,
      );
      expect(bases.length).toBeGreaterThan(0);
      const untagged = bases.filter(
        (base) =>
          !stages.has(base.toLowerCase()) &&
          !base.includes(":") &&
          !base.startsWith("$"),
      );
      expect(
        untagged,
        `${name} has an untagged FROM: ${untagged.join(", ")}`,
      ).toEqual([]);
    });
  },
);
