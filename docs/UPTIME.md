# How Vigil calculates uptime

One methodology, one implementation, four surfaces: the monitor list,
the monitor detail windows, the status-page strip, and the status-page
headline. All of them read `src/modules/monitors/uptime.ts`.

## The rule

**Uptime is duration-weighted.** Each observation is evidence about the
monitor from the moment it was taken until the next observation, and
about nothing else. Uptime is:

```
uptime = (time observed in an `ok` state) / (time any observation vouched for)
```

Not `ok samples / total samples`. That older rule is only equivalent when
samples are evenly spaced, and Vigil's scheduler deliberately makes sure
they are not: `src/modules/monitors/scheduling.ts` probes a suspicious
monitor `SUSPICION_DIVISOR` (16) times as often as its baseline and a
calm one `CALM_MULTIPLIER` (2) times less. A count-weighted ratio
therefore oversamples exactly the minutes that went wrong, by up to 32x,
and reports a short blip as a long outage.

The adaptive scheduler is correct. Counting rows was the wrong reader.

## The coverage horizon

"Until the next observation" cannot be unbounded, or one green sample
taken before a three-day worker outage would report three days of green.

An observation therefore expires. It stands for at most:

```
coverage horizon = max(60 seconds, 3 × the monitor's configured interval)
```

Three intervals because the scheduler may legitimately stretch to two and
still be healthy, and a third absorbs ordinary queue lag without
manufacturing fake gaps. Floored at a minute so that a fast monitor does
not report a routine worker redeploy as an outage-shaped hole.

Time no observation vouches for is **uncovered**. It is excluded from the
numerator and the denominator alike, and reported separately, so a
reader is never shown a number that quietly averages a blackout into a
good result. The monitor detail page prints `measured N% of the window`
whenever coverage drops below 95%.

The horizon is wrong in the safe direction: too short shows uncovered
time an operator can explain, too long invents green.

### The one kind of observation that does not expire

The horizon exists because the thing an observation measured can change
without telling anybody. That is true of a probe result, of a heartbeat
and of a group's derived state, and it is not true of a **manual**
monitor, whose state is a person's statement. A statement does not go
stale; it is replaced, by the same person or another one, and until then
it is exactly as true as it was when it was made.

So a manual monitor's observation stands until the next one, however
long that is. Expiring it after three intervals would report "no data"
for a monitor that is doing precisely what it was asked to do, and the
reader would have no way to tell that apart from a monitor nobody is
watching.

Everything else keeps the interval rule, including the two other kinds
that are not probes:

| Kind        | What an observation is           | Horizon             |
| ----------- | -------------------------------- | ------------------- |
| `active`    | a probe result                   | 3 × interval        |
| `passive`   | how long the job has been silent | 3 × interval        |
| `aggregate` | the members' states, rolled up   | 3 × interval\*      |
| `manual`    | what an operator stated          | until it is changed |

\* A group has no cadence of its own. It can only learn something when
a member reports, so Vigil keeps its interval equal to its slowest
member's. That is what stops a group of hourly monitors from reporting
coverage gaps that were never gaps in evidence.

## What counts as up

- **`ok`**: so `degraded` counts as up. Uptime answers "was it
  serving", not "was it fast". Response time is its own number.
- **`indeterminate`** observations establish no state at all. They are
  Vigil saying "I could not tell", a ping probe on a worker without
  `CAP_NET_RAW`, a check type this build no longer has. They are stored
  `ok = false` because there is no third boolean, so counting them would
  publish a red strip for an operator configuration problem. They enter
  neither half of the ratio and no segment of the timeline; the previous
  measured state simply carries on through, still expiring at its own
  horizon.
- **Rows with a NULL `verdict`** (everything written before 1.10.0) are
  treated as measured. The predicate is `is distinct from
'indeterminate'`, never `<> 'indeterminate'`, because the latter is
  NULL for those rows and would silently drop the entire pre-upgrade
  history.

## Paused monitors

A paused monitor writes no checks, so a paused stretch produces exactly
one thing: uncovered time. That is the honest answer. Vigil has no
evidence about a period it was told not to look at, and it needs no
pause-history table to say it.

The consequence worth knowing: pausing a monitor for a week and resuming
it does not dent its uptime percentage, but it does reduce its coverage,
and the detail page will say so.

## Window boundaries

- An observation taken **before** the window still establishes the state
  at the window's opening instant. Only the part inside the window
  counts, and only until its horizon expires.
- An observation taken **before `window start − horizon`** contributes
  nothing and is not read at all. This is what bounds the query: there
  is no separate carry-in lookup to get wrong.
- The final observation in a window stands until the window ends or its
  horizon expires, whichever comes first. Callers pass
  `min(now, requested end)`: the future is not covered.
- A monitor created mid-window has no evidence about the time before it
  existed and is not charged for it.

## Per-day buckets

The status-page strip intersects each coverage segment with each UTC day
it touches, so an outage that straddles midnight is charged to both days
in the exact proportion it occupied them. Bucketing by
`date_trunc('day', checked_at)` would instead charge a sample wholly to
the day it was _taken_, putting a 23:59 sample's evidence on the wrong
side of the boundary.

Days are computed in UTC wall time, in plain `timestamp` space, so a day
is always exactly 24 hours. Doing the arithmetic on `timestamptz` would
make it follow the server's `TimeZone` setting, and a DST-observing zone
would produce 23- and 25-hour "days".

## The 90-day headline

One ratio over the whole window: total up time divided by total covered
time.

Not the mean of ninety daily percentages. That older rule weighted a day
holding three samples exactly as heavily as a day holding seven hundred,
a second distortion stacked on the first. Because the headline and the
strip now come from the same segments at different resolutions, they can
no longer disagree.

## Two implementations, one rule

`uptimeFromSamples()` is the readable definition, a pure function over
samples. `uptimeSegments()` is the same rule in SQL, so a 90-day page
does not stream a million rows into Node.

Two implementations of one rule is exactly the arrangement that drifts,
and the drift would be invisible, both sides return a plausible
percentage. So `tests/integration/uptime-parity.test.ts` runs them
against the same randomised, deliberately ugly histories (irregular
gaps, clustered bursts, blackouts longer than any horizon, samples
straddling both window edges, indeterminate rows mixed in) and asserts
they agree. That test is what makes "one methodology" a fact rather than
an intention. If you change one side, change the other; the test will
tell you if you did not.

## Legacy data

No migration rewrites history. Observations recorded before 1.13.0 are
read by the new rule exactly as they are, and that is safe: the rule
needs only `checked_at`, `ok` and `verdict`, all of which every retained
row already has.

The one limitation worth stating: pre-1.13.0 history was produced by the
same adaptive scheduler, so it has the same uneven spacing. Duration
weighting reads it correctly _now_, but any uptime figure previously
published from that data was count-weighted and will not match what the
product reports today. Where they differ, the current number is the
defensible one.

Retention prunes `monitor_checks` at 90 days, which is also the
status-page window, so the oldest end of the strip is always partially
pruned. That is pre-existing behavior and unchanged by this work.
