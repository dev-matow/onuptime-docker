# Developer handbook

Day-to-day reference for working in this codebase.

## Commands

| Command                                 | What it does                                      |
| --------------------------------------- | ------------------------------------------------- |
| `npm run dev`                           | App with hot reload on :3000                      |
| `npm run worker:dev`                    | Worker with hot reload                            |
| `npm run db:migrate` / `db:generate`    | Apply / create SQL migrations                     |
| `npm run db:seed`                       | Wipe + recreate the demo organization             |
| `npm run db:studio`                     | Drizzle Studio (DB browser)                       |
| `npm test` / `npm run test:watch`       | Vitest unit + integration (needs Postgres)        |
| `npm run test:e2e`                      | Playwright golden path (starts dev server)        |
| `npm run lint` / `typecheck` / `format` | Quality gates                                     |
| `npm run screenshots`                   | Regenerate marketing screenshots from seeded data |
| `npm run build && npm start`            | Production build / serve                          |

## Layout

```
src/
├── app/          # Routes. Thin: guard → zod parse → service call.
│   ├── (auth)/   #   sign-in / sign-up
│   ├── (app)/    #   dashboard shell (sidebar); actions.ts per area
│   ├── status/   #   public, ISR-cached status pages
│   └── api/      #   Better Auth handler, demo login, push heartbeats
├── modules/      # Domain logic. No framework imports. The real product.
├── worker/       # pg-boss process: tick fan-out, checks, retention.
├── db/           # Drizzle client + schema (one file per context).
├── lib/          # env, guards (session.ts), permissions, logger, errors.
└── components/   # UI. components/ui = shadcn primitives (generated).
```

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
