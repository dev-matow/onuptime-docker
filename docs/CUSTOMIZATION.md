# Customization guide

Where to change things, in the order buyers usually want to.

## Branding

| What                           | Where                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Product name & logo            | `src/components/logo.tsx` (one component, used everywhere)                                           |
| App metadata / titles          | `src/app/layout.tsx` (`metadata`), per-page `metadata` exports                                       |
| Design tokens (colors, radius) | `src/app/globals.css`: `:root` and `.dark` blocks; every component reads these variables             |
| Fonts                          | `src/app/layout.tsx` (`next/font` definitions)                                                       |
| Status color vocabulary        | `src/components/status.tsx`: the single source for status/severity rendering                         |
| "Powered by Vigil" footer      | `src/app/status/[slug]/page.tsx`: one line on the public status page; delete it to fully white-label |
| Landing page copy              | `src/app/page.tsx` (in-app) and `landing/index.html` (sales page)                                    |

The theme system is class-based (`next-themes`): both light and dark
palettes live in `globals.css`. Change a token once and every screen,
including the public status page, follows.

## Roles & permissions

One file: `src/lib/permissions.ts`. Add a resource/action to the
`statement`, grant it to roles, and it is enforced everywhere,
server actions (`requirePermission`), Better Auth endpoints and
conditional UI (`hasPermission`) all read this matrix. Roles are plain
strings stored on the membership row; adding a fifth role is additive.

## Domain changes

The layering rule is `routes → services → tables`:

1. **Schema**: add columns/tables in `src/db/schema/*`, then
   `npm run db:generate && npm run db:migrate`.
2. **Service**: extend the module in `src/modules/<context>/service.ts`
   (functions take `(db, actor, input)`; keep org-scoping in queries).
3. **Action**: thin wrapper in `src/app/(app)/<area>/actions.ts`:
   guard → zod parse → service → `revalidatePath`.
4. **UI**: server component fetches via the service; client components
   call the action and toast on error.

Worked examples to copy from: monitors (full CRUD), incidents
(state machine + timeline), status pages (public read model).

## Common extensions

- **Real email delivery**: implement `EmailTransport` in
  `src/modules/notifications/index.ts` and call `setEmailTransport`
  at startup (worker + app). Everything already sends through it.
- **A new check type**: since 1.10.0 types live in a registry at
  `src/modules/monitors/types/`, and adding one touches five files and
  no existing code path:

  1. a descriptor in `types/catalog.ts`: label, target field, the facts
     the type can emit, which form sections it uses. This module is
     imported by the browser, so it must stay free of zod and of every
     `node:` import;
  2. a spec in `types/specs/<id>.ts`: a zod schema for its stored
     config, a target schema, its assertions, `fromRow` and
     `describeTarget`;
  3. a probe in `types/probes/<id>.ts`: measures, and returns facts.
     It must never return `ok` or `degraded`: types measure, the runner
     judges, and every downstream behavior depends on the verdict
     being recomputable from stored facts;
  4. an entry in `types/specs/index.ts`: this is the one that is easy
     to miss, and missing it produces a type that appears in the form's
     selector and then fails validation with "Unknown check type",
     because the action layer resolves specs from that map and never
     touches the registry;
  5. one line in `types/registry.ts` joining the spec to the probe.

  The conformance suite (`tests/unit/check-registry.test.ts`) then
  applies every rule to your type automatically, that its assertions
  only read facts it declares, that `fromRow` survives a junk config
  blob, that a required port is actually asked for in the form. There is
  no dispatch to edit, no `switch` to extend, and no migration: the
  type's settings go in the `config` jsonb column.

  If it must not appear in Vigil Core, mark each of its own files with
  `// @edition:ee` on the first line, and give the four lines it adds to
  the shared files (the import and the map entry, in `registry.ts` and
  `specs/index.ts`) a trailing `// @edition:ee`; the catalog entry goes
  in an `// @edition:ee-start` / `-end` block. The strip deletes marked
  files outright and marked lines in place, so the source never reaches
  the public tree; a feature flag would leave it there. The two
  scripted-synthetic types are the worked example, and
  `docs/EDITIONS.md` §3 is the rule.

- **Another notification provider**: twenty-five native provider types
  already ship (PagerDuty, Jira Service Management, Slack, Discord,
  Teams, Telegram, the push services, Twilio, SMTP, Resend, signed
  webhooks, Amazon SNS and the rest), plus a bridge to your own Apprise
  server, unlimited channels, and on-call schedules and escalation
  ladders on top. Adding one is a file in
  `src/modules/notifications/providers/` and a line in the
  `CHANNEL_PROVIDERS` array in that directory's `index.ts`: the channel
  editor, the docs generator and the public provider count all read that
  array, so a provider that is not in it does not exist anywhere and no
  surface can claim one that is not shipped. Set
  `capabilities.native: false` if what you are adding is a bridge rather
  than an integration, so it is not counted as one.
  [NOTIFICATIONS.md](NOTIFICATIONS.md) is the full picture, including the
  outbox every provider delivers through.
- **Who gets told, rather than how**: that is not a code change. Alert
  routing policies decide it from the product
  (`docs/ALERT-ROUTING.md`), and maintenance windows decide
  when nobody is told at all (`docs/MAINTENANCE.md`).
- **Recovery receivers**: the product side is done (signed trigger,
  verify-before/after, bounds, immutable record); your side is the
  endpoint. Start from `examples/recovery-receiver.mjs` and the
  per-platform commands + systemd/Kubernetes manifests in
  `examples/recovery-templates.md`; anything that
  verifies `X-Vigil-Signature` and restarts a service qualifies. A new
  kind of automation is a **runbook step type**, not a second recovery
  path: add a descriptor to the registry in
  `src/modules/runbooks/registry.ts` with its implementation under
  `src/modules/runbooks/actions/`, and it inherits the durable run, the
  approvals, the resource leases and the append-only attempt record
  (`docs/RUNBOOKS.md`). The per-monitor recovery action stays
  what it is: one endpoint, one fixed shape.
- **More AI actions**. Follow `src/modules/ai/incident-ai.ts`: build a
  prompt from owned data, add a rate-limited action, keep output in an
  editable form.

## Removing features

Each module is a folder with its routes: deleting AI is removing
`src/modules/ai` + the two actions + two buttons; deleting status pages
is removing the module, its two route folders and the sidebar link.
Nothing else reaches into them.
