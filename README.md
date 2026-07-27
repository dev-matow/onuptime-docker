# Vigil Core

**Self-hosted uptime monitoring, incidents and status pages.** Two
processes and one Postgres — no Redis, no queue broker, no agents to
install.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-brightgreen.svg)](docs/DEPLOYMENT.md)

![Dashboard](docs/screenshots/dashboard.png)

---

## What it does

- **Six check types** — HTTP(S), TCP/port, ping (ICMP), DNS records,
  TLS-certificate expiry and domain-registration expiry, behind a
  registry. Adding one is five files and no dispatch to edit.
- **Assertions** — expected status, response-time thresholds, body
  contains or does not contain a keyword, DNS record values, days left
  on a certificate. A 200 that serves an error page is caught.
- **Scheduling that adapts** — the interval you set is a baseline, not a
  fixed rate: a suspicious monitor is probed harder and a steady one
  backs off. Minimum interval two seconds, which is what the queue
  actually delivers rather than what the form will accept.
- **Incidents** — opened and resolved by the check loop, with a failure
  window measured in seconds rather than a count of checks. Severity, a
  lifecycle, an append-only timeline, internal-only notes and a
  markdown postmortem.
- **Status pages** — as many as you like, each with its own URL,
  components, 90-day uptime bars and incident history. Public, private
  or password-protected, with double-opt-in email subscribers.
- **Team and roles** — owner, admin, responder, viewer. Viewers are
  read-only at the server boundary, not by hiding a button.
- **Audit trail** — every mutation recorded with actor, target and
  metadata, and a page to read it on.
- **Alerts** — email plus HMAC-signed webhooks that auto-format for
  Slack and Discord.

No licence key, no telemetry, no expiry, and no cap on monitors, users,
organizations' members or retention.

## Quick start

```bash
git clone https://github.com/sikurdev/vigil-core.git
cd vigil-core
cp .env.example .env      # set DATABASE_URL and BETTER_AUTH_SECRET
docker compose up -d
```

Then open http://localhost:3000. [QUICK_START.md](QUICK_START.md) has the
bare-metal path and the first-monitor walkthrough.

## Honest limitations

Worth knowing before you deploy:

- **Checks run from one host.** A monitor going down means _your Vigil
  host_ could not reach it. The failure window filters blips, but this is
  not multi-region confirmation and never claims to be. Run Vigil outside
  the blast radius of what it watches.
- **Six check types.** Uptime Kuma has roughly thirty-one, including
  databases, message brokers and push/heartbeat. If your monitoring is
  mostly "is this database reachable", Kuma does that today and this
  does not.
- **Four notification channels** — email, webhook, and the Slack and
  Discord formats of that webhook. Kuma has around ninety.
- **No password reset yet.** A forgotten password means an admin
  re-invites you. Top of the list.
- **One organization per install.** Fine for a team watching its own
  systems; not built to run many separate clients side by side.

## How this repository is produced

Vigil Core is not maintained by hand. It is generated from the
commercial edition's tree by deleting every file and statement marked
`@edition:ee`, and the same script runs in that repository's build gate —
so Core cannot quietly fall behind. If it did, the build would be red
before the release existed.

Both editions are cut from the same commit and carry the same version
number. **If this repository's version ever trails the commercial one,
the mechanism is broken and you are looking at the evidence.**

History is never rewritten here and releases are never force-pushed, so
a pull request always has somewhere to land.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) — there is no CLA and no copyright
assignment, and it says plainly what Apache-2.0 lets the maintainer do
with your contribution. Security issues go privately to
[SECURITY.md](SECURITY.md), not to the issue tracker.

## The commercial edition

[Vigil](https://vigil-uptime.com) is the same monitor with four things
Core does not have, none of which Uptime Kuma has either:

- **Isolate** — many client organizations in one install, each with its
  own status pages and unable to see the others.
- **Rotate** — on-call schedules and escalation ladders that know whose
  turn it is tonight, with acknowledgement stopping the ladder.
- **Reach** — SMS and voice through your own Twilio account.
- **Repair** — automatic recovery: verify the failure, call a restart
  hook you own with a signed payload, verify it came back, and page a
  human only if it did not.

Everything else — every check type, the scheduler, the ledger, the audit
page, subscribers, password-protected pages — is here, free, and stays
here. [What we commit to, in writing](https://vigil-uptime.com/commitments.html).

## License

[Apache-2.0](LICENSE). Run it, modify it, keep your changes private, run
it for clients, sell it. There is no copyleft obligation. Vigil Core was
AGPL-3.0 through 1.0.1; copies obtained under that licence remain
available under it.
