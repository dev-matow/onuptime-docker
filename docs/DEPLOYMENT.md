# Deployment guide

Vigil deploys as **two processes and one database**: the Next.js app,
the worker, and PostgreSQL 18+. Nothing else is required.

## 1. Docker Compose (single host)

The included [docker-compose.yml](../docker-compose.yml) is
production-shaped: Postgres with a persistent volume, a one-shot
`migrate` service, the standalone app image, and the worker image.

```bash
# .env next to docker-compose.yml
BETTER_AUTH_SECRET=<openssl rand -base64 32>
APP_URL=https://vigil.yourdomain.com
POSTGRES_PASSWORD=<strong password>

docker compose up --build -d
```

Put a TLS-terminating reverse proxy in front of port 3000 (Caddy shown;
nginx/Traefik equivalent):

```
vigil.yourdomain.com {
    reverse_proxy localhost:3000
}
```

### Upgrading a running stack

```bash
git pull
docker compose build
docker compose up -d      # migrate runs first, then app/worker restart
```

## 2. Managed platforms

- **App (Next.js)**: Can be deployed to **Vercel** (Serverless) or any container platform (Render, Fly.io, Railway). If deploying to Vercel, simply connect your repository and configure the environment variables.
- **Worker (Background checks)**: Because Vercel is serverless, it does not support long-running processes required for queue polling. You must run the worker process on a container/server platform. **Fly.io** (free tier supports small persistent VMs) or paid background workers on **Render** (starts at $7/mo) or **Railway** are ideal. Configure it to build using `npm ci` and start using `npm run worker` (or target the `worker` stage in the Dockerfile).
- **Database**: Any managed PostgreSQL **18+** database (required for native `uuidv7()`). **Neon.tech** is highly recommended and offers a free tier.
- **Migrations**: Run `npx drizzle-kit migrate` as a pre-deploy or release step, or run it locally pointing to your production database before launching.

### Hybrid Setup Example (Vercel + Neon + Fly.io/Render Worker)

1. **Database:** Set up a database on Neon, copy the connection string.
2. **Frontend (Vercel):** Connect your GitHub repo, set the Framework Preset to Next.js. Add `DATABASE_URL` (Neon), `BETTER_AUTH_SECRET` (generate one), and `APP_URL` (your deployment URL) to the Environment Variables.
3. **Worker:** Create a new background worker/VM on Fly.io (free) or Render (paid). Link the same repository. Add the same `DATABASE_URL`, `BETTER_AUTH_SECRET` and `APP_URL` environment variables (the worker embeds `APP_URL` in incident notification links). Set the Start Command to `npm run worker`.
4. **Communication:** Both processes will securely coordinate through the Neon database using `pg-boss`. No Redis or open network ports between the frontend and worker are needed.

## 3. Bare metal / VM without Docker

```bash
npm ci
npm run build
npm run db:migrate

# standalone output does not include static assets — copy them in once per build:
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public

# process manager of your choice (systemd/pm2):
node .next/standalone/server.js     # app, PORT=3000
npm run worker                      # worker
```

## Environment

See [sample.env.production](../sample.env.production) for the full
annotated template. Required: `DATABASE_URL`, `BETTER_AUTH_SECRET`,
`APP_URL`.

## Operational notes

- **Health**: `GET /api/health` returns 200 when the app can reach
  Postgres and 503 otherwise — point load-balancer/orchestrator probes
  at it (the compose file already does). The worker logs
  `worker started` on boot and exits non-zero on fatal errors — wire it
  into your restart policy.
- **Logs**: both processes emit structured JSON (pino) on stdout. Set
  `LOG_LEVEL=debug` temporarily for check-level detail.
- **Backups**: one `pg_dump` covers everything — see
  [Backups & restore](#backups--restore) below for the procedure.
- **Email**: set `RESEND_API_KEY` (and `EMAIL_FROM`, a Resend-verified
  sender) on both the app and the worker to deliver incident emails via
  Resend; without a key they fall back to structured logs. A future
  SMTP/SES provider is another `EmailTransport` in
  `src/modules/notifications`.
- **Webhooks**: configured per organization under
  _Settings → Notifications_ — no env needed. Receivers verify the
  `X-Vigil-Signature` header (HMAC-SHA-256 of the raw body). See
  ARCHITECTURE.md §8 for the payload and event list.
- **Scaling**: app and worker are independently horizontal; the queue
  serializes per-monitor work. See ARCHITECTURE.md §10 for the pressure
  → response table.

## Backups & restore

All state lives in Postgres: domain data, auth, the audit trail,
status pages and the job queue. The `pgboss` schema is
disposable (it rebuilds on worker start), so a single dump is a complete
backup. The only other thing to keep is your `.env` — **the same
`BETTER_AUTH_SECRET` must survive a restore**, because sessions and
status-page subscription tokens are signed with it; restoring data under
a new secret signs everyone out and invalidates pending
confirm/unsubscribe links.

**Back up** (compose deployment; adjust user/db if you changed them):

```bash
docker compose exec postgres pg_dump -U vigil -Fc vigil > vigil-$(date +%F).dump
```

Run it from cron at whatever cadence your incident history is worth —
daily is typical. Keep dumps off the host that runs Vigil.

**Restore** onto a fresh stack:

```bash
docker compose up -d postgres          # just the database
docker compose exec -T postgres pg_restore -U vigil -d vigil \
  --clean --if-exists --no-owner < vigil-YYYY-MM-DD.dump
docker compose up -d                   # migrate no-ops, app + worker start
```

The migrate service compares the restored journal against the shipped
migrations, so restoring an older dump into a newer checkout applies the
missing migrations automatically.

**Disaster recovery** is those two steps on a new host: copy the source
checkout and your `.env`, restore the latest dump, `docker compose up -d`.
Nothing else holds state — no volumes to move besides Postgres, no local
files the app writes.

## Troubleshooting

Symptom → cause → fix, from real deployments:

- **App container exits immediately, logs show `getaddrinfo` /
  `EAI_AGAIN`** — Next's standalone server binds to `$HOSTNAME`, which
  Docker sets to the container id. The shipped image already pins
  `HOSTNAME=0.0.0.0`; if you run the standalone build outside this image,
  set that yourself.
- **`relation "..." does not exist`** — migrations haven't run. Compose
  runs them via the one-shot `migrate` service; on bare metal run
  `npm run db:migrate` before starting.
- **No emails arrive** — without `RESEND_API_KEY` every email is written
  to the logs instead (grep for `email`); that's the designed fallback,
  not a failure. With a key set: `EMAIL_FROM` must be a Resend-verified
  sender — the default `onboarding@resend.dev` only delivers to the
  Resend account owner.
- **Monitor against an internal host fails instantly** — monitor URLs
  are SSRF-guarded: private and loopback addresses are refused by
  default. `ALLOW_PRIVATE_MONITOR_TARGETS=true` lifts this for dev only.
  hooks are usually internal) — see docs/security.
- **Sign-up disabled / every mutation rejected** — `DEMO_MODE=true` is
  set. That's the read-only public-demo switch (docs/DEMO.md), not a
  broken install.
- **Browser sign-in rejected while `curl` works** — `APP_URL` must equal
  the origin users type into the browser (it's the auth trusted origin).
  A port or scheme mismatch fails exactly this way.
- **Status page shows slightly stale data** — public pages are cached
  for ~60 s so an outage traffic spike never reaches Postgres. That lag
  is by design.
