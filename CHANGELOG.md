# Changelog — Vigil Core

Vigil Core and the commercial edition are cut from the same commit and
carry the same version number. This file records what that means for the
free edition; entries for commercial-only features live in the other
repository, because they are not in this one and listing them here would
describe software you do not have.

## 1.16.0 — 2026-08-03

Unlimited notification channels, in this edition too.

The cap of twenty channels per organization is gone and nothing replaced
it. Several instances of one provider are supported and always were at
the data layer: nothing about a channel has to be unique, and channels
are identified by id alone. Channels can now be scoped to specific
monitors, or left alone to act as workspace defaults.

Listing channels no longer decrypts credentials — the redacted
destination is a stored column — and dispatch resolves its routes in one
indexed query and enqueues in one insert. The settings list costs the
same at one channel and at a thousand; `npm run bench:channels`
reproduces the measurement.

### Upgrade

`npm run db:migrate`, then start the worker once. Migration 0024 is
additive and rewrites no secrets.

## 1.15.0 — 2026-08-03

Ten notification channel providers, and all of them are in this
repository: Slack, Discord, Microsoft Teams (the Workflows webhook;
the retired connector format is never sent), Telegram, Google Chat,
Gotify, ntfy, the signed webhook, SMTP and Resend. One editor, event
class routing (monitor down/up, incident lifecycle, certificate and
domain expiry), a send-test action, a delivery history with redacted
errors, credentials encrypted at rest, per-channel rate limiting and
Retry-After honored. The commercial edition routes two extra event
classes (recovery results, probe quorum) to the same channels; the
channels themselves are not held back.

### Changed

- The single organization webhook became a channel. The migration
  moves a configured endpoint into the registry by host and keeps its
  signing secret and wire format; the worker seals the migrated
  credentials at its first boot.

## 1.14.0 — 2026-08-02

The commercial edition added remote probe agents and a retention policy
for the data they produce. Both are commercial, so neither is in this
repository. Core gets two fixes and a correction.

### Fixed

- **Settings pages no longer scroll sideways on a phone.** The six
  section tabs sat in a row with nowhere to put the overflow, so on a
  375px screen they pushed the whole document wider than the viewport.
  The strip scrolls on its own now and all six tabs stay reachable.

- **This README said the minimum interval is two seconds.** It is two
  seconds on the ordinary scheduler and 500 ms for HTTP, JSON and TCP
  monitors on the high-frequency plane, which 1.13.0 shipped and this
  file never caught up with.

Both editions are cut from the same commit, which is why Core carries
the version number. Upgrading is still
`git pull && npm ci && npm run db:migrate`, and the one migration this
release adds creates no table Core has.

## 1.13.0 — 2026-08-01

Trust, and a migration path off Uptime Kuma. Everything below is in
Core: the check types, the importer, the uptime change and the
half-second plane are not commercial features.

### Added

- **Twenty-six check types, 14 → 40**: SSH, FTP, IMAP, LDAP, NTP,
  Memcached, Elasticsearch, UDP, gRPC, Kafka, RabbitMQ, SQL Server,
  Oracle, RADIUS, SNMP, WebSocket, Steam, GameDig, Tailscale, Globalping,
  systemd services, a real-browser check and SIP — plus `push`, `group`
  and `manual`, three monitors that dial nothing. A push heartbeat
  endpoint, groups that derive their state from members, and a status an
  operator sets by hand.
- **Import from Uptime Kuma 2.4.0.** Upload your `kuma.db`, review what
  will happen, confirm. All 31 of Kuma's selectable monitor types map,
  and every one of its 111 monitor columns is classified — nothing
  leaves Kuma without a line in the report saying what became of it.
- **Half-second checks**, on a data plane of their own so they cannot
  starve the ordinary scheduler or write a row per probe forever. 500 ms
  is a check interval, not a detection time; the measured limits are
  published rather than rounded up.
- **A durable outbox for notifications**: the decision to alert is
  written in the same transaction as the state change that caused it, so
  a crash between deciding and sending delivers late instead of never.
- **Export and import monitors** as JSON with credentials masked,
  **password reset**, and **backup/restore scripts** that refuse to
  restore over a database that already has tables.

### Changed

- **Uptime is weighted by duration, not by how many rows agree.** Two
  monitors watching the same outage at different intervals now report
  the same uptime. Time nobody measured is excluded rather than counted
  as up. **Your published percentages will move.**
- **Postgres enforces one active incident per monitor** instead of a
  read followed by a write. The migration reconciles duplicates an older
  install already has, keeping the oldest and closing the rest with the
  reason on their timeline.
- **One module decides every outbound request**, revalidating each
  redirect hop and pinning the socket to the address it checked.
- **An edit that never mentions a setting no longer clears it.**

### Fixed

- `tls-expiry` returned nothing for self-signed and already-expired
  certificates — the cases it exists to catch — because the handshake
  was validated before the certificate could be read.
- A monitor created by the importer could reach a private address that
  the create form would have refused.
- The worker could not start on a fresh database.
- A monitor enrolled in the half-second plane could be starved forever.
- On an account with more than one status page, the second page's
  settings controls drove the first page's.

## 1.12.0 — 2026-07-28

### Added

- **Eight check types, 6 → 14**: PostgreSQL, MySQL/MariaDB, MongoDB,
  Redis, Docker containers, MQTT brokers, SMTP and JSON query. No new
  dependencies — everything but Postgres speaks the wire protocol
  directly, because the small image is the point.
- **White-label status pages**: turn off the "Powered by Vigil" footer.
  Free, and it stays free.

### Fixed

- A monitor target that carries a credential — a Postgres connection
  string — is redacted before it reaches an incident email or a webhook.
- A host whose every address fails is now reported as a transport
  failure. Node reports that as an `AggregateError` with an empty
  message, which read as "no error" and let a dead server be judged on
  its assertions instead.
- `docs/UPGRADE.md` is Core's own, and says that 1.0.x has no in-place
  upgrade path. The mirror had been carrying the commercial edition's
  copy, which does not.

## 1.11.1 — 2026-07-28

`package-lock.json` in the 1.11.0 tag still named the commercial package
and carried its licence string. Nothing depends on it — `npm ci` works
either way — but an Apache-2.0 repository should not contain
`"SEE LICENSE IN LICENSE"`. Both editions are on 1.11.1 so their version
numbers match, which is the check this project asks you to make.

## 1.11.0 — 2026-07-28

**The first release generated from the shared tree**, and the reason the
version number jumps from 1.0.1: Core is no longer a hand-copy that has
to be kept up to date by remembering to. It is produced by deleting the
commercial code from the commercial tree, by the same script that runs in
that repository's build gate. If Core stops building, the release does
not exist.

### Added

- **Six check types behind a registry** — HTTP(S), TCP/port, ping (ICMP),
  DNS records, TLS-certificate expiry and domain-registration expiry.
  Adding one is five files and no dispatch to edit.
- **A condition engine** — assertions are typed and declared per check
  type, and a verdict is recomputable from the stored facts.
- **Adaptive scheduling** — the interval is a baseline the scheduler
  tightens on a suspicious monitor and relaxes on a steady one. The
  minimum is **2 seconds**, measured as what the queue delivers rather
  than what the form will accept.
- **Failure windows in seconds** rather than a count of consecutive
  checks, so "down for two minutes" survives a change of interval.
- **Many status pages per organization**, each with its own URL,
  components, visibility and subscribers.
- **Private and password-protected status pages.**
- **Double-opt-in email subscribers** on public pages, with one-click
  unsubscribe.
- **An audit page** — Core already recorded every mutation; it now has a
  screen to read them on.
- **The observation ledger** — hash-chained check history with per-actor
  sequences.
- **Incident acknowledgement.**

### Changed

- **Licence: AGPL-3.0-or-later → Apache-2.0** (from 1.0.2). No copyleft
  obligation: modify it, keep the changes private, run it for clients,
  sell it. Copies obtained under the AGPL remain available under it.

### Fixed

- **An organization was capped at 100 members**, from a library default.
  Two changes were needed and either alone leaves a wall; both are in.

### Upgrading from 1.0.x

1.0.x carried a single squashed migration that has been replaced by the
canonical lineage, so there is **no in-place upgrade path**. A 1.0.x
install is days old by construction; back up, start a fresh database,
migrate, and recreate your monitors. See [docs/UPGRADE.md](docs/UPGRADE.md).

## 1.0.1 — 2026-07-26

Public status page cache key now includes the slug.

## 1.0.0 — 2026-07-25

First public release: HTTP(S) monitoring with keyword assertions,
incidents, one public status page, four team roles and an audit trail.
Hand-copied from the commercial tree, which is the problem 1.11.0 fixes.
