# Customization guide

Where to change things, in the order people usually want to.

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
- **New check type (TCP/port/heartbeat)** — HTTP(S) checks with
  keyword/content assertions already ship (`bodyKeyword` /
  `keywordAbsent` on a monitor). To add another transport, add a probe
  next to `performHttpCheck` in `src/modules/monitors/check.ts`, dispatch
  to it from `src/worker/jobs/monitor-check.ts`, add config columns to
  `src/db/schema/monitors.ts` plus a migration, and surface them in
  `monitor-form.tsx`.
- **More alert channels (PagerDuty/SMS/Opsgenie)** — email, Slack,
  Discord and signed webhooks already ship; Slack and Discord are
  auto-detected by webhook host. To add another, the worker's
  `becameDown`/`becameUp` branches in
  `src/worker/jobs/monitor-check.ts` are the single dispatch point, and
  `src/modules/notifications/` is where formatting lives.

## Removing features

Each module is a folder with its routes: deleting status pages is
removing `src/modules/status-pages`, its two route folders and the
sidebar link; deleting the audit trail is removing `src/modules/audit`
and its call sites. Nothing else reaches into them.
