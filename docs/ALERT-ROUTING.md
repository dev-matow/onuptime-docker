# Alert routing

_Commercial edition._ Core has no routing policies. It keeps the routing
model it has always had, described below as "the fallback", and every
line of this feature is stripped out of it.

---

## What it adds, and what it does not change

Core already has a routing model. A notification channel subscribes to
event classes and optionally names the monitors it cares about, and for a
workspace with six channels that is the right shape: the configuration
lives where an operator looks for it.

What it cannot express is one decision, written once, applied to a
hundred monitors, with a per-service exception. Saying that in the
channel model means editing every channel whenever the answer changes,
and the answer is then stored N times and drifts.

So: a **policy** is an ordered list of **rules**; a rule matches on the
event and sends to a list of **destinations**; and an **assignment**
attaches one policy to the workspace, a service or a single monitor.

**An installation with no policies behaves exactly as it did.** No
assignment means no policy, which means the dispatch falls through to the
channel subscriptions, byte for byte as before. That is not a transition
period, it is the permanent behaviour of the feature when nobody has
configured it, and it is what lets this ship into an existing
installation without re-checking a hundred monitors.

## Precedence

Exactly one policy governs any monitor. Walked from the monitor upwards:

1. the monitor's own assignment
2. the nearest ancestor service (group) with one
3. the workspace default
4. nothing, which means the channel subscriptions

Because exactly one policy is ever selected, two assignments can never
both fire. **No duplicate alerts from overlapping policies** is a
property of the model rather than something the code has to be careful
about.

A **disabled** policy is skipped rather than honoured as "send nothing",
and the skip is recorded. Evaluation falls through to the next-less-
specific assignment, and ultimately to the channel subscriptions. A
policy somebody switched off while debugging must not take the alerting
for a hundred monitors with it.

## Rules

Rules are tested in `position` order and the **first match wins**, unless
the rule says to keep going. `continue` exists for the one shape that
genuinely composes ("and also post everything to #alerts-audit"), and it
is safe because destinations are deduplicated across every matched rule
before anything is enqueued.

Conditions are three independent dimensions:

| Dimension   | Values                                                | Source           |
| ----------- | ----------------------------------------------------- | ---------------- |
| Event class | `monitor`, `incident`, `expiry`, `recovery`, `probes` | `classifyEvent`  |
| Exact event | `monitor.down`, `incident.opened`, ...                | `WEBHOOK_EVENTS` |
| Severity    | `critical`, `warning`, `ok`, `info`                   | `eventSeverity`  |

**AND across dimensions, OR within one, and an empty list is a
wildcard.** A rule with nothing ticked matches everything. Both readings
are defensible in the abstract; only this one is safe when an operator
saves a half-finished rule on a policy that is already assigned, because
the other silently stops the alerts for every monitor it governs.

Incident severity (`critical` / `major` / `minor`) is deliberately not a
condition. It is not carried on a dispatch, and adding a lookup for it
would make routing re-read the incident at expansion time, which is the exact
thing the dispatch-intent design exists to have stopped.

When a policy governs a monitor and **no rule matches**, nothing is sent.
This does not fall through to the channel subscriptions: an operator who
wrote "only page for critical" would otherwise still be paged for
everything else.

## Destinations

A rule sends to any number of:

- **notification channels**: the same channels, providers, outbox,
  retries and delivery ledger as everything else. Routing selects which
  channels receive an event; it does not deliver anything itself.
- **escalation policies**: routing selects which on-call ladder runs. It
  does not re-implement the ladder: scheduling, rotation, acknowledgement
  and the rungs are all the existing commercial on-call system.

### Escalation precedence

A monitor's **own** escalation policy assignment wins, and routing
supplies one only when the monitor has none. An installation upgrading
into this release keeps paging exactly who it paged yesterday; routing
adds a default for the monitors that had nothing, and never re-aims a
ladder somebody set by hand.

### Destinations that stop working

Both pointers are `ON DELETE SET NULL`, never cascade.

A cascade would delete the rule's target row along with the channel, and
the rule would quietly narrow. An alert audience shrinking because
something else was deleted is the failure this avoids. With `SET NULL` the rule keeps a target whose
pointer is gone: the settings page shows it, the routing decision records
`orphaned` against it, and the remaining destinations still fire.

A **disabled** channel is skipped at routing time rather than enqueued
and failed at delivery, and recorded as `disabled`. A row that failed at
send time reads like something went wrong; a destination the operator
switched off is a configuration.

## Maintenance comes first

Suppression is evaluated before routing, always. A suppressed dispatch
never resolves a route. Routing afterwards would compute a fan-out
nobody receives, record that it was routed, and leave an operator reading
the evidence believing three channels were messaged during a maintenance
window. See [MAINTENANCE.md](MAINTENANCE.md).

## Why an alert was or was not sent

Every dispatch writes one `alert_routing_decisions` row, in the same
transaction that enqueues (or does not enqueue) the messages. An
expansion that rolls back leaves no messages _and_ no claim to have
decided anything.

| Outcome      | Means                                                     |
| ------------ | --------------------------------------------------------- |
| `routed`     | A policy matched and its destinations were enqueued.      |
| `unrouted`   | No assignment applies; the channel subscriptions decided. |
| `no_match`   | A policy governed this monitor and no rule matched.       |
| `suppressed` | A maintenance window silenced it.                         |

The row carries the policy name as it stood at the time, which
assignment level it came from, which rule matched, how many outbox rows
were created, and a `detail` blob with the working: assignments skipped
because their policy was disabled, and per destination whether it was
queued, orphaned, disabled or had no provider in this build.

All of that is derivable in principle from the policies, the assignments,
the windows and the outbox, and in practice nobody can reconstruct it,
because three of those four have been edited since.

Shown at **Settings, Routing**, newest first, deliberately unfiltered by
outcome: the interesting row is almost always the one that says nothing
was sent.

An incident held at the moment it opened never reaches the dispatch path
at all, so it produces no decision row. Its evidence is the hold record
and the line on its own timeline naming the window.

## Permissions

`notification: update`, so owners and admins. The same permission
escalation policies and notification channels are gated on, because a
routing policy is notification configuration.

## The seam

Core carries `modules/notifications/dispatch-policy.ts`: a registry with
two questions ("may anything go out about this?" and "which channels?"),
modelled on `modules/incidents/hooks.ts` down to the shape. With
nothing registered, both answer "no opinion" and `dispatchToChannels`
resolves routes from the channel subscriptions exactly as it did before
the file existed. What `strip-ee` removes is a registration, not a
branch.

A policy that throws degrades toward **sending**: not suppressed, default
routing. The failure mode of a broken routing policy should be an alert
in the wrong room, never an outage nobody heard about.

See also [NOTIFICATIONS.md](NOTIFICATIONS.md) for the outbox, retries and
delivery guarantees underneath all of this.
