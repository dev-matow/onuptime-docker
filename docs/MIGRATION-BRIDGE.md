# The Better Stack migration bridge

Switching monitoring systems is a trust decision made with the least
information you will ever have about the new system. The one-time
importer (see [MIGRATION.md](MIGRATION.md)) moves configuration
faithfully and names every loss, but it cannot answer the question that
actually delays a cutover: will the new system see what the old one
saw?

The bridge exists to answer that question with evidence. It keeps a
read-only connection to Better Stack open while Vigil runs the imported
monitors beside it, silently, and then writes a cutover report that
compares real outcomes over the same window: which outages both systems
recorded, which only one did, and how far apart the timings were.

This page states exactly what the bridge does, what its report can
prove, and, just as deliberately, what it cannot.

## The lifecycle

1. **Connect.** Paste a Better Stack API token under Settings, Import,
   Migration bridge. The token is verified with one read, then stored
   sealed (AES-256-GCM under a key derived from `BETTER_AUTH_SECRET`,
   the same secretbox notification channel credentials use). Better
   Stack publishes no read-only token scope, so create a token for the
   migration and revoke it in Better Stack after cutover. The bridge
   only ever issues GET requests: it cannot change, delete, or create
   anything in your Better Stack account.
2. **Import.** The same engine, translation rules and report vocabulary
   as the one-time importer, plus three things a one-time import does
   not do: every monitor and group the run creates starts in shadow
   mode, every source record gets a persistent mapping row (refused
   ones included), and the full import report is stored, because the
   cutover report has to cite it.
3. **Shadow.** The imported fleet runs: checks execute on schedule,
   observations are recorded, incidents open and resolve. Nothing
   announces any of it (the exact contract is below).
4. **Evidence.** A worker job polls Better Stack's incident history
   every fifteen minutes: the open incidents, plus a date window
   overlapping the last successful poll by a day. Every poll is
   recorded, failures included, because coverage the report cannot
   prove is coverage it must not claim.
5. **Report.** On demand, a cutover report is generated from stored
   rows only and frozen: totals, mappings, losses, per-monitor
   comparison, timing deltas, manual work, and a SAFE or NOT SAFE
   verdict with every reason written out. Generating a new report never
   changes an old one.
6. **Cut over, or not.** Cutover ends shadow mode forwards: the fleet
   pages, notifies and publishes like any other monitors from the next
   check on. Abandon ends it backwards: the fleet is paused, through
   the same code path as pausing by hand. Both are explicit, audited
   actions; a bridge cannot be deleted while monitors still shadow
   under it, and that is enforced by the database, not just the UI. An
   import that commits concurrently with a cutover leaves its own new
   monitors in shadow; the bridge page shows the count, and cutting
   over again takes them live.

## The shadow contract

A monitor in shadow mode detects everything and announces nothing.
Concretely, while a monitor's `shadow_bridge_id` is set:

- Checks run on their ordinary schedule, from the worker or from remote
  probes, and every observation lands in the check history.
- Incidents open when the failure window elapses and resolve on
  recovery, with full timelines, exactly like live incidents. Each one
  is marked `shadow` at creation, permanently.
- Nothing pages: no notification channels, no member email, no
  status-page subscriber email, no SMS or voice escalation. The
  notification claim is never spent, so there is nothing queued to leak
  later.
- No automation runs: no recovery actions, no runbook triggers (either
  for the incident or for the state change), no escalation ladders.
- The public status page shows none of it: a shadow monitor cannot be
  added to a status page, a membership created around that guard is
  excluded at render time, and shadow incidents are filtered from the
  public incident list on their own stored flag.
- A shadow monitor is never part of any SLO, because burn alerts page:
  it is refused as an explicit target, excluded from an organization-
  scoped objective's membership, and excluded when a targeted group's
  tree is expanded. Its downtime burns no budget, and its uptime
  cannot dilute a real outage's burn.
- A shadow member does not move a live group's state, and a live
  monitor filed under a shadow group is not swallowed by it: a group
  aggregates only members that share its own shadow setting.

Suppression is keyed on stored columns (`incidents.shadow`,
`monitors.shadow_bridge_id`), never inferred from bridge membership at
read time, so a deleted bridge row or a mid-flight cutover cannot
silently flip a silent monitor loud or a loud one silent. The one
suppression that is structural rather than stored is deliberate:
maintenance hold rows cannot exist for shadow incidents at all,
because the shadow branch returns before the incident hooks that write
them are ever asked. Cloning a shadow monitor produces a live one: the
gag belongs to the bridge, not to the row's settings.

What shadow mode deliberately does not hide: the fleet is fully visible
on the internal dashboard and monitor pages, because the operator is
supposed to be watching it.

Some of the systems this contract silences are commercial-edition
features (recovery actions, runbooks, escalation ladders, SLOs, remote
probes). In Vigil Core those subsystems do not exist, so the
corresponding promises hold by absence; the parts Core enforces in code
are the ones Core has: paging, channels, member and subscriber email,
the public status page, and group state.

## What the report can prove

- **Mapping totals and losses.** What imported, what was transformed
  and how, what was refused and why, from the stored import report. The
  importer's honesty rules apply unchanged: nothing is silently
  approximated, and every transformation is a named line.
- **Matched outages.** A Better Stack incident and a Vigil incident on
  the same monitor whose intervals overlap (within a five minute grace)
  are the same outage seen twice, and the report states the detection
  and recovery deltas in seconds. Vigil's detection delta includes the
  failure window the import carried from Better Stack's own
  confirmation period, so the comparison is between what each system
  would have told a human, not between raw probe timings.
- **Provable misses.** A source incident that Vigil did not record
  counts against cutover when the report can prove Vigil was in a
  position to see it: the monitor was already observing when the
  outage started, and the outage provably outlived the failure window
  the import recorded, either because its resolution was observed or
  because the copy was seen still open past the window. The copied row
  itself is the evidence the outage happened; no poll-coverage argument
  is required on top, because requiring one would excuse exactly the
  outages a flaky evidence feed makes hardest to see. Every such miss
  is listed and makes the verdict NOT SAFE.
- **Extra detections.** A Vigil incident the source did not record is
  an assertion of source silence, and silence is only provable where
  the polls actually looked, so extras do require coverage of their
  span. A closed extra is a report line, not a blocker, because it may
  equally be Vigil catching something Better Stack missed. An extra
  still open is judged as of the last successful poll: a monitor
  reading down while the source, when last asked, read it fine is a
  live disagreement and flips the verdict.
- **Evidence coverage.** Exactly which spans of source history the
  polls actually retrieved, and how many hours of that overlap each
  pair's own observation. The verdict requires at least 24 hours of
  overlap per compared pair.

## What the report cannot prove

Stated here because a report that only lists what it can do invites
reading the silence as coverage.

- **Heartbeat (cron) monitors are not compared.** They import as Vigil
  push monitors, but the operator's jobs keep pinging Better Stack
  until they are repointed at cutover, so Vigil's silence about them
  proves nothing. The report lists each one as its own manual cutover
  step instead of pretending.
- **Blips below the failure window.** Better Stack incidents shorter
  than the failure window are listed separately and excused: Vigil not
  opening an incident for them is the configured behaviour, not a
  miss. The window used is the one recorded at import time, stored on
  the mapping row, so editing a monitor's window afterwards cannot
  retroactively excuse a recorded miss. If those blips matter to you,
  shorten the monitor's failure window and compare the days that
  follow.
- **Response-time parity.** Better Stack's response-time API returns 24
  hours of history at most, which is too thin to compare honestly, so
  latency is not compared at all. The comparison is about incidents.
- **Source silence in an evidence gap.** If polls failed across a span
  and no later poll re-covered it, a Vigil incident inside it stays
  unprovable: the source may have seen the same outage and the polls
  were not there to say. Recorded source incidents are unaffected by
  gaps; only silence needs coverage.
- **The end of a copy the source deleted.** The poller follows up on
  every stored copy that is still open but absent from the list feeds,
  one read by id, so a long outage's resolution is observed even after
  it leaves the date-filtered window. A copy the source deleted answers
  that follow-up with nothing; it stays exactly as last seen, its
  duration known only up to its last refresh, and the comparison says
  so rather than pretending it is still open.
- **A blinded feed.** A poll whose rows cannot be parsed (a source
  format change) is recorded as partial, not as coverage: quiet-
  because-blind must never read as quiet-because-agreeing.
- **Alerting behaviour.** Who Better Stack would have paged, through
  which escalation policy, is not read and not compared. The report
  compares detection, not notification fan-out; escalation policies are
  listed as manual work, as the importer already reported.
- **The day boundary, exactly.** The source's incident list filters by
  calendar date, so poll windows overlap by a full day to be safe.
  Coverage arithmetic uses the poller's own timestamps, but an
  installation that needs minute-exact evidence boundaries should treat
  the coverage figure as conservative, not surgical.

## The verdict

SAFE is not a promise that nothing will ever differ. It is the
statement that every one of the following held when the report was
generated, each of which is otherwise its own NOT SAFE reason:

- no provable misses, and no imported monitor reading down, as of the
  last successful poll, while the source reads it fine;
- at least 24 hours of overlapping evidence and observation for every
  compared pair, and no compared pair with zero observations recorded
  during the comparison;
- the evidence feed itself is healthy (fewer than four consecutive
  failed polls);
- no imported monitor has been deleted here since the import: the
  source still watches that target, and after cutover nothing would;
- nothing the source holds was left unmapped silently: records that did
  not become monitors are named as manual work, and heartbeats are
  named as their own cutover step.

An operator can cut over against a NOT SAFE verdict; the button does
not check the report. The verdict's job is to make that a conscious
decision with the reasons on the table, not to gate it.

## The stored credential

The bridge is the one migration feature that stores a source
credential, and the trade is bounded on every side: sealed at rest with
the notification secretbox, unsealed only at the moment of a read,
never returned by any API or page, absent from every report, poll row
and audit entry, and deleted outright on disconnect. Rotating
`BETTER_AUTH_SECRET` orphans it, exactly like channel secrets: polls
then fail with a clear re-enter message rather than a silent wrong-key
read. Evidence, mappings and reports survive a disconnect; only the
ability to keep reading goes.

Tenancy is the ordinary model: one bridge per organisation, every
bridge-owned row carries the organisation id, and nothing about one
tenant's migration is visible to another.

## Retention

Poll rows age out at 90 days, the check retention window: a coverage
claim older than the observations beside it has nothing left to vouch
for, and losing one only turns old extras unprovable, which is the
conservative direction. The source incident copies are deliberately
never pruned: a recorded miss is the source's row plus Vigil's
absence, deleting the copy would delete the miss from the next report,
and a verdict must never improve because time passed. Copies, import
reports and cutover reports all live until the bridge itself is
deleted, and the audit log keeps its record of who did what and when.
