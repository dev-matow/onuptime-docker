# What Vigil guarantees about alerts

One sentence, and the rest of this page is why it is worded exactly that
way:

> When Vigil decides to alert you, that decision is durable, and the
> message will be delivered at least once or recorded as failed.

Not "all alerts are delivered". Nothing that hands a message to a third
party can promise that, and a product that says it anyway is making a
promise its transports cannot keep.

## Why there is an outbox

Before 1.13.0 the flow was: decide, render, call the transport, mark the
incident notified. The Resend transport caught its own errors, logged a
warning and resolved successfully, and its signature returned nothing —
so a provider 500, a 429, a timeout and a real delivery were
indistinguishable at every call site. `incidents.notified_at` had already
been stamped by then. An operator asking "was I paged?" could not be
answered from the database.

Now the decision and the delivery are two separate durable facts.
`notification_outbox` rows are written **in the same transaction as the
thing that caused them** — the incident opening, the escalation step
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
from a request that never arrived, so it retries — and a retry means the
recipient can, in principle, get two copies.

What it does about that is make the retry harmless rather than pretend
the window does not exist. Every message carries an idempotency key
derived from its cause, and that key is sent to the provider as an
`Idempotency-Key` header. A provider that honours one collapses the
duplicate on its side.

| Transport     | Duplicate suppression                                                      |
| ------------- | -------------------------------------------------------------------------- |
| Resend        | Yes — honours `Idempotency-Key`                                            |
| Log transport | Not applicable; it writes to the log                                       |
| Webhooks      | The receiver's problem, and the signed payload carries the key so they can |

So: **at most one message per logical notification where the provider
cooperates, at least one everywhere.** That is the honest wording, and it
is the wording the product uses.

## Retries

Six attempts, exponentially backed off from a second to a five-minute
cap, jittered. Jitter is not decoration — without it, a provider outage
that queues a thousand messages returns all thousand at the same instant
and the recovery attempt is the next outage.

A failure is classified before it is retried:

- **retryable** — 429, any 5xx, a timeout, a DNS failure. Backed off and
  tried again.
- **permanent** — a 4xx that names the message or the recipient. Marked
  `failed` immediately, because retrying a rejected address for half an
  hour hides a configuration error behind a queue that never drains.

After the sixth attempt a retryable failure becomes `failed` too. A
message nobody will ever receive should say so where an operator can see
it.

## What `notified_at` means now

It means the notifications for that incident were durably queued — which
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
different instant on each machine — and, more immediately, `timestamptz`
holds microseconds while a JavaScript `Date` holds milliseconds, so a row
stamped `…373340` is not `<=` a client timestamp of `…373000` and a
message enqueued and drained inside the same millisecond is invisible to
its own worker.

A drain pass can be scoped to one organization. A single tenant whose
provider is timing out would otherwise fill every batch with its own
retries and starve everyone else's alerts.
