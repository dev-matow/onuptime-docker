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
images, RBAC guards on every mutation, HMAC-signed webhooks, SSRF checks
on monitor targets, and a database-checked health endpoint. The full
security model is documented in [ARCHITECTURE.md](ARCHITECTURE.md).

## Automatic recovery — the safety model

Recovery is the one feature that makes an outbound, state-changing
request to an address you supply, so it is deliberately the most
constrained path in the product:

- **Off until you turn it on, per monitor.** No recovery request is
  ever sent unless you saved a recovery action and enabled it. A fresh
  install never calls out.
- **Cloud metadata endpoints are blocked at input.** A recovery URL
  resolving to `169.254.169.254` or `metadata.google.internal` is
  rejected — the classic SSRF target can't be used as a trigger. Unlike
  monitor targets, recovery endpoints are allowed to be private/internal
  hosts on purpose: the whole point is to reach a restart hook inside
  your own network, which you configured.
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
