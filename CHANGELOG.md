# Changelog

All notable changes to Vigil Core are documented here. Versions follow
[semantic versioning](https://semver.org): breaking changes bump the
major, additive features the minor, fixes the patch.

## Unreleased

Relicensed, and the seat cap nobody chose is gone. No schema migration.

### Changed

- **Licence: AGPL-3.0-or-later → Apache-2.0.** The AGPL was costing
  adoption and protecting nothing — section 13 fires only on _modified_
  versions offered over a network, so running stock Core for any number
  of clients never triggered it, while the licence itself is prohibited
  outright at companies large enough to have a policy. Apache also
  removes the need for a contributor agreement: under section 5 an
  inbound contribution already arrives on terms that let it ship in both
  editions, so there is nothing to sign and no copyright to assign.
  Copies obtained under the AGPL remain available under it; see NOTICE.

### Fixed

- **An organization was capped at 100 members.** better-auth's
  organization plugin defaults `membershipLimit` to 100 when the option
  is absent, and the commercial edition lifted it in its own 1.9.3.
  Fixing it needs _two_ changes and either one alone leaves a wall:
  `membershipLimit` on the plugin, and `membersLimit` on the
  `getFullOrganization` query. Measured against better-auth 1.6 rather
  than assumed:

  - Without `membershipLimit`, reading a 132-member organization throws
    `User not found for member` — the user lookup inside the join is
    what breaks, not the count.
  - With it but without `membersLimit`, the same call returns **exactly
    100** members and nothing says the list was cut short.
  - It does **not** gate `createInvitation` in this version; inviting
    past 100 succeeds either way. The list path is the whole bug.

  The member-list read now goes through one function,
  `getOrganizationWithAllMembers`, so there is a single place to get it
  wrong and a single place a test can hold it right. Three integration
  tests cover it, and each of the two fixes fails one when reverted.

## 1.0.1 — 2026-07-26

Patch release: a defensive fix carried over from the commercial edition.
No schema migration.

### Fixed

- **Public status page cache key now includes the slug.** The cached
  page query captured the slug in a closure rather than passing it as an
  argument, so Next derived the same cache key regardless of slug — it
  builds that key from the callback's source text, the key parts and the
  call arguments. Core is single-organization and status pages are
  unique per organization, so only one page can ever exist and no
  installation could hit this; the fix keeps it unreachable by
  construction rather than by circumstance.

## 1.0.0 — first public release

Vigil Core is the free, self-hostable uptime monitor: two processes and
one Postgres.

### Added

- **HTTP(S) monitoring** — per-monitor interval, timeout, expected
  status code, degraded-response threshold and consecutive-failure
  threshold. DNS is resolved before each probe and private address space
  is refused (SSRF guard) unless explicitly allowed for development.
- **Keyword/content assertions** — assert the response body contains, or
  does not contain, a string. A keyword failure is a hard down, so a
  200 that serves an error page is caught. The body is read under a 1 MB
  cap so a hostile response can't exhaust the worker.
- **Incidents** — opened and auto-resolved by the check loop, or created
  by hand. Severity, a status lifecycle (`investigating` → `identified`
  → `monitoring` → `resolved`, terminal), an append-only timeline,
  operator-only internal notes, and a markdown postmortem.
- **Public status page** — one per install: your own slug, per-monitor
  display names, 90-day uptime bars, active and recent incidents.
  Incrementally cached so an outage traffic spike doesn't hit the
  database on every view.
- **Notifications** — incident email to the team, plus per-organization
  signed webhooks. Slack and Discord message formatting is detected from
  the webhook URL host; every delivery carries an `X-Vigil-Signature`
  HMAC-SHA-256 over the exact body sent, retries transient failures with
  backoff, and never retries a permanent 4xx.
- **Team and roles** — invite teammates as owner, admin, responder or
  viewer. Viewers are read-only and are never sent signing secrets, at
  the server boundary rather than by hiding a button.
- **Audit trail** — every mutation recorded with actor, target and
  metadata.
- **Demo mode** — `DEMO_MODE=true` disables sign-up and every mutation
  and offers a one-click read-only login, for running a public demo.
- **Operations** — Docker images for app and worker, a one-shot migrate
  service, a `/api/health` endpoint that checks the database, structured
  JSON logs, and a nightly retention job that prunes check history past
  90 days.

161 tests (unit + integration) plus a Playwright end-to-end pass.
