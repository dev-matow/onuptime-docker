# Changelog

All notable changes to Vigil Core are documented here. Versions follow
[semantic versioning](https://semver.org): breaking changes bump the
major, additive features the minor, fixes the patch.

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
