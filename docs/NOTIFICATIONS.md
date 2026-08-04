# What Vigil guarantees about alerts

One sentence, and the rest of this page is why it is worded exactly that
way:

> When Vigil decides to alert you, that decision is durable, and the
> message will be delivered at least once or recorded as failed.

Not "all alerts are delivered". Nothing that hands a message to a third
party can promise that, and a product that says it anyway is making a
promise its transports cannot keep.

## Provider types, and how many channels you may have

Two different numbers, and conflating them is the mistake this section
exists to prevent.

**25 native provider types ship**, in both editions. Native means Vigil
implements that service's own documented API - its request shape, its
response shape, its error semantics - and pins the version it was
written against. That number is a fact about the registry, it is
generated from the code, and CI fails if any page says a different one.

**There is also one bridge**, and it is not a twenty-sixth integration.
The Apprise provider forwards to an Apprise API server _you_ run. What
that server can reach is between you and Apprise: Vigil has not
implemented, pinned or tested any of it. So the sentence everywhere is
"25 native providers, plus additional services through your own Apprise
server", and the two halves are never added together.

**There is no limit on how many channels you configure.** Forty Slack
channels, one per client, each pointing at a different workspace, is a
supported configuration; so are two pointing at the same one. Nothing in
the application counts them, and no edition or licence changes that.
Channels are identified by id, and nothing about a channel has to be
unique - not its provider, endpoint, address or name.

"Unlimited" is a statement about _this application's_ limits, and only
that. It does not promise infinite throughput and it does not remove
anyone else's rate limits: Slack, Telegram and the rest still enforce
theirs, your server still has one CPU, and the measured cost of a large
fan-out is published below rather than waved away.

## Channel providers

A channel is a provider plus its settings, its encrypted credentials and
the event classes it subscribes to.

Four columns beyond the name, and each one is a claim the code has to
back. **API** is the version this provider is written against. **Closes**
means recovery resolves what the outage opened rather than sending a
second message. **Dedupes** means a redelivery of the same outbox row
collapses at the provider, which is the honest half of at-least-once.
**Receipt** means a success carries an id that lands in the ledger. The
table is generated from the registry's `capabilities`, and a test fails
if it stops matching.

### Chat

| Provider        | API                                   | Closes | Dedupes | Receipt |
| --------------- | ------------------------------------- | ------ | ------- | ------- |
| Slack           | Incoming Webhooks                     | no     | no      | no      |
| Discord         | Webhooks (API v10)                    | no     | no      | no      |
| Microsoft Teams | Workflows (Power Automate) trigger    | no     | no      | no      |
| Telegram        | Bot API                               | no     | no      | yes     |
| Google Chat     | Chat API v1 incoming webhook          | no     | no      | yes     |
| Mattermost      | REST API v4 (`POST /api/v4/posts`)    | no     | no      | yes     |
| Rocket.Chat     | REST API v1 (`chat.postMessage`)      | no     | no      | yes     |
| Matrix          | Client-Server API v3                  | no     | yes     | yes     |
| Zulip           | REST API v1 (`POST /api/v1/messages`) | no     | no      | yes     |
| LINE            | Messaging API v2                      | no     | yes     | no      |

### On-call and tickets

| Provider                | API                    | Closes | Dedupes | Receipt |
| ----------------------- | ---------------------- | ------ | ------- | ------- |
| PagerDuty               | Events API v2          | yes    | yes     | yes     |
| Jira Service Management | Jira Cloud REST API v3 | yes    | no      | yes     |

### Push

| Provider       | API                                              | Closes | Dedupes | Receipt |
| -------------- | ------------------------------------------------ | ------ | ------- | ------- |
| Pushover       | Messages API (`/1/messages.json`)                | no     | no      | yes     |
| Gotify         | Server API (`POST /message`)                     | no     | no      | yes     |
| ntfy           | Publish API (JSON)                               | no     | no      | yes     |
| Pushbullet     | API v2 (`POST /v2/pushes`)                       | no     | no      | yes     |
| Bark           | Bark API v2 (`POST /push`)                       | no     | no      | no      |
| Web Push       | RFC 8291 aes128gcm, RFC 8292 VAPID               | no     | no      | no      |
| Home Assistant | REST API (`POST /api/services/notify/{service}`) | no     | no      | no      |

### SMS and messaging

| Provider        | API                                          | Closes | Dedupes | Receipt |
| --------------- | -------------------------------------------- | ------ | ------- | ------- |
| Twilio SMS      | Programmable Messaging 2010-04-01            | no     | no      | yes     |
| Twilio WhatsApp | Programmable Messaging 2010-04-01 (WhatsApp) | no     | no      | yes     |

### Email

| Provider | API                                        | Closes | Dedupes | Receipt |
| -------- | ------------------------------------------ | ------ | ------- | ------- |
| SMTP     | ESMTP (RFC 5321), STARTTLS or implicit TLS | no     | no      | yes     |
| Resend   | API v1 (`POST /emails`)                    | no     | yes     | yes     |

### Webhooks and buses

| Provider   | API                                       | Closes | Dedupes | Receipt |
| ---------- | ----------------------------------------- | ------ | ------- | ------- |
| Webhook    | Vigil payload v1                          | no     | no      | no      |
| Amazon SNS | Query API 2010-03-31, Signature Version 4 | no     | no      | yes     |

### Bridges - not a Vigil integration with anything behind it

| Provider                  | API                                                | Closes | Dedupes | Receipt |
| ------------------------- | -------------------------------------------------- | ------ | ------- | ------- |
| Apprise (your own server) | apprise-api (`POST /notify`, `POST /notify/{key}`) | no     | no      | no      |

Notes that are contracts, not trivia:

- **Every credential is the customer's own.** There is no Vigil-funded
  relay, account, API budget or hosted service behind any provider, and
  that includes the Apprise bridge - there is no managed Apprise.
- **Teams** uses the Power Automate Workflows webhook - the retired
  Office 365 connector URLs stopped delivering in May 2026 and this
  provider never speaks MessageCard.
- **Jira Service Management is not Opsgenie.** JSM's alerting came from
  Opsgenie, Atlassian ended its sale in June 2025 and shuts it down on
  5 April 2027, so this provider is built on the Jira Cloud platform
  REST API instead: it opens one issue per outage, comments on it while
  the outage continues, and transitions it on recovery if you name a
  transition.
- **LINE is the Messaging API, not LINE Notify.** LINE Notify was
  discontinued on 31 March 2025.
- **Twilio WhatsApp needs a template for out-of-hours alerts.** WhatsApp
  will not deliver free-form text outside a 24-hour service window,
  which is exactly when a 3am outage fires. Set a Content SID for an
  approved template and Vigil sends it with the title, detail and link
  as `{{1}}`, `{{2}}`, `{{3}}`. Without one, Twilio accepts the request
  and WhatsApp drops the message.
- **PagerDuty is never sent `acknowledge`.** Acknowledging means a human
  picked the alert up, and Vigil does not know that. Trigger and resolve
  only.
- **Amazon SNS is signed here, not by an SDK.** Signature Version 4 is
  implemented in `providers/sns.ts` so the request goes through the same
  egress guard as every other delivery. The cost is that credentials are
  a pasted access key rather than an instance role.
- **Web Push is implemented, not imported.** The `web-push` package
  performs its own HTTP, which would put one transport outside the
  egress policy. The encryption is RFC 8291 and the auth is RFC 8292.
- **Home Assistant is pinned to the `notify` domain.** The service-call
  endpoint can invoke anything; a notification channel that could unlock
  a door is not a notification channel.
- **The customer's own servers are fine.** Gotify, ntfy, Matrix,
  Mattermost, Rocket.Chat, Zulip, Bark, Home Assistant, Apprise and the
  signed webhook accept private addresses, because a receiver on your
  own network is the normal deployment; cloud metadata and link-local
  space are refused wherever the URL points or resolves.
- **Redirects are never followed.** A redirect would re-target a
  credentialed request, and for signed payloads would drop the method,
  body and signature.
- **SMTP refuses to authenticate without TLS**, and certificate
  verification has no off switch.
- **A 200 is not always a delivery.** Pushover, Zulip, Rocket.Chat, Bark
  and Apprise answer 200 with the verdict in the body; those bodies are
  checked, and a rejection is recorded as a permanent failure rather
  than as a successful send.

## The Apprise bridge, and its boundary

Apprise is a Python library and an API server that speak to a very large
number of services. Vigil can call one, and the rules are worth stating
plainly because this is the easiest place in the product to overclaim.

- **You host it.** Vigil ships no Apprise server, runs no shared relay,
  and has no founder-operated instance. The URL you configure is yours.
- **It is not counted as native.** 25 is the native number.
- **Vigil has not tested the services behind it.** Not one. If your
  Apprise server's Discord URL stops working, that is between you,
  Apprise and Discord.
- **Prefer a saved configuration key.** With `/notify/{KEY}`, the
  Apprise URLs - which embed third-party tokens - stay on your server
  and never reach Vigil at all. Inline URLs work too, and are stored
  encrypted like every other credential, but keeping them on your own
  server is strictly better.
- **It gets no special treatment.** Same egress policy, same sealed
  secrets, same outbox, same retries, same routing, same redaction, same
  ledger row. It is a provider whose `capabilities.native` is false, and
  that flag is what every published count is derived from.

## Routing

A channel is addressed by two independent things, and an event reaches
it only if both agree.

**Event classes.** A channel subscribes to classes, not raw events, and
every event belongs to exactly one class - so one logical event can
never reach the same channel twice:

| Class    | Events                                                            |
| -------- | ----------------------------------------------------------------- |
| monitor  | `monitor.down`, `monitor.up`                                      |
| incident | `incident.opened`, `incident.updated`, `incident.resolved`        |
| expiry   | monitor down/up for TLS/domain-expiry monitors                    |
| recovery | `recovery.succeeded`, `recovery.failed` (commercial)              |
| probes   | `probe.partial_failure`, `probe.insufficient_quorum` (commercial) |

**Scope.** A channel with no monitor targeting is an organization
default: it hears about every monitor, and about the events that belong
to no monitor at all, such as a manually reported incident. A channel
targeted at specific monitors hears about those and nothing else. The
workspace itself is the third scope and needs no setting, because an
organization _is_ the client boundary and channels already belong to
one.

A channel matched by more than one rule is still sent one message. That
is a property of the query, which returns each channel once, and of the
idempotency key, which is derived from the event and the channel id -
so even a replayed dispatch inserts nothing the second time.

Expiry is a carve-out of monitor down/up by monitor kind, and it is
exclusive: an expiring certificate pages the channel that asked for
expiry warnings, not the one that asked for outages. Recovery notifies
results only - success once verified, failure once the chain is
exhausted; attempts in between are timeline entries. Probe quorum events
are edge-triggered on the outcome class changing, so a monitor stuck in
`partial_failure` for an hour is one message, not one per round.

## Credentials at rest

Channel secrets are encrypted (AES-256-GCM) under a key derived from
`BETTER_AUTH_SECRET`. They are never returned to the browser - the
editor shows only _which_ secret fields are set - and delivery errors
are scrubbed of secret values and URL query strings before they are
stored or logged. Consequence: rotating `BETTER_AUTH_SECRET` orphans
stored channel credentials; deliveries then fail with a clear
"re-enter this channel's credentials" error rather than garbage.

Channels migrated from the pre-1.15 `webhook_endpoints` table are
sealed by the worker at its first boot after the upgrade.

## Rate limits

Three limits, and the one operators care about is the third.

**Per channel:** at most 10 messages per channel per delivery tick. Rows
beyond that are deferred to the next tick without spending a retry
attempt.

**Per provider:** a provider's `Retry-After` (header, or Telegram's
`retry_after` body parameter) is honored, so the backoff never schedules
earlier than the provider asked, capped at an hour.

**Vigil's own drain, which is the binding one for a large fan-out:** the
worker claims up to **250 messages per tick** (`NOTIFICATION_BATCH_SIZE`)
and runs one tick a minute, four deliveries in flight at a time. So an
event addressed to N channels needs about `ceil(N / 250)` ticks: one for
up to 250 channels, four for a thousand. That number is Vigil's, not a
provider's, and it is stated here because saying only "it depends on
your providers" would be untrue: for a fan-out wider than 250, this is
the limit you hit first.

**Selection is fair, not first-come.** Until 1.18.0 the drain was
`order by next_attempt_at limit 250` across every tenant at once, which
is starvation by construction: one organization fanning an incident out
to a thousand channels owned the head of the queue for four ticks, and
every other tenant's single page waited behind all thousand of them.
The selection now ranks each organization's due work independently and
takes the best rank from each in turn, so a small tenant's one message
rides in the first tick beside the big tenant's first message. Within an
organization it is still oldest-first. The big tenant is not penalised:
this is round-robin, not an equal split, so it still takes almost all of
a batch nobody else is competing for.

The concurrency of four is **derived from the database connection
pool**, not chosen for throughput. Each delivery takes a connection
several times - claim, load the channel, record the outcome - and the
pool is shared with the web application. The default is 40% of the pool
(`NOTIFICATION_DELIVERY_CONCURRENCY` overrides it), which at the shipped
pool of 10 is four. Raising it past the pool is how a large fan-out
becomes a slow dashboard; the benchmark below reports `pool waiting`,
and anything above zero during a drain is the measurement that says the
concurrency is too high for that installation.

A tick whose providers are all slow can take longer than its minute, in
which case the next one does not start on top of it.

**The ceiling this puts on the whole installation, stated plainly:** one
tick a minute at 250 messages a tick is **15,000 deliveries an hour**,
across every tenant together. The tick does not loop until the queue is
empty - it takes a batch and stops. A backlog deep enough that a message
sits behind more than six hours of batches will reach its horizon and be
marked `expired` without ever being attempted, and at the default
settings that means a standing backlog above about 90,000 messages. If
you are near that, raise `NOTIFICATION_BATCH_SIZE`, which is why it is a
setting.

Two smaller limits worth knowing before they surprise you:

- **The per-channel cap is applied after the claim.** A single very
  noisy channel can fill a batch and then have most of it deferred, so
  the tick does less work than its size suggests. A channel is capped at
  600 messages an hour by that rule.
- **A message that only ever loses the per-channel cap can expire with
  zero attempts.** The ledger shows it as expired with no attempts and
  no error, because there was no provider error - Vigil was the limiter.

Rate limiting is deliberately the only abuse control here. The channel
count is not one: bounding how many rows a tenant may own is a poor
proxy for bounding how much it may send, and it punished the legitimate
agency with forty clients while doing nothing about a single channel
pointed at a victim.

Test deliveries skip the outbox, because the operator is watching and
wants the answer now, so they skip that per-channel limit too. They get
their own: 30 per organization per hour. Without one the button is a
send-on-demand primitive against any address the egress policy allows.

The drain that runs inline right after a dispatch is bounded to the
number of rows that dispatch queued. It happens inside a server action
on the manual-incident paths, and a full batch of rows each allowed a
ten-second provider timeout would be minutes of synchronous work in
somebody's request. Anything it does not reach stays queued for the
worker's minute tick, which is the outbox guarantee doing its job.

## What a large number of channels costs

Measured, not asserted. `npm run bench:channels` writes
`docs/evidence/channel-bench/channel-fanout.json` and these figures come
out of it; the numbers below are the median of five runs on one
organization with a mix of Slack, Telegram and webhook channels.

| Channels | Settings list (one page) | Dispatch planning | Fan-out into the outbox | Worker heap |
| -------- | ------------------------ | ----------------- | ----------------------- | ----------- |
| 0        | 0.93 ms                  | 0.18 ms           | 0.2 ms                  | 19.4 MB     |
| 1        | 1.76 ms                  | 0.42 ms           | 1.24 ms                 | 22.3 MB     |
| 10       | 1.69 ms                  | 0.55 ms           | 2.22 ms                 | 30.4 MB     |
| 100      | 1.33 ms                  | 0.49 ms           | 9.68 ms                 | 30.7 MB     |
| 1,000    | 1.23 ms                  | 1.21 ms           | 87.26 ms                | 49.9 MB     |

What the shape of that table means:

- **Listing is flat.** It costs the same at one channel and at a
  thousand, because the list is paged in the database and the redacted
  destination is a stored column. Rendering it decrypts nothing at all,
  which is the property that made removing the cap safe.
- **Planning is nearly flat.** One indexed query resolves the routes:
  the tenant index narrows to that organization's channels, and the
  event class is matched in the heap afterwards. There is deliberately
  no GIN index on the class column - one was added, measured, and found
  to make routing slower on this product's shape (many organizations
  owning few channels each), so it was dropped and the measurement is
  recorded in the schema comment.
- **Fan-out grows with the channel count, by construction.** One event
  addressed to a thousand channels is a thousand outbox rows, because
  every one of them is a durable promise to deliver. That is the
  guarantee, not an inefficiency. It is one batched insert, not one per
  channel.

None of this measures delivery. No provider is contacted anywhere in
that benchmark. How fast messages actually leave is governed by the
three limits above: Vigil's 250-per-minute drain first for a wide
fan-out, then the per-channel limit, then whatever each provider
enforces.

## What a DEEP queue costs

The table above is many CHANNELS. This one is many QUEUED MESSAGES,
which is the shape a provider outage produces. `npm run bench:queue`
writes `docs/evidence/channel-bench/queue-depth.json` and these figures
come out of it.

| Queued | Tenants | Planning | Claim a batch | One whole tick | Delivered in it | Worker heap | Pool waiting |
| ------ | ------- | -------- | ------------- | -------------- | --------------- | ----------- | ------------ |
| 1      | 1       | 2.13 ms  | 8.94 ms       | 9.36 ms        | 1               | 20.8 MB     | 0            |
| 100    | 4       | 1.44 ms  | 12.32 ms      | 106.78 ms      | 100             | 25.4 MB     | 0            |
| 1,000  | 10      | 2 ms     | 31.99 ms      | 148.92 ms      | 250             | 45.1 MB     | 0            |
| 10,000 | 25      | 16.19 ms | 39.18 ms      | 203.19 ms      | 250             | 55.1 MB     | 0            |

What the shape means:

- **Planning stays cheap as the queue deepens.** The fair ranking is
  the expensive-looking part - a window function over every due row -
  and at ten thousand queued messages it is still about 16 ms, because
  the partial index on `(organization_id, next_attempt_at)` makes it an
  ordered walk rather than a sort of the queue.
- **A tick costs the same whatever is behind it.** Claiming and
  delivering 250 messages takes about the same time at 1,000 queued as
  at 10,000, because the batch is the unit of work. A deep queue is
  drained by more ticks, not slower ones.
- **The pool is never starved.** `pool waiting` is zero at every depth,
  which is the measurement the concurrency default is derived from.

**This does not measure provider throughput.** The transport in that
benchmark is a stub that returns `delivered` without opening a socket,
so every number is Vigil's own work. How fast messages actually reach a
provider is governed by that provider's limits, by the per-channel cap
of ten per tick, and by the batch size - and a queue that drains at
250 a minute here will drain more slowly than that against a real
provider that is rate limiting you.

## Why there is an outbox

Before 1.13.0 the flow was: decide, render, call the transport, mark the
incident notified. The Resend transport caught its own errors, logged a
warning and resolved successfully, and its signature returned nothing,
so a provider 500, a 429, a timeout and a real delivery were
indistinguishable at every call site. `incidents.notified_at` had already
been stamped by then. An operator asking "was I paged?" could not be
answered from the database.

Now the decision and the delivery are two separate durable facts, and
they are joined by a third: the **dispatch intent**.

The sentence "rows are written in the same transaction as the thing that
caused them" was in this document from 1.13.0 and, until 1.18.2, no
caller did it. Every incident path committed the state change and then,
afterwards, worked out who to tell: resolve the channel routes, fetch the
members, walk the status pages, insert a row per recipient. All of that
is work against a database that can refuse, in a process that can be
killed, and none of it was covered by the commit that made the incident
real.

The worst case was not "a message was late". `claimIncidentNotification`
stamps `notified_at` and is exactly-once by design; it committed BEFORE
the notifications were assembled. A worker killed in between left an
incident that was open, marked notified, and silent - and because the
repair path (`findUnhandledAutoIncident`) requires `notified_at is
null`, nothing would ever notice. Nobody was paged for that outage, by
anything, ever.

A transition now writes exactly one extra row inside its own
transaction: `notification_intents`, holding the rendered messages it
owes under a key derived from the transition. A worker expands that
intent into outbox rows afterwards, and expansion is idempotent because
every row it writes carries a key derived from the cause. So:

| The process dies…                  | What is left                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| before the transition commits      | nothing at all: no incident, no intent, no messages                          |
| after it commits, before expansion | a pending intent; the next tick expands it                                   |
| part-way through expansion         | some messages and a pending intent; re-expansion writes only what is missing |

The payload is **rendered at the transition**, not read back at
expansion. An expansion that re-read the incident would describe it as it
is by then, so a page delivered after the outage ended would carry
`"status": "resolved"` in a message whose entire job is to say the
monitor is down.

A pending intent is counted in the queue-health card along with queued
messages, because to anyone waiting to be told they are the same thing.

### Ordering within one transition

One transition can produce several messages: `monitor.down` and
`incident.opened`, the responder email, one mail per status-page
subscriber. They are inserted in one transaction with one
`next_attempt_at`, and the fair ranking breaks that tie on `id`, which
`uuidv7()` makes monotonic, so they are _claimed_ in the order they were
written.

**Delivery order is not guaranteed and the product does not claim it.**
A batch is handed to several workers at once, and any message that
retries lands behind messages decided later. Nothing depends on the
order: every message states its own event rather than implying it from
what arrived before.

## The six states

Four of them are terminal, and they are four rather than one because an
operator responds to each differently. `failed` used to mean all three
of the unhappy ones, so a wrong credential and a provider that was down
all afternoon looked identical in the ledger and led to opposite fixes.

| State         | Means                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `queued`      | decided, waiting for its next attempt - `next_attempt_at` says when                                                      |
| `sending`     | a worker holds a lease on it right now                                                                                   |
| `delivered`   | a provider accepted it, and its receipt is in `provider_message_id`                                                      |
| `failed`      | a provider REJECTED it and will keep rejecting it: a bad credential, an address that does not exist, a malformed payload |
| `dead_letter` | it ran out of ATTEMPTS while still retryable - a provider answering fast and badly                                       |
| `expired`     | it ran out of TIME - the retry horizon passed, which is what an unreachable provider looks like                          |

The distinction that matters most: **a screen full of `expired` means
your provider was unreachable; a screen full of `failed` means
something is misconfigured.** The first will fix itself, the second
will not.

`sending` is a timestamped lease, not a flag. That is what makes crash
recovery possible: a worker killed mid-send has its lease expire and the
next tick picks the row up. A boolean "in flight" would park the message
forever.

## Every attempt leaves a record

The outbox row holds the CURRENT state of a message. It is updated in
place - a retry overwrites `last_error`, a success overwrites the
counter - which is right for a queue and useless as evidence. The
fourth attempt's error replaces the third's, and a worker that sent a
message and then died leaves nothing behind at all.

So each attempt also writes its own row in `notification_attempts`,
**before anything is sent**, and that row is completed exactly once by
the worker that owns it. Nothing is ever overwritten by a later
attempt. The settings page shows the timeline per delivery: attempt
number, outcome, HTTP status, the redacted error, the provider's
receipt, and what it asked for in `Retry-After`.

An attempt has five possible outcomes, and the last two are the point:

| Outcome     | Means                                                       |
| ----------- | ----------------------------------------------------------- |
| `claimed`   | a worker has it right now and has not reported back         |
| `delivered` | the provider accepted it                                    |
| `retryable` | it failed and NOTHING was sent that could have taken effect |
| `permanent` | the provider rejected it                                    |
| `unknown`   | the request went out and its fate is not known              |

`unknown` is not a synonym for `retryable`. A refused connection or a
name that did not resolve sent nothing; a timeout after the body was
written may have arrived, been acted on, and lost its answer coming
back. Both are retried - at-least-once is the promise - but only
`unknown` means **a duplicate at the far end cannot be ruled out**, and
the settings page counts those separately for exactly that reason. A
row still reading `claimed` an hour later is a worker that died
mid-flight; the nightly sweep turns it into `unknown` rather than
guessing.

## Leases are fenced

A lease bounds how long a worker is TRUSTED. It cannot stop a worker
that was paused past its lease - by GC, by swapping, by a provider that
took four minutes - from waking up and writing its result over the
newer worker's. The ledger would then report the loser's outcome for
the winner's send, which is the same class of lie as the duplicate the
lease exists to prevent.

So every claim increments a `fence` on the row and carries the value.
Every write from that delivery - the outcome, the lease renewal, even a
deferral - names its fence, and a superseded worker's write matches no
row. It learns that immediately, records its own attempt as `unknown`
because it genuinely does not know whether its request arrived, and
touches nothing else. The drain reports a `superseded` count; above
zero means leases are expiring under live work.

## At-least-once, and the window that makes it so

The unavoidable case is a crash after the provider accepted the message
but before the row records that it did. The outbox cannot tell that apart
from a request that never arrived, so it retries, and a retry means the
recipient can, in principle, get two copies.

What it does about that is make the retry harmless rather than pretend
the window does not exist. Where a provider offers a way to say "this is
the same request as before", Vigil sends one, derived from the outbox row
so the same row always produces the same value. Which providers those
are is the `Dedupes` column in the tables above, and it is a registry
flag rather than a sentence someone maintains.

The `Dedupes` column in the tables above is `yes` only where the
provider itself collapses the repeat. Three near-misses are listed here,
because they are useful and are NOT that:

| Transport                         | How a redelivery is handled                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Resend (member email and channel) | Collapsed. `Idempotency-Key`, which Resend honours                                                                                                                             |
| Matrix                            | Collapsed. The transaction id in the path; a repeat is a retransmission, not a second event                                                                                    |
| LINE                              | Collapsed. `X-Line-Retry-Key`, and the `409` LINE answers with is recorded as delivered, because it means the first one arrived                                                |
| PagerDuty                         | Collapsed. `dedup_key`, which also joins every event about one outage into one alert                                                                                           |
| SMTP                              | **Not** collapsed. `Message-ID` is the outbox row id, so a receiving client may hide the copy; no relay deduplicates on it                                                     |
| Amazon SNS                        | **Not** collapsed on a standard topic. A `.fifo` topic gets `MessageDeduplicationId` and SNS's five-minute window                                                              |
| Jira Service Management           | **Not** collapsed. Jira offers no idempotency key on issue creation, so a lost response can produce a second comment, or a second ticket if the search index has not caught up |
| Signed webhook                    | Not collapsed here. A retry re-sends identical bytes, so a receiver that dedupes on the body can                                                                               |
| Other chat, push and SMS          | None offered by the provider; the crash-retry window is the only duplicate source                                                                                              |
| Apprise bridge                    | None. What your Apprise server does with a repeat is your server's business                                                                                                    |
| Escalation SMS and voice          | **Not** collapsed by Twilio. The outbox key is `escalation:<incident>:<step>:<recipient>`, so a re-run of the ladder job enqueues nothing; only a crash-retry can repeat one   |
| Log transport                     | Not applicable; it writes to the log                                                                                                                                           |

So: **at most one message per logical notification where the provider
cooperates, at least one everywhere.** That is the honest wording, and it
is the wording the product uses.

A note on what "cooperates" buys you at a pager. PagerDuty and Jira do
something stronger than collapsing a retry: their key is derived from
the CAUSE, not the delivery, so `monitor.down` and `incident.opened` for
one outage land on one alert and one ticket, and the recovery closes it.
That is why those two are the only providers with a `Closes` column
entry, and why pointing them at the monitor class as well as the
incident class does not double anything.

## Retries

**Twenty attempts over a six-hour horizon**, exponentially backed off to
a half-hour ceiling and jittered by a quarter either way:

| Attempt | Wait before it (no jitter) |
| ------- | -------------------------- |
| 2       | 2 s                        |
| 3       | 4 s                        |
| 4       | 8 s                        |
| 5       | 16 s                       |
| 6       | 32 s                       |
| 7       | 64 s                       |
| 8       | 2 min                      |
| 9       | 4 min                      |
| 10      | 9 min                      |
| 11      | 17 min                     |
| 12-20   | 30 min each                |

Jitter is not decoration - without it, an outage that queues a thousand
messages returns all thousand at the same instant and the recovery
attempt is the next outage. A quarter either way still spreads a
thousand messages across a fifteen-minute window at the ceiling, and
leaves the schedule something you can predict from this table.

Until 1.18.0 this was six attempts over **31 to 62 seconds**, and a
provider outage lasting longer than a minute ended with every queued
alert marked failed. That is the limitation this release removes.

**Two bounds end a chain, and the terminal state says which was hit:**

- `NOTIFICATION_MAX_ATTEMPTS` (20) - the message becomes `dead_letter`.
  It ran out of tries, which is what happens when a provider answers
  quickly and badly.
- `NOTIFICATION_RETRY_HORIZON_HOURS` (6) - the message becomes
  `expired`. It ran out of time, which is what happens when a provider
  is unreachable.

Both are reachable on the shipped defaults: twenty attempts on the curve
above is about five hours, inside a six-hour horizon. Two controls that
can never both bind would be one control and a decoration.

The horizon is a **product** decision, not a resource limit. An alert is
perishable: a monitor-down page delivered six hours late is not a late
alert, it is a false one, describing an outage that is over and
competing for attention with whatever is happening now. Raise it if you
would rather have the message eventually than not at all; the ceiling
is 72 hours, past which the message is archaeology.

The deadline is stamped on each row **at enqueue**, so it survives a
restart, a redeploy and a configuration change: work already in the
queue keeps the deadline it was accepted under. Nothing about the
schedule lives in worker memory - it is `next_attempt_at` and
`expires_at` on the row - so a deploy mid-outage changes nothing about
when a message is next tried.

A failure is classified before it is retried:

- **retryable**: 429, any 5xx, a refused connection, a name that did not
  resolve. Backed off and tried again.
- **unknown**: a timeout, a reset mid-response, a worker that died.
  Retried the same way, recorded differently, because a duplicate
  cannot be ruled out.
- **permanent**: a 4xx that names the message or the recipient. Marked
  `failed` immediately, because retrying a rejected address hides a
  configuration error behind a queue that never drains. The one 4xx
  that is not a failure is LINE's `409`, which means "I already
  accepted this retry key" - so it is recorded as delivered, which is
  what it is.

A provider's own `Retry-After` is honoured up to **one hour**. Honoured,
because retrying into a stated rate limit burns an attempt to learn
nothing; bounded, because `Retry-After: 86400` from a misconfigured
proxy would otherwise park an alert past its own horizon and it would
expire without ever being tried again.

## Dead letters, replay and retention

A terminal delivery is not the end of what you can do about it.

**Replay** takes one delivery or a bounded selection (at most 100) and
queues it again. It is new work, never a rewind: the original keeps its
state, its attempts and its final reason forever, and the copy points
back at it. Rewinding a terminal row in place would be one line of SQL
and would destroy the only record of what happened - an operator
replaying a batch after fixing a credential would be erasing the
evidence that the credential was ever wrong. Replaying the same
delivery twice produces two deliveries, because that is what pressing
the button twice means. It needs the `notification:update` permission,
which is also what the ledger itself requires. It is bounded twice: at
most 100 deliveries in one action, and at most 500 replayed deliveries
an hour per workspace, counted in the database so the bound holds
however many app replicas you run. Every replay writes an audit row
naming who did it, which deliveries were replayed and which new ones
were created.

**Retention** removes finished deliveries and their attempt evidence
after `NOTIFICATION_RETENTION_DAYS` (30), on the nightly sweep. It only
ever touches the four terminal states - a queued message is not old,
it is late, and deleting it would silently drop a notification the
outbox promised to deliver. The sweep is bounded (5,000 a pass) so a
first run on a long-lived installation converges over a few nights
rather than holding locks for minutes, and it logs whether there is
more to do.

## Status-page subscriber mail

Subscriber mail goes through the outbox like everything else, and until
1.18.2 it was the one path that did not: a `Promise.allSettled` over a
transport that could not reject, with no key, no retry, no attempt
evidence, no dead letter and no ledger entry, for the one audience in
this product that is not staff.

Two things about a queued subscriber message are deliberately different
from every other row in the table.

**The message is rendered at delivery, not at enqueue.** The unsubscribe
link is a bearer token that never expires, and a queued row is kept for
the retention period, rendered in the operator's delivery history, and
present in every backup. The row stores the page and the subscriber id;
the link is minted when the message is sent, so it also honours a
`BETTER_AUTH_SECRET` rotation instead of shipping a signature that will
no longer verify.

**Consent is re-checked at delivery.** Unsubscribing DELETEs the
subscriber row. That window was milliseconds when this was a direct
send; through a queue it is up to the retry horizon. A message whose
subscriber is gone is recorded as `failed` with "The subscriber
unsubscribed before this could be delivered", not delivered anyway.

`destination` holds a masked address (`a****@example.com`) rather than
the real one. Member emails are addressed to staff of the organization
reading the ledger; a status-page subscriber gave an address to a public
page, not to an operator console.

## What `notified_at` means now

It means the notifications for that incident were durably queued, which
is a real guarantee, because the outbox will deliver them or record that
it could not. It does **not** mean anyone has read anything. The outbox
rows are the record of what actually happened to each message.

## If no email provider is configured

With no `RESEND_API_KEY`, the transport is the log transport: messages
are written to the server log and reported as delivered, which is
truthful about what that transport does. It is not truthful to let an
operator believe they are being emailed, so `emailTransportName()` exists
and the interface says which transport is live. Set `RESEND_API_KEY` to
send real mail.

## Draining

The worker drains the outbox every minute, in batches, four deliveries
in flight at a time within a batch. Backoff lives in each row's `next_attempt_at`, not in the
schedule, so a tighter cron would only add empty wake-ups.

Due-ness and leases use the **database's** clock, never a worker's. With
more than one worker a client-side timestamp makes a row due at a
different instant on each machine, and, more immediately, `timestamptz`
holds microseconds while a JavaScript `Date` holds milliseconds, so a row
stamped `…373340` is not `<=` a client timestamp of `…373000` and a
message enqueued and drained inside the same millisecond is invisible to
its own worker.

A drain pass can be scoped to one organization. A single tenant whose
provider is timing out would otherwise fill every batch with its own
retries and starve everyone else's alerts.
