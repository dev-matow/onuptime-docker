# Developer handbook

Day-to-day reference for working in this codebase.

## Commands

| Command                                 | What it does                                      |
| --------------------------------------- | ------------------------------------------------- |
| `npm run dev`                           | App with hot reload on :3000                      |
| `npm run worker:dev`                    | Worker with hot reload                            |
| `npm run db:migrate` / `db:generate`    | Apply / create SQL migrations                     |
| `npm run db:seed`                       | Wipe + recreate the demo organization             |
| `npm run demo:operations`               | Add its runbooks, tasks, objectives and journey   |
| `npm run db:studio`                     | Drizzle Studio (DB browser)                       |
| `npm test` / `npm run test:watch`       | Vitest unit + integration (needs Postgres)        |
| `npm run test:e2e`                      | Playwright golden path (starts dev server)        |
| `npm run lint` / `typecheck` / `format` | Quality gates                                     |
| `npm run screenshots`                   | Regenerate marketing screenshots from seeded data |
| `npm run build && npm start`            | Production build / serve                          |

The gates that fail for reasons a green suite cannot see. Run these
before pushing anything that touches a published surface, a check type,
the edition seam or a benchmark table:

| Command                | What it proves                                                              |
| ---------------------- | --------------------------------------------------------------------------- |
| `npm run format:check` | Prettier, enforced in CI since 1.23.0                                       |
| `npm run gate`         | Strip to Core, then lint, typecheck, test, build, migrate from empty, serve |
| `npm run facts:check`  | Every number this project publishes still agrees with the repository        |
| `npm run dod:check`    | The check-type Definition-of-Done matrix, regenerated from the registry     |
| `npm run kuma:check`   | The Uptime Kuma mapping matrix                                              |
| `npm run bench:check`  | Every published benchmark cell against the artifact it quotes               |
| `npm run dashes:check` | No em or en dashes on customer-facing surfaces                              |
| `npm run brand:check`  | The mark, on every surface that carries one                                 |
| `npm run shots:check`  | Every capture matches its manifest, its mirror and the pages naming it      |

`npm run facts` (no `:check`) rewrites the surfaces from the repository;
never edit a published number by hand. Backups are `npm run backup` /
`npm run restore -- <dump>` ([BACKUP.md](BACKUP.md)); the probe demo is
`./scripts/probe-demo.sh up` (`docs/PROBE-DEMO-SCRIPTS.md`);
the demo export the site serves is `npm run demo:build`
([DEMO.md](DEMO.md)).

## Layout

```
src/
├── app/               # Routes. Thin: guard → zod parse → service call.
│   ├── (auth)/        #   sign-in / sign-up / password reset
│   ├── (app)/         #   dashboard shell (sidebar); actions.ts per area
│   ├── (print)/       #   the print layout client reports render in
│   ├── status/        #   public, ISR-cached status pages
│   └── api/           #   Better Auth handler, demo login, and the three
│                      #   ingress routes: push, probe, synthetic artefacts
├── modules/           # Domain logic. No framework imports. The real product.
├── worker/            # pg-boss process: every background pass, plus the
│                      # high-frequency and probe-settlement planes.
├── synthetics-runner/ # The browser service. Its own image and manifest.
├── probe-agent/       # The remote agent. Its own image and manifest.
├── db/                # Drizzle client + schema (one file per context).
├── lib/               # env, guards (session.ts), permissions, editions, errors.
└── components/        # UI. components/ui = shadcn primitives (generated).
```

Full module-by-module breakdown and the reasoning behind the seams:
[ARCHITECTURE.md](../ARCHITECTURE.md) §2. Which of those directories are
commercial, and what a marker does: `docs/EDITIONS.md` §3.

## Conventions that keep the codebase coherent

- **Service signature**: `fn(db, actor, input)` where
  `actor = { organizationId, userId }` comes from a guard, never from
  the client. Services are the only layer that touches tables.
- **Action pattern**: every server action returns
  `ActionResult<T> = { ok: true, data } | { ok: false, error }`.
  Domain errors (`AppError` subclasses) surface their message; anything
  else logs and masks. Client components toast on `!result.ok`.
- **Guards**: `requireSession` → `requireOrgContext` →
  `requirePermission(permission)` (which also blocks DEMO_MODE).
  Pages use the first two + `hasPermission` for conditional UI.
- **Status rendering** goes through `src/components/status.tsx`;
  formatting through `src/lib/format.ts`. Don't inline either.
- **Timestamps** are `timestamptz`; day bucketing is always UTC.
- **Public surfaces** (status page, system-generated incident text)
  never include URLs or raw errors, check history and audit metadata
  keep the details internally.

## Testing strategy

- `tests/unit/`: pure logic (state machine, check evaluation, SSRF
  rules, schemas, formatting). No I/O.
- `tests/integration/`: every service against real Postgres
  (`vigil_test`, auto-migrated by the suite's global setup). Each test
  creates its own tenant via `tests/helpers.ts#createTestOrg`,
  parallel-safe, no truncation.
- `e2e/smoke.spec.ts`: the golden path through the real UI.

When adding a feature: unit-test its rules, integration-test its
service (including a cross-tenant `NotFoundError` case), and extend the
e2e only if it changes the golden path.

## Debugging

- `LOG_LEVEL=debug` prints every check result in the worker.
- Job queue introspection: the `pgboss` schema in Postgres
  (`select * from pgboss.job order by created_on desc limit 20`).
- A monitor stuck "Pending" usually means the worker isn't running,
  it's a separate process (`npm run worker:dev`).
