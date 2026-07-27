# Upgrade guide

How to take Vigil updates after you've customized your copy.

## The workflow

Treat the purchased source as an upstream remote:

```bash
git remote add vigil-upstream <your private access URL>
git fetch vigil-upstream

# Review what changed
git log --oneline HEAD..vigil-upstream/main
git diff HEAD...vigil-upstream/main --stat

# Merge (or rebase your changes onto the new version)
git merge vigil-upstream/main
```

Because customizations concentrate in predictable places (branding
files, `globals.css`, your own modules), merges stay small. The
architecture keeps upstream-heavy areas (`src/modules`, `src/worker`,
`src/db/schema`) separate from buyer-heavy areas (branding, landing,
your custom routes).

## After every upgrade

```bash
npm install                # dependency changes
npm run db:migrate         # new SQL migrations apply in order
npm run typecheck && npm run lint && npm test
```

Database changes always ship as ordered files in `drizzle/` — never
edit an existing migration; upstream never rewrites one.

## Version policy

- Patch/minor updates: additive migrations, no breaking service
  signatures.
- Breaking changes (major): called out in the release notes with a
  migration section, and service-signature changes are listed
  explicitly.

## Upgrading to 1.10.1

**This release contains a security fix.** A published status page showed
incidents for every monitor in the organization, not only the ones on
the page, and mailed their titles to subscribers — and an auto-opened
incident is titled after the monitor, which is usually an internal
hostname. The page leg has been live since **1.0.0**; the subscriber
email since **1.9.0**, when subscriptions shipped. It needs no attacker:
a published page, a monitor left off it, and that monitor failing. The
full description and what to check afterwards are in
[CHANGELOG.md](../CHANGELOG.md) under 1.10.1 → Security.

Check what was exposed from your own **Incidents** list rather than from
the public page — after upgrading, the public page is precisely what no
longer shows it.

One additive, data-only migration (`0011`) and no configuration or
compose changes: `npm install && npm run db:migrate`, restart, done.

That migration repoints escalation steps that a deleted schedule (or a
deleted user) left pointing at nothing. Deleting a schedule now rewrites
its steps to "all responders" as it goes, but that only covers deletions
performed from 1.10.1 onward — steps orphaned under an earlier version
would otherwise keep an empty schedule picker in the policy editor, and
that editor refuses to save the whole policy while one is present, which
blocks unrelated edits to other rungs.

Either way this is a behaviour change worth knowing about: a step whose
on-call schedule has been deleted now pages **all responders** instead of
nobody. If you deleted a schedule without repointing its steps, those
rungs were silently paging nobody and will start paging your responder
set. **Settings → Escalation** shows which.

Escalation steps queued before the upgrade — rungs of a ladder for an
incident that is open right now — still resolve by their position in the
policy. Ladders scheduled after the upgrade carry the rung with them,
and re-check at firing time that its schedule or person still exists.

## Upgrading to 1.10.0

**This release contains a security fix.** Escalation targets — a
monitor's escalation policy, and a step's schedule and user — were
written and read without an organization check, from 1.8.0 through
1.9.3. One leg of it needs no attacker and affects single-organization
installs: an offboarded person named in a step or a rotation kept being
paged. Upgrading is sufficient; the full description and the two things
worth reviewing afterwards are in
[CHANGELOG.md](../CHANGELOG.md) under 1.10.0 → Security.

Two compose changes come with it and need a `docker compose up -d
--build` rather than a plain restart: the worker now gets an
unprivileged ICMP socket (without it, `ping` monitors report "unknown"
forever) and the app now receives `DEMO_MODE`.

Additive, as a minor release must be. `npm run db:migrate` is the whole
procedure; there is no downtime step and no manual data fix-up.

Migration `0010` does five things. All of them preserve what you
configured, and a CI fixture
(`tests/integration/upgrade-from-1.9.test.ts`) builds a real 1.9.x
database, upgrades it and asserts so — including for a monitor that is
mid-outage when the upgrade lands.

**1. `monitors.check_type` becomes `text`.** It was a Postgres enum.
Postgres refuses to _use_ a newly added enum value in the same
transaction that adds it, and Drizzle wraps every migration in one — so
with an enum, shipping a check type would have needed two deploys,
forever. Values are cast verbatim; validation moved to the check-type
registry. The practical effect: a monitor whose type this build does not
know now reads as _misconfigured_ and stays editable and deletable,
rather than failing a column cast.

**2. Failure thresholds become time-based.** `failure_threshold` (a
count) is superseded by `failure_window_seconds` — "down for 90
seconds". Counting consecutive failures only means something while every
check is the same distance apart, which stops being true in this release.

Your monitors are converted to the window that reproduces their existing
behaviour exactly: `(failure_threshold - 1) × interval_seconds`. At a
fixed interval the Nth consecutive failure lands (N−1) intervals after
the first, so this is equality, not an approximation. A threshold of 1
becomes a window of 0 — open on the first failed check, which is what a
threshold of 1 already meant.

`failure_threshold` is **left in place, deprecated and unread**, so this
migration stays additive and a downgrade to 1.9.x still runs. It is
removed in 2.0.

**3. Check intervals stop being a fixed ladder.** The six allowed values
(60/120/300/600/1800/3600) become any value from 10 seconds to 24 hours,
and the number you set is now a _baseline_: a monitor that looks
suspicious is probed harder, one with a long clean run backs off. Your
existing intervals are unchanged and remain valid.

Scheduling now reads `monitors.next_evaluation_at`, seeded from where
each monitor already was — so the first tick after the upgrade does not
stampede every monitor at once.

**4. A nullable `config jsonb` column.** New check types keep their
settings there. Nothing is backfilled and no column is dropped; every
1.9.x monitor keeps `config = null` and its flat columns.

**5. Ledger columns on `monitor_checks` and `recovery_attempts`.** Actor
identity, a hybrid logical clock, a per-actor sequence and hash chain,
`signatures[]`, and the spec version a check was judged under. All
nullable, and **existing rows are left null on purpose** — a 1.9.x
observation had no actor and no chain, and backfilling one would be a
lie about who saw what. New observations are stamped from the first
check after the upgrade.

### What to expect afterwards

- Incident emails and timeline entries now say "had been failing for 2
  minutes" instead of "failed 3 consecutive checks". If you have
  customised `src/modules/notifications/email-templates.ts`, the
  `renderIncidentOpenedEmail` input took `failureThreshold` and now takes
  `failureWindowSeconds`.
- `recordCheckOutcome` returns `{ monitor, reconciliation }` instead of
  `{ monitor, becameDown, becameUp }`. Status is derived from observed
  state now rather than from transitions, so a monitor that somehow ended
  up down with no incident (or up with a stale one) repairs itself on the
  next check. If you called it directly, act on `reconciliation` — the
  calls it guards are idempotent by design.
- `performCheck` takes a `CheckSpec` built by
  `src/modules/monitors/spec.ts`. Build it with `toCheckSpec(monitor)`
  rather than by hand; two hand-written copies had already drifted.
- One new optional environment variable: `RDAP_BASE_URL`, used only by
  `domain-expiry` monitors. It defaults to the public bootstrap
  redirector; set it to a mirror or a registry in an air-gapped install.
- Ping monitors need an ICMP socket the worker is allowed to open. The
  shipped `docker-compose.yml` grants one with
  `net.ipv4.ping_group_range` and the worker image installs `iputils`;
  `cap_add: [NET_RAW]` is not an alternative, because the worker runs as
  a non-root user and capabilities are not inherited without file caps.
  Without it, ping monitors report _unknown_ with an explanation — never
  a false outage.

### Signatures that changed

The version policy above promises no breaking service signatures on a
minor. These are the exceptions, all of them internal — none is reachable
from a route or a server action, and nothing in the UI calls them
directly. Listed because a buyer who has customised the worker or the
status page will meet them in a merge.

- `resolveStepRecipients`, `currentOnCall` and `escalationStepsForMonitor`
  in `src/modules/oncall/service.ts` each take a leading
  `organizationId`. That is the security fix above: these are the three
  reads that turn an id into somebody's phone ringing, and they now
  establish the tenancy boundary themselves rather than trusting the id
  they were handed.
- `DailyUptime.uptimePct` is `number | null` rather than `number`. Null
  means the day holds observations but none of them measured anything,
  which the strip renders as "no data" instead of as 0%. If you render it
  yourself, handle the null — coercing it with `Number()` produces 0 and
  paints the bar red.
- `PublicComponent` gained `paused: boolean`, because the headline has to
  tell "switched off by an operator" apart from "cannot be measured".
- `observationClaim` takes the observation's timestamp as a second
  argument, and the hash now covers `ok`, `checkedAt` and `failureClass`.
  Chains written by 1.10.0 are not comparable with any written by a
  pre-release build of it.

## If a merge goes wrong

Your escape hatch is the service layer: as long as
`src/modules/*/service.ts` functions keep their `(db, actor, input)`
signatures, UI and worker from either side keep working. Resolve
conflicts there first, run the integration suite
(`npx vitest run tests/integration/`), then reconcile UI.
