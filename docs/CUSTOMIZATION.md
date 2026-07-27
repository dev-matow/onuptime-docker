# Customization guide

Where to change things, in the order buyers usually want to.

## Branding

| What                           | Where                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Product name & logo            | `src/components/logo.tsx` (one component, used everywhere)                                            |
| App metadata / titles          | `src/app/layout.tsx` (`metadata`), per-page `metadata` exports                                        |
| Design tokens (colors, radius) | `src/app/globals.css` — `:root` and `.dark` blocks; every component reads these variables             |
| Fonts                          | `src/app/layout.tsx` (`next/font` definitions)                                                        |
| Status color vocabulary        | `src/components/status.tsx` — the single source for status/severity rendering                         |
| "Powered by Vigil" footer      | `src/app/status/[slug]/page.tsx` — one line on the public status page; delete it to fully white-label |
| Landing page copy              | `src/app/page.tsx` (in-app) and `landing/index.html` (sales page)                                     |

The theme system is class-based (`next-themes`): both light and dark
palettes live in `globals.css`. Change a token once and every screen —
including the public status page — follows.

## Roles & permissions

One file: `src/lib/permissions.ts`. Add a resource/action to the
`statement`, grant it to roles, and it is enforced everywhere —
server actions (`requirePermission`), Better Auth endpoints and
conditional UI (`hasPermission`) all read this matrix. Roles are plain
strings stored on the membership row; adding a fifth role is additive.

## Domain changes

The layering rule is `routes → services → tables`:

1. **Schema** — add columns/tables in `src/db/schema/*`, then
   `npm run db:generate && npm run db:migrate`.
2. **Service** — extend the module in `src/modules/<context>/service.ts`
   (functions take `(db, actor, input)`; keep org-scoping in queries).
3. **Action** — thin wrapper in `src/app/(app)/<area>/actions.ts`:
   guard → zod parse → service → `revalidatePath`.
4. **UI** — server component fetches via the service; client components
   call the action and toast on error.

Worked examples to copy from: monitors (full CRUD), incidents
(state machine + timeline), status pages (public read model).

## Common extensions

- **Real email delivery** — implement `EmailTransport` in
  `src/modules/notifications/index.ts` and call `setEmailTransport`
  at startup (worker + app). Everything already sends through it.
- **A new check type** — since 1.10.0 types live in a registry at
  `src/modules/monitors/types/`, and adding one touches five files and
  no existing code path:

  1. a descriptor in `types/catalog.ts` — label, target field, the facts
     the type can emit, which form sections it uses. This module is
     imported by the browser, so it must stay free of zod and of every
     `node:` import;
  2. a spec in `types/specs/<id>.ts` — a zod schema for its stored
     config, a target schema, its assertions, `fromRow` and
     `describeTarget`;
  3. a probe in `types/probes/<id>.ts` — measures, and returns facts.
     It must never return `ok` or `degraded`: types measure, the runner
     judges, and every downstream behaviour depends on the verdict
     being recomputable from stored facts;
  4. an entry in `types/specs/index.ts` — this is the one that is easy
     to miss, and missing it produces a type that appears in the form's
     selector and then fails validation with "Unknown check type",
     because the action layer resolves specs from that map and never
     touches the registry;
  5. one line in `types/registry.ts` joining the spec to the probe.

  The conformance suite (`tests/unit/check-registry.test.ts`) then
  applies every rule to your type automatically — that its assertions
  only read facts it declares, that `fromRow` survives a junk config
  blob, that a required port is actually asked for in the form. There is
  no dispatch to edit, no `switch` to extend, and no migration: the
  type's settings go in the `config` jsonb column.

  Ship it as `types/commercial/` if it must not appear in Vigil Core — a
  feature flag would leave the source in the public tree.

- **More alert channels (PagerDuty/Opsgenie)** — email, Slack,
  Discord and signed webhooks already ship; Slack and Discord are
  auto-detected by webhook host. So do SMS and voice, through your own
  Twilio account, along with on-call schedules and escalation policies
  (since 1.8.0). To add another provider, the reconciliation branches in
  `src/worker/jobs/monitor-check.ts` are the single dispatch point, and
  `src/modules/notifications/` is where formatting lives.
- **Recovery receivers** — the product side is done (signed trigger,
  verify-before/after, bounds, immutable record); your side is the
  endpoint. Start from `examples/recovery-receiver.mjs` and the
  per-platform commands + systemd/Kubernetes manifests in
  `examples/recovery-templates.md`; anything that
  verifies `X-Vigil-Signature` and restarts a service qualifies. New
  action kinds belong in `src/worker/jobs/recovery.ts` behind the same
  attempt record.
- **More AI actions** — follow `src/modules/ai/incident-ai.ts`: build a
  prompt from owned data, add a rate-limited action, keep output in an
  editable form.

## Removing features

Each module is a folder with its routes: deleting AI is removing
`src/modules/ai` + the two actions + two buttons; deleting status pages
is removing the module, its two route folders and the sidebar link.
Nothing else reaches into them.
