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
worker claims up to **250 messages per tick** and runs one tick a
minute, four deliveries in flight at a time. So an event addressed to N
channels needs about `ceil(N / 250)` ticks: one for up to 250 channels,
four for a thousand. That number is Vigil's, not a provider's, and it is
stated here because saying only "it depends on your providers" would be
untrue: for a fan-out wider than 250, this is the limit you hit first.

A tick whose providers are all slow can take longer than its minute, in
which case the next one does not start on top of it. The concurrency of
four is set by the database connection pool, not by throughput: the pool
is shared with the application, and a drain that took most of it would
show up as a slow dashboard during a large fan-out.

The scheduled pass is global and ordered by due time, so a very large
fan-out on one tenant does share the drain with other tenants. A caller
that needs to bound that runs an organization-scoped pass, which is what
the inline drain after a dispatch does.

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

## Why there is an outbox

Before 1.13.0 the flow was: decide, render, call the transport, mark the
incident notified. The Resend transport caught its own errors, logged a
warning and resolved successfully, and its signature returned nothing,
so a provider 500, a 429, a timeout and a real delivery were
indistinguishable at every call site. `incidents.notified_at` had already
been stamped by then. An operator asking "was I paged?" could not be
answered from the database.

Now the decision and the delivery are two separate durable facts.
`notification_outbox` rows are written **in the same transaction as the
thing that caused them**, the incident opening, the escalation step
firing. So the intent commits with its cause or not at all, and a worker
that dies between them comes back to find the message still queued.

## The four states

| State       | Means                                                               |
| ----------- | ------------------------------------------------------------------- |
| `queued`    | Vigil decided to send this and has not yet succeeded                |
| `sending`   | a worker holds a lease on it right now                              |
| `delivered` | a provider accepted it, and its receipt is in `provider_message_id` |
| `failed`    | it will never be delivered, and `last_error` says why               |

`sending` is a timestamped lease, not a flag. That is what makes crash
recovery possible: a worker killed mid-send has its lease expire and the
next tick picks the row up. A boolean "in flight" would park the message
forever.

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

Six attempts, exponentially backed off and jittered: 2 s, 4 s, 8 s,
16 s, 32 s before jitter, which is a **total retry window of 31 to 62
seconds**. Jitter is not decoration - without it, a provider outage that
queues a thousand messages returns all thousand at the same instant and
the recovery attempt is the next outage.

Say the consequence out loud, because rounding it away is how this
number came to be wrong on three pages at once: **a provider outage
lasting longer than about a minute ends with its queued messages marked
`failed`.** They are marked, not lost - the ledger names each one, its
destination and the last error - but nothing retries them after that. If
your provider is regularly out for longer than a minute, the outbox is
doing what it says and the answer is a second channel, not a longer
queue.

A failure is classified before it is retried:

- **retryable**: 429, any 5xx, a timeout, a DNS failure. Backed off and
  tried again.
- **permanent**: a 4xx that names the message or the recipient. Marked
  `failed` immediately, because retrying a rejected address hides a
  configuration error behind a queue that never drains. The one 4xx
  that is not a failure is LINE's `409`, which means "I already
  accepted this retry key" - so it is recorded as delivered, which is
  what it is.

After the sixth attempt a retryable failure becomes `failed` too. A
message nobody will ever receive should say so where an operator can see
it.

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
