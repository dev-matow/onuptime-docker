# Security policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public
issue. Email **s8kur3@gmail.com** or contact
[**@s8kur on Telegram**](https://t.me/s8kur), with:

- the affected version and component (the app or the worker),
- steps to reproduce,
- the impact you observed.

You'll receive an acknowledgement, and where a fix is warranted, a
patched release and a note in the changelog.

## Supported versions

Security fixes are published for the current major version (1.x). See
[CHANGELOG.md](CHANGELOG.md) for released versions.

## Hardening your deployment

Vigil Core is self-hosted, so you own the deployment surface. The
essentials:

- Set a strong `BETTER_AUTH_SECRET` — `openssl rand -base64 32`.
- Keep `ALLOW_PRIVATE_MONITOR_TARGETS` unset or `false` in production so
  monitors cannot probe private networks (SSRF protection).
- Terminate TLS in front of the app; only its port needs to be public.
  The database is never exposed to the internet in the shipped setup.
- Keep `.env` out of version control — it already is, via `.gitignore`.

What ships hardened by default: security headers, non-root container
images, role guards on every mutation, HMAC-signed webhooks, SSRF checks
on monitor targets, and a database-checked health endpoint. The full
security model is documented in [ARCHITECTURE.md](ARCHITECTURE.md).

## What "verified" means

Checks run from the single host you deploy Vigil on. A monitor going
down means _this host could not reach it_ — that removes transient
blips through the consecutive-failure threshold, but it is not a
multi-region confirmation, and the docs never claim one. If you need
multi-vantage confirmation, run Vigil outside the blast radius of what
it watches.

## Reducing the trust surface

- Webhook endpoint secrets are shown only to members who can edit them;
  a `viewer` never sees a signing secret.
- Grant the `viewer` role freely — it is read-only and never sees
  signing secrets or mutation controls.
