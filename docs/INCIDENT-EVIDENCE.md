# Incident evidence

When a monitor opens an incident, Vigil writes down what was known at
that moment: the observation that failed, the last one that succeeded,
what changed between them, what four read-only probes found when they
re-checked the target, and which other monitors were failing for a
reason it can name.

It is in both editions. Core gets evidence for Core's check types; the
commercial editions add a scripted journey's failed step and what the
remote probes saw.

**Why a stored snapshot rather than a query.** Everything the answer is
derived from disappears. Observations are pruned at ninety days; the
monitor's own history is rewritten by every later check; the correlated
failure elsewhere in the fleet has recovered by the time anyone reads
the incident. So the answer is copied once, at onset, into a row of its
own, and left alone for a year after the incident resolves.

---

## What it answers

| Question                            | Where it comes from                          |
| ----------------------------------- | -------------------------------------------- |
| What failed                         | the observation that opened the incident     |
| Which layer                         | classification, and a burst that measured it |
| When it started failing             | the monitor's failure run                    |
| When it last worked, and what moved | the last successful observation, diffed      |
| What else is broken for that reason | failing monitors in the same tenant          |

### The layer, and how it is known

One of `dns`, `tcp`, `tls`, `http`, `application`, `browser` or
`unknown`, with a **basis** stating how it was established. That is
what makes the layer safe to state at all:

- **measured**: a diagnostic probe re-checked that layer and it failed.
- **reported**: the failure names the layer itself. `ENOTFOUND` came
  out of a resolver; `ECONNREFUSED` came out of a kernel;
  `CERT_HAS_EXPIRED` came out of a TLS stack.
- **assertion**: the target answered and a declared assertion did not
  hold, so the same observation proves the transport worked.
- **unknown**: nothing established it, and Vigil says so.

`unknown` is a normal answer, not a gap. **A timeout does not name a
layer**: a request that took longer than the timeout could have stalled
in the resolver, the connect, the handshake or the application, and
nothing in the error text distinguishes them. Filing every timeout as a
connection failure would be a sentence that is wrong often enough for an
operator to stop reading the field. If the burst reproduces it, the
layer becomes `measured`; if not, it stays `unknown`.

A burst that reproduced nothing is recorded as exactly that. It is not
reported as a recovery: the steps ran seconds after the observation,
from one vantage point, against a target that may already have come
back.

### Related failures

Two conditions, and neither is sufficient alone:

1. the other monitor's failure run began within **10 minutes** of this
   one's, and
2. the two share at least one **strong** signal: same hostname, same
   registrable domain, same resolved address, same failure signature, or
   the same remote probe location.

Weak signals (same stage, same check type) are listed once a strong
one has earned the row, and never earn one themselves. Two signatures
are deliberately weak for the same reason: a shared **timeout**, which
is the most common failure a monitor has and names no layer, and a
shared **HTTP status**, which is one endpoint's opinion of one request
and which every overloaded application in the world returns. Counting
either would relate half the fleet to the other half.

The **probe location** signal is commercial, and it is the one a single
vantage point cannot produce: two unrelated services that both stopped
answering, and both only from Frankfurt, are not two outages. It is read
from the frozen round record each monitor's last probe decision left
behind, and only from the probes that did **not** see the target
healthy. A location that reported `up` is evidence against a shared
network cause, not for it.

Every signal carries the value it matched on, so the claim can be
checked rather than trusted. There is no score, no ranking model and
nowhere to put one. Correlation is scoped to the organisation inside the
query, and shadow monitors are excluded. A shadow monitor is a second
copy of one already in the list.

---

## The diagnostic burst

At most four read-only probes, fired once, when the incident opens:

| Step      | What it establishes                                   |
| --------- | ----------------------------------------------------- |
| resolve   | whether the name still resolves, and to what          |
| connect   | whether the port accepts a connection                 |
| handshake | whether TLS completes, and what the certificate says  |
| request   | what the endpoint answers now, following no redirects |

### Its bounds

- **Requests**: four steps, one socket each. The HTTP step refuses to
  follow redirects, so a chain cannot turn one step into ten.
- **Duration**: 5 seconds for the whole burst, 2 seconds per step, and
  each step gets no more than the budget that is left. A burst that runs
  out stops early, with fewer steps.
- **Concurrency**: two at a time per worker process. A correlated outage
  takes a hundred monitors down at once, and a hundred simultaneous
  bursts is a stampede aimed at a target already having a bad day. Over
  the limit the snapshot records `concurrency`, which is the bound
  reporting itself rather than a gap. A monitor on the high-frequency
  plane never bursts at all: that plane holds a per-monitor promotion
  flag across the whole outcome call and cannot pause for seconds, so it
  records `high-frequency` and keeps the rest of its snapshot.
- **Enforcement**: each step is _raced_ against its deadline rather than
  handed a timeout and trusted. Two of the four resolve a hostname
  through machinery that accepts no timeout at all, so a burst that only
  passed the number down was bounded by the system resolver rather than
  by the budget.
- **Honesty about its own limits**: a step that failed because the
  budget ran out, or because egress policy refused the address, is
  recorded in full and marked as Vigil's own doing. The classifier skips
  those, so "we stopped waiting" is never reported as "the connection
  failed".
- **Storage**: every step's detail is a small fact bag, and the
  snapshot as a whole is capped at 32 KB, trimmed least-useful-first
  with the trim recorded.

### What it cannot do

It writes no observation, moves no monitor's status, touches no
incident, pages nobody, feeds no SLO, triggers no runbook and reaches no
status page. Its only output is one `jsonb` column that the incident
page reads.

It runs **after** the incident's page has been claimed, never before.
Paging a human is the product's job; evidence is a convenience. A worker
that dies in between loses the snapshot rather than delaying the page,
and there is no repair path on a later check. What the snapshot records
is the state of the world at onset, which a later check can no longer
see.

The egress posture is the monitor channel's own: the same policy, the
same address classifier, the same refusal of private, loopback and cloud
metadata space. A target that was public when the monitor was created
and resolves into private space now is refused, and the resolve step
records what it resolved to.

**Shadow mode never dials.** An incident opened by a monitor running
beside the system it was migrated from records its snapshot with the
burst marked `shadow`. The fleet exists to be compared, so the evidence
is worth keeping; what it must not do is put four more requests on a
production endpoint during a migration, when the same target is already
being watched twice.

Set `INCIDENT_EVIDENCE_BURST=false` to switch the burst off for an
installation. Everything else is still captured, and the layer falls
back to what the failure itself names: `reported` where the error
carries a code, `unknown` where it does not. What is lost is the
upgrade from `unknown` to `measured`.

---

## Secrets

Nothing here is written unredacted. The snapshot is sealed against the
monitor's own secret values (every field its check type declares
secret, plus the password inside a connection-string target) using the
same value-based redactor the scripted journeys use
(`src/lib/redact.ts`).

Redaction keys on the **value**, never on the field name, because by the
time a credential is inside an error message it has no field name any
more: `connection to server failed for user app (hunter2)` is what a
driver actually returns. Every encoding the product can produce is
covered (percent, form, JSON-escaped, base64) and the sealer re-scans
its own output and replaces the whole value if anything survived.

Bodies are never stored. Response headers are an **allow-list**:
`server`, `content-type`, `content-length`, `via`, `age`, `x-cache`,
`retry-after`. So a header a target invents, a `set-cookie` and a
`www-authenticate` are all absent by construction rather than by
remembering to exclude them. A `location` is reduced to origin and path,
because a redirect target carries session tokens in its query string.

A screenshot is **referenced**, never copied: the snapshot holds the
artifact's id and hash, and the artifact route enforces its own tenancy
check when the image is fetched.

---

## Retention and deletion

| Row                           | Kept                                           |
| ----------------------------- | ---------------------------------------------- |
| Observations                  | 90 days (`CHECK_RETENTION_DAYS`)               |
| Incident evidence             | until 365 days after the incident **resolved** |
| Evidence for an open incident | never pruned, at any age                       |
| Screenshot artifacts          | 14 days; a reference may outlive its image     |

Evidence is deleted with its incident by cascade, and with its
organisation. A partial snapshot renders as a partial snapshot: the
incident page states which parts are absent and why, rather than looking
complete.

---

## Which checks get what

Every active check type with a host gets the resolve step. The connect
step needs a port, so a type that has none (ping, for one) stops after
resolving; the handshake step is added when the target speaks TLS.

The **request** step runs only for `http`. A burst issues an
unauthenticated request; for `http` that is exactly what the monitor's
own probe does, so the answer is comparable. For a type that
authenticates (a JSON query with a bearer token, an Elasticsearch check
with a password) it is not, and a fabricated 401 on an incident page
would be read as the cause of the outage.

A passive, aggregate or manual monitor has nothing to re-probe: a
heartbeat is judged by silence, a group by its members, a manual monitor
by an operator's say-so. Those snapshots record `no-target` and carry
everything else.
