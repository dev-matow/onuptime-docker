# Release evidence

What this release claims, and what proves it. One row per claim, and a
claim with no evidence says so rather than being left off the list.

The rule this file exists to enforce: **a narrow test cannot support a
broad claim.** "Alerts are reliable" is not proved by a test that a
function was called; it is proved by a crash between commit and send
leaving the message queued, and by a provider 500 producing a retry
rather than a log line.

Status values mean exactly one thing each:

- **SATISFIED** — the evidence in the right-hand column exists, runs, and
  passes.
- **PARTIAL** — some of the claim is proved and the rest is named.
- **NOT SATISFIED** — not built. Not a blocker, not deferred, not
  "roadmap": simply not done yet.
- **BLOCKED (external)** — waiting on an event outside this repository
  that cannot be manufactured.

Regenerate the counted numbers with `npm run facts`; verify them with
`npm run facts:check`.

---

## Baseline

|                       |                                                                   |
| --------------------- | ----------------------------------------------------------------- |
| Version               | `1.13.0` — manifest, both changelogs and `public-facts.json`      |
| Branch                | `release/trust-migration-1.13`                                    |
| Cut from              | `2b0177a` (`v1.12.0`)                                             |
| Core edition          | working `5cd0f86`, published `ddc0644` — unchanged by this branch |
| Billing bot           | not a Git repository; tree SHA-256 recorded per release           |
| Uptime Kuma pinned at | `2.4.0`, commit `9f3b837c8c7f359ec1acee80b3c0430451986a03`        |

The billing bot has no commits to name, so it is identified by hashing
its tree. A bare hash nobody can recompute identifies nothing, so the
recipe is here rather than in someone's shell history:

```sh
cd ../vigil-billing-bot
find . -type f \
  -not -path "./node_modules/*" -not -path "./.git/*" \
  -not -path "./.wrangler/*" -not -name "*.log" \
  -not -name ".dev.vars" -not -name "wise-details.txt" \
  | sort | xargs sha256sum | sha256sum
# 3fc8084dff793ec2a70de9b68aba8af5b025e5998339cc1216e9e3a93482de01
# 20 files, at 2026-08-01
```

`.dev.vars` and `wise-details.txt` are excluded by name and never read:
they hold live credentials and banking details, and a release document
has no business establishing what is in them — not even by hash.

---

## The matrix

| Claim                          | Status             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Uptime is correct**          | SATISFIED          | `src/modules/monitors/uptime.ts` is the one methodology. `tests/unit/uptime.test.ts` pins the semantics — irregular sampling, window boundaries, long gaps, first sample, unknown state, paused. `tests/integration/uptime-parity.test.ts` runs the pure definition and the SQL against the same randomised histories and asserts they agree. The headline case: the same ten-minute outage sampled at baseline and at the scheduler's 16× cadence reports the same number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Incident state is correct**  | SATISFIED          | Partial unique index `incidents_one_active_per_monitor` (migration `0015`). `tests/integration/incident-concurrency.test.ts` races real transactions: concurrent opens, concurrent transitions, terminal-state preservation, concurrent acknowledgement, double auto-resolution — plus a constraint proof that a direct insert bypassing every service guard is still refused. `tests/integration/upgrade-to-1.13.test.ts` builds a 1.12.0 database that already holds three live incidents for one monitor and upgrades it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Alerts are reliable**        | SATISFIED          | `notification_outbox` (migration `0016`) written in the same transaction as the decision that causes it. `tests/integration/notification-outbox.test.ts` covers a crash after commit and before sending, a crash after the provider accepted, 429, 500, timeout, redelivery, permanent rejection, attempt exhaustion, and a job delivered twice producing one notification. Delivery is at-least-once and `docs/NOTIFICATIONS.md` states that rather than claiming better.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Outbound requests are safe** | SATISFIED          | `src/modules/monitors/egress.ts` decides every outbound request. `tests/unit/egress.test.ts` covers redirect hops, DNS rebinding against a live server, private, loopback, link-local and metadata addresses, and approved exceptions. The residual — ten probes that open their own sockets and so perform a lookup the guard cannot see — is written down in `SECURITY.md` rather than papered over.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Monitor edits are safe**     | SATISFIED          | `src/modules/monitors/types/config.ts` implements read–merge–validate–write with explicit omitted/null/clear-secret semantics. `tests/integration/monitor-config-preservation.test.ts` and `monitor-portability.test.ts` both generate their cases from the registry, so a type cannot silently skip coverage. Export masks credentials and import refuses to write the mask; every input record produces exactly one outcome and a skip always carries a reason. Imports validate with the same schema the create form uses — writing them found that `createMonitor` alone was more permissive than the UI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Checkout is secure**         | SATISFIED          | Single-use claim tokens, Standard Webhooks timestamp freshness, durable replay dedup, retryable non-200 on internal failure, no payload in logs. One named test per acceptance item in the release reference.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Core matches Commercial**    | SATISFIED          | `scripts/edition-gate.sh` is a required CI job and exits 0: Core strips, lints, typechecks, tests, builds, migrates onto an empty database and serves. `scripts/publish-core.sh` records the exact Commercial SHA, validates the version against `package.json`, and copies the file set the gate proved. `scripts/public-facts.mjs --check` is a required job and was demonstrated failing on an introduced drift.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Kuma import is complete**    | SATISFIED          | Pinned to `2.4.0` at commit `9f3b837c`. A real `kuma.db` written by Kuma itself over its own API. All 31 selectable types map; every one of the `monitor` table's 111 columns carries a classification, asserted against the fixture so an added or forgotten column fails the build. Both tables are published as `kuma-mapping.json`, generated from the importer's own data by `scripts/kuma-matrix.mjs` and guarded by `npm run kuma:check` in CI, so a reviewer outside the TypeScript build can read the mapping the importer actually branches on. Group hierarchy, notification providers and their links, and the status page with its monitors are carried; the Kuma public _section_ Vigil's flat list cannot hold gets its own report line. 27 of the fixture's 31 monitors import and four are refused, each by a rule that exists for a reason — none weakened. Two-click flow at `/settings/import`, whose summary is a real dry run against the uploaded file. `docs/KUMA-IMPORT.md` states type coverage and monitor outcomes as the two different numbers they are. |
| **40 types are ready**         | SATISFIED          | 40 registered types, one registry. `docs/MONITOR-TYPE-DOD.md` is generated by `scripts/dod-matrix.mjs` from the code and reports **no open gaps**: every type has its probe or kind function, assertions, declared secrets, config preservation, export/import round trip, unit tests and a protocol-level fixture. `npm run dod:check` is the guard. The one fixture exemption (`dns`, whose seam is an injected resolver by design) is stated in its own section of the page rather than dropped from the check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **500 ms is real**             | SATISFIED          | `src/modules/monitors/highfreq/` is a separate plane: leases, monotonic clock, one probe in flight per monitor, micro-batch writes, minute/hour/day rollups. `scripts/bench/high-frequency.mjs` measured N=1/10/100/1000 with raw JSON in `docs/evidence/bench/`, and `npm run bench:check` compares every cell of the published table against the artefact it quotes — it was demonstrated failing on a table edited to read 2000.00/s with zero missed slots. Cadence holds exactly to 100 monitors (p99 508 ms, zero missed slots); at 1000 it does not, and `docs/HIGH-FREQUENCY.md` publishes that rather than the flattering number.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Price is justified**         | BLOCKED (external) | Requires paid pilots, case studies and real support-cost data. Cannot be produced from this repository.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Launch is ready**            | BLOCKED (external) | Requires five external installations not performed on the author's machine, a proof/soak period, and real migration attempts. The repository-local halves are done and logged: `docs/evidence/fresh-install.log` (clean install through QUICK_START.md's own path) and `docs/evidence/upgrade.log` (a real v1.12.0 install, populated, migrated to 19 migrations with every setting and secret preserved), and `docs/evidence/backup-restore.log` (the same install dumped, dropped, restored, and hashed identical).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

---

## What no public surface may say yet

Enforced by `npm run facts:check` where it is a number, and by review
where it is a sentence:

- `500 ms detection` — cadence was measured; detection was not.
- `1,000 monitors at 500 ms` — measured, and it does not hold. 100 does.
- `Imports all 31 Uptime Kuma monitor types` — all 31 types map, and 27
  of the pinned fixture's 31 monitors import. The bare sentence is read
  as the second number, which is why `docs/KUMA-IMPORT.md` leads with
  both and a test forbids that exact phrasing.
- `Imports everything from Uptime Kuma` — notification providers, tags
  and maintenance windows have no Vigil counterpart and are reported,
  not carried.
- `Full Kuma import` without naming `2.4.0` and linking the mapping
  matrix.
- `Production-ready` — the trust work is done, the external evidence is
  not.
- Any manually copied test total. `public-facts.json` is the only source.

## Commands

```sh
npm run typecheck                                   # 0
npm run lint                                        # 0
npx vitest run                                      # see docs/MONITOR-TYPE-DOD.md for the count
E2E_BASE_URL=http://localhost:3210 PORT=3210 \
  E2E_WEB_COMMAND="npm run start" npx playwright test  # 8 passed — docs/evidence/e2e.log
npm run facts:check                                 # 0
npm run dod:check                                   # 0 — no Definition-of-Done gaps
npm run kuma:check                                  # 0 — 31/31 types, 111 columns
npm run bench:check                                 # 0 — the table quotes the artefacts exactly
bash scripts/edition-gate.sh                        # 0 — docs/evidence/core-gate.log
npm run backup && npm run restore                   # docs/evidence/backup-restore.log
npm run db:migrate                                  # docs/evidence/fresh-install.log
npx drizzle-kit check                               # 0 — no schema/journal disagreement
docker build --target web|worker .                  # 0, both
node scripts/bench/high-frequency.mjs …             # see docs/HIGH-FREQUENCY.md
```

`npm run format:check` reports 25 files. Every one of them was already
unformatted at `v1.12.0` — mostly the landing site's hand-written HTML
and CSS. Nothing this branch wrote or touched is among them. It is not
wired into CI, and the number is recorded here so a later reader can
tell a standing condition from a regression.
