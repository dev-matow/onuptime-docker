# What Vigil guarantees about alerts

One sentence, and the rest of this page is why it is worded exactly that
way:

> When Vigil decides to alert you, that decision is durable, and the
> message will be delivered at least once or recorded as failed.

Not "all alerts are delivered". Nothing that hands a message to a third
party can promise that, and a product that says it anyway is making a
promise its transports cannot keep.

## Channel providers

Since 1.15.0, alerts route through **notification channels**: one
registry, one delivery pipeline, one routing model. A channel is a
provider plus its settings, its encrypted credentials and the event
classes it subscribes to. Ten providers ship, in both editions:

| Provider        | Transport                                | Credential               |
| --------------- | ---------------------------------------- | ------------------------ |
| Slack           | Incoming webhook (`hooks.slack.com`)     | the webhook URL          |
| Discord         | Channel webhook                          | the webhook URL          |
| Microsoft Teams | Workflows webhook, Adaptive Card payload | the workflow URL         |
| Telegram        | Bot API `sendMessage`                    | bot token (+ chat id)    |
| Google Chat     | Space incoming webhook                   | the webhook URL          |
| Gotify          | `POST /message`, `X-Gotify-Key` header   | application token        |
| ntfy            | JSON publish to the server root          | token or user + password |
| Webhook         | Signed JSON POST (`X-Vigil-Signature`)   | HMAC signing secret      |
| SMTP            | Own client: STARTTLS/TLS, AUTH PLAIN     | password (optional)      |
| Resend          | `POST /emails`, honors `Idempotency-Key` | API key                  |

Notes that are contracts, not trivia:

- **Teams** uses the Power Automate Workflows webhook - the retired
  Office 365 connector URLs stopped delivering in May 2026 and this
  provider never speaks MessageCard.
- **Every credential is the customer's own.** There is no Vigil-funded
  relay, account or hosted service behind any provider.
- **The customer's own servers are fine.** Gotify, ntfy and the signed
  webhook accept private addresses (a receiver on your own network is
  the normal deployment); cloud metadata and link-local space are
  refused wherever the URL points or resolves.
- **Redirects are never followed.** A redirect would re-target a
  credentialed request, and for signed payloads would drop the method,
  body and signature.
- **SMTP refuses to authenticate without TLS**, and certificate
  verification has no off switch.

## Event classes

A channel subscribes to classes, not raw events, and every event belongs
to exactly one class - so one logical event can never reach the same
channel twice:

| Class    | Events                                                            |
| -------- | ----------------------------------------------------------------- |
| monitor  | `monitor.down`, `monitor.up`                                      |
| incident | `incident.opened`, `incident.updated`, `incident.resolved`        |
| expiry   | monitor down/up for TLS/domain-expiry monitors                    |
| recovery | `recovery.succeeded`, `recovery.failed` (commercial)              |
| probes   | `probe.partial_failure`, `probe.insufficient_quorum` (commercial) |

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

At most 10 messages per channel per delivery tick. Rows beyond that are
deferred to the next tick without spending a retry attempt. A provider's
`Retry-After` (header, or Telegram's `retry_after` body parameter) is
honored: the backoff never schedules earlier than the provider asked,
capped at an hour. An organization can hold at most 20 channels.

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
the window does not exist. Every message carries an idempotency key
derived from its cause, and that key is sent to the provider as an
`Idempotency-Key` header. A provider that honours one collapses the
duplicate on its side.

| Transport                         | Duplicate suppression                                                             |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Resend (member email and channel) | Yes, honours `Idempotency-Key`                                                    |
| SMTP                              | `Message-ID` is the outbox row id, so a receiving MTA can collapse the copy       |
| Signed webhook                    | The receiver's problem, and the signed payload carries the key so they can        |
| Chat and push providers           | None offered by the provider; the crash-retry window is the only duplicate source |
| Log transport                     | Not applicable; it writes to the log                                              |

So: **at most one message per logical notification where the provider
cooperates, at least one everywhere.** That is the honest wording, and it
is the wording the product uses.

## Retries

Six attempts, exponentially backed off from a second to a five-minute
cap, jittered. Jitter is not decoration, without it, a provider outage
that queues a thousand messages returns all thousand at the same instant
and the recovery attempt is the next outage.

A failure is classified before it is retried:

- **retryable**: 429, any 5xx, a timeout, a DNS failure. Backed off and
  tried again.
- **permanent**: a 4xx that names the message or the recipient. Marked
  `failed` immediately, because retrying a rejected address for half an
  hour hides a configuration error behind a queue that never drains.

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

The worker drains the outbox every minute, in batches, sequentially
within a batch. Backoff lives in each row's `next_attempt_at`, not in the
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
