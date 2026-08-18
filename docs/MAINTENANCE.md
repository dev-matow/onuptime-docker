# Maintenance windows

_Commercial edition._ Core has no maintenance windows: the tables, the
reconciler and the settings page are all stripped out of it.

Planned work, declared in advance. While a window runs, the monitors it
covers stop producing alerts.

**Checks keep running throughout.** Every observation is still recorded,
uptime is still computed from it, incidents still open, and the check
history is complete. What a window removes is the page. That is
deliberate and it is the whole design: the question after a maintenance
window is always "what did the work take down", and only the evidence
answers it. A window that suppressed the record would make its own
post-mortem impossible.

---

## What a window silences

Two levels, chosen per window.

| Level                    | Channel messages | Responder email | Status-page email | On-call ladder |
| ------------------------ | ---------------- | --------------- | ----------------- | -------------- |
| **Silence everything**   | no               | no              | no                | no             |
| **Silence on-call only** | yes              | yes             | yes               | no             |

"Silence on-call only" is for the case where the room watching a deploy
should see what it is doing to the fleet and nobody should be woken up
about it.

Deliberately not offered: a level that stops incidents opening. An
incident is the record of what broke, and a window that erased it would
defeat the reason anyone schedules one. Incidents opened under a window
are marked as such, so the incident list can show them for what they are.

## Scope

A window covers either **every monitor in the workspace**, or the
**monitors and services you name**.

A service in Vigil is a monitor group, so naming a group covers
everything beneath it, recursively. Membership is resolved at the moment
the question is asked, not frozen when the window was saved: a monitor
moved into a covered group during the window is covered, and one moved
out stops being.

A window that names monitors and has none left covers **nothing**. It
does not quietly widen to the whole workspace. Targets cascade away when
a monitor is deleted, and a maintenance window that grew to cover an
installation because an unrelated monitor was removed is the worst thing
this feature could do.

## Overlap

Windows overlap freely, and refusing that would mean deleting a weekly
rule to schedule an emergency. When several cover one monitor, the
**strongest** suppression applies. That is deterministic regardless of
which the database returned first, and it is monotone: adding a window
can only ever silence more, never less, which is what an operator
scheduling a second window means.

The window named in the evidence is the strongest, tie-broken by the
earliest start and then by id, so two workers evaluating the same instant
record the same reason.

## Timing, and what happens twice a year

A **one-off** window is two absolute instants. You pick a moment, and
that is the moment.

A **recurring** window is a local clock reading plus an IANA time zone
plus a duration. "Every Sunday at 02:00, Europe/Berlin" is 01:00Z in
January and 00:00Z in July, and storing it as an instant would drift by
an hour twice a year in the direction of not covering the maintenance it
was created for.

Twice a year a local time is not a moment at all:

- **The clocks jump forward** and the time does not exist. 02:30 on a
  spring-forward Sunday becomes 03:30, the same distance past the jump.
  This is what RFC 5545, Java's `ZonedDateTime` and Temporal's
  `compatible` mode all do. The alternative, refusing to schedule, drops
  one occurrence of a recurring window every spring, silently. The
  settings page says so before it happens.
- **The clocks go back** and the time happens twice. The **first** is
  taken, which is the earlier instant and the longer coverage.

**Duration is real minutes, not wall-clock hours.** A two-hour window
spanning a spring-forward is two hours of actual time and its end reads
05:00 on the wall rather than 04:00. Holding the end's wall time fixed
instead would make that occurrence one hour long, which is an hour of
maintenance nobody was covered for.

**Monthly windows skip a day the month does not have.** "The 31st" in a
30-day month produces no occurrence rather than moving to the 30th:
clamping gives an operator maintenance on a day they did not name, and
does it silently. Pick "Last day" if that is what you mean.

## How a window begins and ends

A rule is expanded into occurrences (rows with absolute UTC bounds) up
to a horizon 45 days ahead. Everything downstream compares two
timestamps, so no DST arithmetic lives inside a query.

Coverage is `starts_at <= now < ends_at`, half-open, so two back-to-back
windows never both cover the instant between them. It is **not** gated on
the reconciler having marked the occurrence active. That matters for the
failure direction: a reconciler that stops cannot silence anything it has
not already written down, so the worst it can do is fail to suppress,
which is noise. Had suppression required the `active` state, a reconciler
that died mid-window would leave it silencing forever.

When a window ends, the reconciler releases the incidents it was holding
and pages for the ones that are still open, through the same exactly-once
notification claim every other page goes through. Two worker replicas
releasing the same hold in the same second produce one message.

Releasing is driven by "no live coverage", not by the occurrence
completing. The two agree when a window simply ends; they differ when a
window is disabled, deleted, edited, or when the monitor leaves a covered
group, and only the coverage question is true in all of them.

## Editing, disabling, deleting

- **Editing** cancels every occurrence that has not started and leaves a
  running one alone. Monitors are being silenced by it right now, and an
  edit must not un-silence a fleet mid-window.
- **Disabling** cancels everything outstanding, including a running
  occurrence. That is what switching a window off mid-outage means: start
  paging me again. The reconciler notices on its next pass and re-pages
  anything still down.
- **Deleting** does the same, and keeps the hold records: "why was nobody
  paged last Sunday" stays answerable after the window is gone.

Cancelled occurrences are kept rather than removed, for the same reason.

## What is deliberately not silenced

**Automatic recovery does not run** for a monitor under a window set to
silence everything. Remediation restarting a service somebody is
deliberately rebooting is exactly the surprise a maintenance window
exists to prevent.

**An outage that began before the window keeps talking.** A notification
about an incident is silenced only when that incident was itself held:
when a window claimed it as it opened. An outage the world already knows
about gets its all-clear, so the room that was told a service was down is
told when it comes back.

**An escalation rung that comes due during a window is dropped, not
deferred.** The rungs already fired have fired; the rest do not resume
afterwards. Resuming would page people about an outage they have been
looking at for two hours, from whichever rung the clock happened to
reach. An operator who declares maintenance mid-incident is saying stop.

## Where you can see it

- **Settings, Maintenance**: every window, what is running, what is next,
  and a note when the next occurrence is shifted by a clock change.
- **Dashboard**: what is running and what is coming, above the incident
  list, because a quiet fleet during a window is not the same fact as a
  quiet fleet.
- **Monitors list**: a badge on every covered monitor.
- **Monitor page**: an Alerting card with the current window, the next
  ones, and which routing policy governs the monitor.
- **Incident timeline**: the line that says which window held the page,
  and by when operators would be told.
- **Audit log**: create, edit, enable, disable and delete.

## Permissions

`monitor: update`, so owners and admins. The same authority a recovery
action or a probe assignment carries, and for the same reason: all three
change what a monitor does when it fails.

## Retention

Completed and cancelled occurrences, released holds and routing decisions
are pruned after a year by the nightly retention job. Nothing outstanding
is ever pruned: a scheduled occurrence is the future and an unreleased
hold is an incident somebody is still owed a page for.

## Importing from other tools

Vigil's importers do **not** create maintenance windows from the systems
they migrate. The schedules do not translate field for field, and a
window imported approximately is a window that silences the wrong hours.
Every source window is reported by name as unimported, so you can
recreate it here deliberately.

See also [ALERT-ROUTING.md](ALERT-ROUTING.md), which is evaluated after
suppression, and [NOTIFICATIONS.md](NOTIFICATIONS.md) for the delivery
pipeline underneath both.
