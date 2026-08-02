# Quick start

Goal: a fully working Vigil (app, worker, database, demo data) in under
10 minutes.

## Option A. Docker (recommended, ~5 minutes)

Requirements: Docker with Compose.

```bash
# 1. Configure the one required secret
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env

# 2. Boot everything: Postgres 18 → migrations → app → worker
docker compose up --build -d

# 3. (Optional) seed the demo organization with 90 days of history
docker compose run --rm worker npx tsx scripts/seed-demo.ts
```

Open **http://localhost:3000**.

- Seeded? Sign in as `amelia@altitude.demo` / `vigil-demo-2026`
  (owner, see the seed output for admin/responder/viewer accounts),
  and visit the public page at `/status/altitude`.
- Not seeded? Click **Get started**, create your account and
  organization, add a monitor. The worker runs its first check within
  a minute.

## Option B. Local development (~10 minutes)

Requirements: Node.js ≥ 20.9, PostgreSQL ≥ 18 (native `uuidv7()` is used).

```bash
npm install
cp .env.example .env        # set DATABASE_URL + BETTER_AUTH_SECRET
npm run db:migrate
npm run db:seed             # optional demo data
npm run dev                 # terminal 1, app on :3000
npm run worker:dev          # terminal 2, background checks
```

## Verify the install

```bash
npm run typecheck && npm run lint && npm test   # 2752 tests, ~5s
```

## Turn on automatic recovery (optional, ~5 minutes)

Open any monitor → **Automatic recovery**: point it at an endpoint in
your infrastructure that fixes the failure (a restart hook, a runbook
trigger) and enable it. `examples/recovery-receiver.mjs` is a
dependency-free receiver to start from. It verifies the signature, then
runs one command. Use **Send test trigger** to prove the wiring before
the first real incident.

## Check from more than one place (optional, ~5 minutes)

A monitor going down means _your_ Vigil host could not reach it. To
require several machines to agree first, assign the monitor to probe
agents you run. Watch a quorum decide on this machine before deploying
one anywhere:

```bash
npm run demo:probes    # mints three labelled probes, a monitor and a policy
# paste the three tokens into .env, then
docker compose -f docker-compose.yml -f docker-compose.probes.yml up -d
npx tsx scripts/probe-demo.ts watch
```

Stop the target and one incident opens, not three. Disconnect one probe
and the monitor goes degraded with the dissenter named. Stop two and the
verdict is `insufficient quorum`, which pages nobody.

Three agents on one host share a kernel and a route, so this proves the
machinery and nothing about reachability. Remote rounds need an interval
of 20 seconds or more. Full setup, rotation and troubleshooting:
[docs/REMOTE-PROBES.md](docs/REMOTE-PROBES.md).

## Where to go next

| You want to…                | Read                                           |
| --------------------------- | ---------------------------------------------- |
| Deploy to production        | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)       |
| Rebrand / extend it         | [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md) |
| Run a public read-only demo | [docs/DEMO.md](docs/DEMO.md)                   |
| Understand the design       | [ARCHITECTURE.md](ARCHITECTURE.md)             |
| Day-to-day development      | [docs/HANDBOOK.md](docs/HANDBOOK.md)           |
| Take updates later          | [docs/UPGRADE.md](docs/UPGRADE.md)             |
| Check from several machines | [docs/REMOTE-PROBES.md](docs/REMOTE-PROBES.md) |
