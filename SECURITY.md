# Security policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public
issue. Contact [**@s8kur on Telegram**](https://t.me/s8kur), or use the
support channel on your purchase receipt, with:

- the affected version and component (the app or the worker),
- steps to reproduce,
- the impact you observed.

You'll receive an acknowledgement, and where a fix is warranted, a
patched release within the version-1 update window.

## Supported versions

Security fixes are published for the current major version (1.x). See
[CHANGELOG.md](CHANGELOG.md) for released versions.

## Hardening your deployment

Vigil is self-hosted, so you own the deployment surface. The essentials:

- Set a strong `BETTER_AUTH_SECRET` — `openssl rand -base64 32`.
- Keep `ALLOW_PRIVATE_MONITOR_TARGETS` unset or `false` in production so
  monitors cannot probe private networks (SSRF protection).
- Terminate TLS in front of the app; only its port needs to be public.
  The database is never exposed to the internet in the shipped setup.
- Keep `.env` out of version control — it already is, via `.gitignore`.

What ships hardened by default: security headers, non-root container
images, RBAC guards on every mutation, HMAC-signed webhooks, the
outbound egress policy below, and a database-checked health endpoint.
The full security model is documented in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Outbound requests — the egress policy

Vigil makes outbound requests on your behalf from four places: monitor
probes, the redirects those probes follow, webhook delivery, and
recovery triggers. All four go through one policy
(`src/modules/monitors/egress.ts`), so a rule learned in one is a rule
everywhere.

**The floor, which no setting can lower.** Cloud instance-metadata
addresses (`169.254.169.254`, `169.254.170.2`, `fd00:ec2::254`,
`metadata.google.internal`), the whole link-local range
(`169.254.0.0/16`, `fe80::/10`), the unspecified address, and reserved
space (multicast, broadcast, TEST-NET, benchmarking, future-use) are
unreachable on every channel, whatever else is configured. The check is
on the _classified address_, not on the text of the URL, so every
encoding of the same address is refused — including
`[::ffff:169.254.169.254]`, `[::ffff:a9fe:a9fe]`, `64:ff9b::a9fe:a9fe`
and `2002:a9fe:a9fe::`.

**Private space, which is yours to decide, per channel.**

| Variable                         | Default | What it governs                                             |
| -------------------------------- | ------- | ----------------------------------------------------------- |
| `ALLOW_PRIVATE_MONITOR_TARGETS`  | `false` | Whether monitor probes may reach RFC1918/CGNAT/ULA/loopback |
| `ALLOW_PRIVATE_WEBHOOK_TARGETS`  | `true`  | Same, for org webhook delivery                              |
| `ALLOW_PRIVATE_RECOVERY_TARGETS` | `true`  | Same, for recovery triggers                                 |

The last two default to allow because a self-hosted install routinely
posts to a receiver on its own network, and a recovery hook on an
internal address is the entire point of the feature. Set them to
`false` on a deployment where those URLs are not typed by someone you
trust.

**Every redirect hop is a separate decision.** Redirects are followed by
an explicit loop that resolves and classifies each hop before issuing
it; the HTTP client is never asked to follow one. Webhook and recovery
delivery follow none at all — a redirect would downgrade the signed POST
to an unsigned GET and move it to a host you never configured — and
report the 3xx as a delivery failure. Credentials (`Authorization`,
`Cookie`, `X-Vigil-Signature`) are dropped on any hop that crosses
origins.

**The address that was checked is the address that is used.** The
HTTP-family paths resolve DNS themselves and hand the resolved address
to the connection, keeping the original hostname for the `Host` header
and the TLS certificate check. A DNS server that answers one thing to
the guard and another to the connector therefore has nothing to gain:
there is only one lookup. Validation is redone from scratch on every
request and every retry, never cached across them.

**Approved exceptions are recorded.** Whenever policy permits a request
into non-public space, an `egress.exception` event is logged with the
channel, hostname, resolved address, its classification, the redirect
hop, and the URL with credentials and query string stripped. Ship your
logs somewhere and this is your outbound audit trail.

### Known residual risk

The non-HTTP check types — `tcp`, `tls-expiry`, `smtp`, `ping`,
`docker`, and the database probes — resolve and classify the target the
same way, but then open their own socket through a driver that performs
its own lookup. A DNS server that changes its answer between those two
moments has a window there. It is a small one and it is not a redirect
chain, but it is real, and closing it needs a pinned address threaded
through drivers that do not all expose one. The HTTP-family paths,
webhook delivery and recovery triggers do not have this window.

## Automatic recovery — the safety model

Recovery is the one feature that makes an outbound, state-changing
request to an address you supply, so it is deliberately the most
constrained path in the product:

- **Off until you turn it on, per monitor.** No recovery request is
  ever sent unless you saved a recovery action and enabled it. A fresh
  install never calls out.
- **Cloud metadata endpoints are blocked at input and again at
  execution.** A recovery URL that _is_ a metadata or link-local address
  is rejected when you save it, in any encoding. That is only the early
  answer: the hostname you saved has a DNS record you do not own
  forever, so the trigger resolves and classifies it again at the moment
  it fires, and refuses then too. Unlike monitor targets, recovery
  endpoints are allowed to be private/internal hosts on purpose — the
  whole point is to reach a restart hook inside your own network, which
  you configured. See the egress policy above for the exact ranges and
  for `ALLOW_PRIVATE_RECOVERY_TARGETS`.
- **It's your endpoint, and it can verify the caller.** Every trigger is
  signed (`X-Vigil-Signature`, HMAC-SHA-256, same scheme as webhooks),
  so your receiver can reject anything that isn't Vigil before it acts.
  A one-file example receiver ships in `examples/recovery-receiver.mjs`.
- **"Verified" means verified-in-time, not global.** Checks run from
  the single host you deploy Vigil on. Before firing, the worker
  re-probes to confirm the failure is still happening (so a one-off
  blip doesn't trigger a restart); after firing, it probes again before
  calling recovery a success. This removes transient false positives —
  it is not a multi-region confirmation, and the docs never claim one.
  If you need multi-vantage confirmation, run Vigil outside the blast
  radius of what it watches, or gate the recovery hook itself.
- **Bounded and audited.** Attempts are capped per incident (1–5) with a
  cooldown, capped per monitor per day (restart-loop guard), and every
  attempt is an immutable record with pre-check, delivery, verification
  and timings. Nothing recovery does is silent.

## Reducing the trust surface

- `GITHUB_TOKEN` and any recovery/webhook receiver you build should have
  the narrowest scope that works.
- Grant the `viewer` role freely — it is read-only and never sees
  signing secrets or mutation controls.
