# Changelog — Vigil Core

Vigil Core and the commercial edition are cut from the same commit and
carry the same version number. This file records what that means for the
free edition; entries for commercial-only features live in the other
repository, because they are not in this one and listing them here would
describe software you do not have.

## 1.22.0 — 2026-08-18

Everything in this release is in this edition. The night scheme is the
application's own stylesheet and the README is this repository's.

### Added

- **The console follows the operating system's color scheme.** Light
  is the porcelain look the redesign shipped; dark is the same
  structure on GitHub Primer's dark palette (canvas `#0d1117`, ink
  `#f0f6fc`, borders `#3d444d`), switching live when the system does.
  The status page's manual toggle still outranks the system
  preference. No component changed: the dark scheme is a token remap
  behind the existing `.dark` class.
- **A README that shows the product.** One dashboard screenshot became
  a grid of ten, and every capture was taken from a running build of
  this edition, so nothing pictured is commercial-only.

## 1.21.0 — 2026-08-12

The scheduler fixes from this release are all in this edition. The fleet
view is not.

### Fixed

- **A fleet that was behind stayed behind, and nothing said so.**
  Measured: 1000 monitors on a 60-second interval need 16.67 checks a
  second, one worker delivered 10.10, the backlog aged to 185 seconds and
  never cleared, 793 expected observations never happened and 4% of the
  fleet went unprobed for the whole window. Nothing failed and nothing
  logged; uptime was computed over less of the window than it should have
  been. Throughput is not what changed - both builds keep up from two
  workers on - the backlog is: its age at two workers went from 106
  seconds to 2.1.

  `findDueMonitors` also took `limit = 500` as a default argument nobody
  passed. That bound is now `MONITOR_SCHEDULER_BATCH`, defaulting to
  5000, and where it actually binds was measured rather than asserted:
  not at 1000 or 2000 monitors on a 60-second interval, because a
  monitor due before the next tick schedules its own next check and
  never asks the tick at all.

- **A tick re-enqueued monitors whose checks were still running.** The
  queue permits one queued job beside the active one, and selection did
  not know it had already asked. The tick now claims what it selects, so
  two ticks running at once take disjoint sets. This is stated as an
  invariant rather than as a bug count: measured on clean trees, both
  builds produced zero duplicate observations, so the claim closes a
  hole rather than fixing an observed fault.

- **One organization with a large fleet starved the others.** Selection is
  ranked within the organization now, as the notification drain already
  was.

- **The fan-out was a round trip per monitor per tick.** Now one batched
  insert.

### Not in this edition

The worker heartbeat table and the Workers page are commercial. Adding a
second worker is safe here and always was - Postgres arbitrates the cron,
the tick and each check - but this edition has nothing that shows you the
fleet.

## 1.20.0 — 2026-08-12

Almost nothing, and that is the honest summary. The release is two
commercial features — maintenance windows and alert routing policies —
and neither is in this edition. What reached Core is the seam they attach
to and one correction.

### Changed

- **A dispatch asks two questions before it resolves a route.** "May
  anything go out about this?" and "which channels?". Core registers no
  answer to either, so both return "no opinion" and routing is decided by
  the channel subscriptions exactly as it was: same query, same
  behaviour, same messages. The registry exists so the commercial edition
  can be a registration rather than a branch in this code. See
  `docs/NOTIFICATIONS.md`.

- **The importers no longer claim Vigil has no maintenance windows.**
  Five source systems' maintenance schedules were reported as unimported
  with that sentence attached, and the commercial edition now has them,
  so the sentence was wrong. This edition still does not: the schedules
  are reported by name as unimported, without the advice.

## 1.19.0 — 2026-08-12

The migration system, and an audit of what the product claims about
itself. All of the defects below are in this edition.

### Added

- **Migrate from fifteen monitoring services.** Fourteen hosted
  providers through their own APIs, plus an Uptime Kuma database file.
  Every source check is translated, reported on by name, and either
  imported or refused with a reason. A check Vigil cannot honestly
  reproduce is listed rather than approximated: a monitor that watches
  something subtly different from what you asked for is worse than one
  that was never created.

- **Every check type is configurable from the dashboard.** A type now
  declares its own settings as data, and the monitor dialog renders
  them. Twenty-four of the forty types previously stored settings that
  no control could reach, so a monitor created here took whatever the
  schema defaulted to and there was no supported way to change it. The
  conformance suite compares the dialog against the registry, so a type
  cannot ship with a setting nobody can enter.

### Fixed

- **A read-only member could read a database password out of the page
  source.** A `postgres` or `sqlserver` monitor is addressed by a
  connection string, and the catalog's own placeholder tells the
  operator to put the password in it. The monitors list and the monitor
  page both crossed that string into a client component, so it landed in
  the page source of anyone who could open them, including a viewer,
  whose permissions are otherwise empty. The target is now stripped of
  its credential on every read path, masked rather than hidden in the
  edit dialog so the operator can still edit around it, and restored
  from storage when the mask comes home untouched. The audit trail and
  the export carried their own copies; both are closed.

- **A password-protected Redis read as healthy.** With no password
  control the probe sent a bare `PING`; a server wanting `AUTH` answers
  with an error rather than a pong, the assertion declined to judge a
  non-boolean, and the verdict was up. Fixed by the configuration work
  above rather than by a special case.

- **Nine check types reported false outages** against a target that
  needed a setting the dialog could not supply, and five more reported a
  permanent `misconfigured`. Both classes are closed by the same change.

- **Running an Uptime Kuma migration twice created a second copy of
  every monitor.** Monitors now record which source record they came
  from, as a digest rather than the id itself, with uniqueness enforced
  by Postgres. The Kuma path also gained the per-monitor savepoint the
  provider engine already had, so one row Postgres refuses is one
  skipped line rather than an aborted import.

- **A synchronous connect failure could kill the worker.** The pinned
  transport answered DNS inside the caller's stack, so a host with no
  route to the pinned address raised `ENETUNREACH` before the error
  listener was attached. An `error` event with no listener is an uncaught
  exception, and the process that died was the one doing the monitoring,
  at the moment the network broke.

### Changed

- **Why monitor credentials are not encrypted at rest is written down**
  in `docs/BACKUP.md`, next to the dump it actually matters for. Channel
  secrets are sealed; monitor credentials are not, and the reasoning for
  the asymmetry is now stated rather than left to look like an oversight.

## 1.18.3 — 2026-08-04

Findings from an adversarial security review. Four defects, three of them
on paths reachable without an account. All four are in this edition.

### Fixed

- **The outbound egress guard failed open when its own DNS lookup
  failed.** A lookup that threw became an empty address list; the
  classification loop then had nothing to refuse, no address was pinned,
  and the request was handed to the global `fetch`, which resolves a
  second time with no classification and no pin. The premise in the code
  was that the transport "will fail identically"; it is a separate
  getaddrinfo and is free to succeed, so one dropped UDP packet was
  enough - and an attacker-controlled nameserver did not have to stop at
  one. This affected every HTTP-family check, every HTTP notification
  provider and webhook delivery, including the `monitor` channel whose
  shipped policy forbids private space. A hostname that does not resolve
  is now refused, carrying the resolver's own error, so a domain that
  stopped resolving is still reported as down.
- **A notification worker that had lost its lease still sent.**
  `renewLease` is fenced but returned nothing, so an update matching zero
  rows - somebody else owns this delivery now - looked exactly like
  success. The fence then refused to record the outcome, which protects
  the ledger and not the person whose phone rang twice. The shipped
  defaults reach this unaided: a 250-row batch at 4 concurrent with a 10s
  timeout runs past the 600s lease. Losing the lease now skips the send.
- **The status-page password gate was unthrottled.** It verifies with
  `scryptSync`, which is synchronous and ~32ms, on a public endpoint that
  needs no account - about thirty requests a second to saturate a process
  and stall everything else. Now capped per page, well above anyone
  typing a shared password, and a refusal is indistinguishable from a
  wrong password so it reveals nothing about which pages exist.
- **The rate limiter never released a key.** Its keys arrive with the
  request - a push token, an email address, a page slug - and nothing
  removed them, so guessing tokens grew the map for the life of the
  process (500k keys measured at 132 MB). Bounded and swept now. The push
  endpoint also hashes the token before using it as a key, which the
  probe endpoint already did.

### Changed

- `next` 16.2.10 -> 16.2.12, clearing seven advisories. `shadcn` moved to
  `devDependencies`: nothing imports it at runtime, and it was the only
  reason `undici` was in a production install.

## 1.18.2 — 2026-08-04

An incident transition and the record that its consequences are owed now
commit together. Everything below follows from that one change.

### Fixed

- **A worker that died after claiming an incident's notification left it
  open, marked notified, and silent - permanently.** The claim is
  exactly-once by design and committed on its own; the notifications
  were assembled afterwards, and a process killed in that tail had
  already spent the claim. The repair path added in 1.18.1 requires an
  unspent claim, so nothing could ever page for that outage.
  Reproduced against the live schema before it was changed. The claim
  and a durable dispatch intent now commit in one transaction.
- **The all-clear could be lost the same way, and worse.** Every repair
  predicate in the incident module reads `status <> 'resolved'`, so a
  resolved incident is invisible to all of them: subscribers told an
  outage had started were never told it ended, and nothing would
  notice. The resolve now writes what it owes inside the transaction
  that closes the incident.
- **Two operators posting updates during one outage produced one
  broadcast.** The key identifying the transition was read from the
  timeline AFTER the commit, so both callers computed the same one and
  the outbox dropped the second. Reproduced on two connections. It is
  now the id of the row the transaction itself inserted.
- **Deleting a monitor mid-outage told nobody.** 1.18.1 closed the
  orphaned incident; it announced nothing, so status-page subscribers
  were left believing the outage was live, permanently.
- **An operator resolving an incident by hand sent no all-clear to the
  people who had been paged.** Only the automatic path sent one.
- **`savePostmortem` wrote by id alone**, the one statement in the
  incident module without a tenant predicate.

### Changed

- **Status-page subscriber emails go through the outbox.** They were the
  last direct transport in the product: no key, no retry, no attempt
  evidence, no dead letter, no ledger entry, for the one audience that
  is not staff. One row per (page, subscriber), so one failure cannot
  affect another. The message is rendered at DELIVERY rather than at
  enqueue, because the unsubscribe link is a bearer token that never
  expires and a queued row is kept for the retention period, shown in
  the operator UI and present in every backup. Unsubscribing between the
  incident and the send is now honoured; the address is masked in the
  ledger.
- **Resolved is terminal at the database.** A `BEFORE UPDATE` trigger
  refuses to move a resolved incident's status or resolution time. It
  freezes those two columns only: a blanket rule would break monitor
  deletion, because `monitor_id` is `ON DELETE SET NULL` and a
  referential SET NULL is an UPDATE that fires row triggers.
- The queue-health card counts pending dispatch intents with queued
  messages. A queue stuck at the expansion step used to read as empty.

### Migrations

`0027` adds `notification_intents`, `incidents.status_revision` and the
terminality trigger. `0028` adds two outbox channel values. Both are
additive and safe to apply to a live 1.18.1 database.

Upgrading fixes the windows; it does not reach back through them. An
incident that was already claimed-and-lost on 1.18.1 has `notified_at`
spent and no intent, and nothing can tell that apart from one that was
genuinely notified, so it stays un-paged.

## 1.18.1 — 2026-08-04

A flaky test turned out to be hiding six real ones.

### Fixed

- **An incident whose worker died before paging anyone was never paged.**
  The page hung off "I am the transaction that inserted the row", so a
  worker that committed the insert and then died left an incident open
  with nobody notified and no later check would repair it. A later
  check now finds it, claims the notification in the database, and
  pages exactly once.
- **A monitor that recovered could still have an incident opened for
  it**, producing a page-resolve-page flap. Opening and resolving now
  serialise on the monitor row.
- **A resolved incident could still be acknowledged, re-prioritised or
  given a public update** by a caller that read its status a moment
  earlier - including a customer-facing line on a closed status-page
  timeline.
- **Every `incident.updated` after the first was silently dropped** for
  the life of the incident, because the outbox key named the incident
  rather than the transition.
- **Deleting a monitor mid-outage orphaned its incident forever.** It
  is now closed in the same transaction, with a note saying why.
- **The incident timeline was ordered by the transaction start clock**,
  so concurrent writers could appear in the reverse of commit order.

### Changed

- The concurrency tests force the race instead of hoping for it, and
  every fix above has a test that fails without it.

## 1.18.0 — 2026-08-04

A delivery engine that survives a provider being down for an afternoon.

### Added

- **Durable retries**: twenty attempts over a six-hour horizon, backed
  off to a half-hour ceiling and jittered. The entire retry window used
  to be 31 to 62 seconds, so an outage longer than a minute ended with
  every queued alert marked failed. Two bounds end a chain and the
  terminal state says which: `dead_letter` for attempts, `expired` for
  time.

- **An append-only record of every attempt**, written before anything is
  sent and never overwritten, plus `unknown` as an outcome in its own
  right for the case where a request went out and its fate is not known.

- **Lease fencing**, so a worker paused past its lease can no longer
  overwrite the result of the worker that replaced it.

- **Fair draining**: selection round-robins across tenants instead of
  taking the globally oldest, so one organization's large fan-out
  cannot starve another's single alert.

- **Replay and retention**: finished deliveries can be queued again as
  new work without rewinding the original, and terminal rows are pruned
  after thirty days. Nothing queued is ever deleted.

- **A delivery ledger in the app**: queue health, per-delivery attempts,
  next retry, final reason, filters and an attempt timeline.

### Fixed

- A worker that died holding a row never spent an attempt, so a row
  could cycle between crash and re-claim forever without reaching its
  budget. Attempts are now spent at the claim.

### Notes

- Migration 0026 is additive; upgrading from 1.17.0 is applying it.

## 1.17.0 — 2026-08-03

Twenty-five providers, in this edition too.

### Added

- **Fifteen new native provider types**, taking the registry from ten to
  twenty-five: PagerDuty, Jira Service Management, Mattermost,
  Rocket.Chat, Matrix, Zulip, LINE, Pushover, Pushbullet, Bark, Web
  Push, Home Assistant, Twilio SMS, Twilio WhatsApp and Amazon SNS. All
  of them are here. The provider registry has never been an edition
  boundary and this release does not make it one.

  _Native_ means Vigil implements that service's own documented API and
  pins the version it was written against. Every provider carries that
  version in the registry, shows it in the editor and publishes it in
  `docs/NOTIFICATIONS.md`.

- **Alert lifecycle for PagerDuty and Jira.** Both derive a key from the
  cause of the alert, so every event about one outage joins one alert or
  one issue, and the recovery closes it.

- **An Apprise bridge**, forwarding to an Apprise API server you run.
  It is not counted as native: the published number is 25 native
  providers, plus additional services through your own Apprise server.
  Nothing behind that bridge has been implemented or tested here, and
  there is no Apprise server operated by anyone but you.

- **Provider capabilities as data** - native, lifecycle, duplicate
  suppression, receipt - shown as badges in the editor and published as
  columns in the docs.

- **A searchable provider picker**, because twenty-six entries in a
  dropdown is a list you scroll past.

### Fixed

- **LINE's `409` is a delivery, not a failure.** It means LINE already
  accepted that retry key, so the message arrived; recording it as a
  permanent failure would have put a lie in the ledger.

- **Recovery events now resolve the alert their outage opened.** Their
  payload names the incident in a different field, so the correlation
  key was reading the monitor instead.

- **Credentials are scrubbed in the base64 form HTTP Basic sends them
  in**, not only as raw values.

- **Three capability flags said more than the code does** - SMTP,
  Amazon SNS on standard topics and Jira do not suppress a redelivery -
  and the retry window is 31 to 62 seconds, where three pages claimed
  half an hour. Both are corrected rather than rounded.

### Notes

- **No migration.** `notification_channels.provider` is a text column,
  so adding providers is not a schema change. Upgrading from 1.16.0 is a
  deploy; existing channels keep routing and delivering.

- Amazon SNS is signed in-tree with Signature Version 4 and Web Push is
  encrypted in-tree per RFC 8291 and RFC 8292, rather than through SDKs
  that would perform their own HTTP outside the egress policy.

- The published drain limits are unchanged: 250 messages a tick, four in
  flight, ten per channel per tick.

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
