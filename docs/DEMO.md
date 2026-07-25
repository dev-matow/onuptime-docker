# Running the public demo

A read-only, auto-resetting deployment (e.g. `demo.yourdomain.com`)
that lets prospects click through real data without being able to
change anything.

## How DEMO_MODE works

Set `DEMO_MODE=true` on the app process. Then:

- **`GET /api/demo`** signs the visitor in as the seeded read-only
  viewer (`demo@altitude.demo`) and redirects to the dashboard — this is
  the link you put on the landing page.
- **Every mutation is blocked server-side** at the permission guard:
  monitors, incidents, status page, settings, membership and AI actions
  all return “Action disabled in live demo.”, which the UI surfaces as
  a toast. The viewer role additionally hides most mutation controls.
- **Sign-up is disabled** and new organizations cannot be created.
- The landing (`/`) and sign-in pages swap their CTAs for
  “Explore the live demo”.

## Seeding

```bash
npm run db:seed        # local
# or inside compose:
docker compose run --rm worker npx tsx scripts/seed-demo.ts
```

Creates the **Altitude Systems** organization: four users (owner /
admin / responder / viewer, password `vigil-demo-2026`), six
production-style monitors with 90 days of history, one resolved
incident with a full timeline + postmortem, one ongoing critical
incident, and a published status page at `/status/altitude`.

The seed is **idempotent** — it wipes and recreates only the demo
organization and demo users, so it doubles as the reset job.

Monitors intentionally point at highly-available public endpoints
(github, cloudflare, mozilla…) so a live worker keeps the demo green;
the “Checkout Service” targets a reserved `.example` domain and stays
red, keeping the ongoing incident honest.

## Nightly reset

Any scheduler that can run one command:

```cron
# 03:00 UTC daily — restore pristine demo data
0 3 * * * cd /srv/vigil && docker compose run --rm worker npx tsx scripts/seed-demo.ts >> /var/log/vigil-demo-reset.log 2>&1
```

(Systemd timer or your platform's cron equivalent works identically —
the seed script forces `DEMO_MODE=false` internally for its own run, so
account creation succeeds even on the demo host.)

## Suggested topology

| Host                  | Env                            | Purpose                                      |
| --------------------- | ------------------------------ | -------------------------------------------- |
| `demo.yourdomain.com` | `DEMO_MODE=true`, own Postgres | public demo, nightly reset                   |
| `yourdomain.com`      | —                              | landing page (`landing/`), links to the demo |

Keep the demo database separate from anything real; it is wiped on
every reset.
