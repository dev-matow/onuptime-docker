import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The landing site is a standalone, framework-free static bundle — it is
    // not part of the Next.js app and is not linted with the app's ruleset.
    "landing/**",
  ]),

  // The one rule this repository cannot satisfy in both editions at once.
  // `src/lib/editions.ts` keeps the multi-organization default in a `let`
  // that only the commercial build reassigns — the file says why. The
  // `let` is correct upstream, because something really does assign to
  // it; `strip-ee` deletes that line, and `prefer-const` is then right
  // about the tree in front of it and wrong about the tree it cannot see.
  // No edit to the source satisfies both, which is what separates this
  // site from the other three that used the same idiom: those declare
  // their binding inside the commercial block now and are const-correct
  // in both editions.
  //
  // An inline disable would only move the failure. `linterOptions.
  // reportUnusedDisableDirectives` is on, so a directive the free
  // edition needs reports as an unused directive on every commercial
  // lint run, and the obvious tidy-up — deleting it — turns the edition
  // gate red again. A config entry is the only statement here that both
  // editions read the same way. One file, one rule: the file exists to
  // carry this seam and holds one `let`.
  {
    files: ["src/lib/editions.ts"],
    rules: { "prefer-const": "off" },
  },
]);

export default eslintConfig;
