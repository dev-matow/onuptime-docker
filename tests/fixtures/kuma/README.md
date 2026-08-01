# Uptime Kuma import fixture

`kuma-2.4.0.db` is a real Uptime Kuma database. Not a hand-written
SQLite file shaped like one — a database Uptime Kuma itself created,
migrated and wrote every row of.

That distinction is the whole point of the fixture. An importer tested
against a hand-rolled schema proves only that it can read the schema its
author imagined. The failures that matter in a migration are the ones
where Kuma stores something in a shape nobody would have guessed:
`kafkaProducerSaslOptions` as a JSON blob, `accepted_statuscodes_json` as
a JSON array of range strings, booleans as integers, `conditions` as a
nested expression tree, credentials inline in
`database_connection_string`.

## What is pinned

|                   |                                                                           |
| ----------------- | ------------------------------------------------------------------------- |
| Release           | `2.4.0`                                                                   |
| Commit            | `9f3b837c8c7f359ec1acee80b3c0430451986a03`                                |
| Published         | 2026-05-31                                                                |
| Image             | `louislam/uptime-kuma:2.4.0`                                              |
| Image digest      | `sha256:91e963bfda569ba115206e843febb446f473ab525add4e08b2b9e3beffa16985` |
| Schema version    | `database_version = 10`, 50 knex migrations applied                       |
| `monitor` columns | 111                                                                       |

`2.4.0` is the current stable release, not `master`. Its top-level
monitor-type selector holds **31** entries including Group and Manual,
**29** excluding them — a set identical to `2.3.2`'s, verified by
diffing the two tags' `src/pages/EditMonitor.vue`.

Three of the 31 are conditional in Kuma's own UI and appear only on
certain hosts: `system-service` (Linux/Windows, not in a container),
`sip-options` and `tailscale-ping` (not in a container). They are
counted because they are selectable values that Kuma stores in
`monitor.type`, and the fixture contains one of each.

## What is in it

- **31 monitors, one per top-level type.** Every one carries its
  type-specific columns filled with _distinctive_ values — `seedmqttpass`,
  `1.3.6.1.2.1.1.3.0`, `seed-gamedig-token`. Distinctive matters: a
  mapping matrix generated against all-default rows cannot tell a field
  that was carried across from a field that was dropped and re-defaulted.
- **A group** with children attached via `monitor.parent`.
- **A manual monitor** with `manual_status` set.
- **A push monitor** with its `push_token`.
- **3 notification providers** (webhook, SMTP, Telegram) and the
  `monitor_notification` rows joining them to monitors.
- **A status page** with a public group holding three monitors, custom
  CSS, footer text, analytics settings and a non-default refresh
  interval.
- **A tag**, applied to two monitors, one with a value and one without.
- **A recurring maintenance window** with a monitor attached.
- **A Docker host** and an authenticated **proxy**, both referenced by
  monitors.
- **Real heartbeat and stat rows** for two monitors that were actually
  run against reachable and unreachable targets, so the history path has
  genuine UP and DOWN beats rather than fabricated ones.

Monitors are stored inactive. A fixture that probes the real internet is
a fixture that fails in CI — and paused state is itself something the
importer has to carry across, so it costs nothing to be honest about.

## Reproducing it

`seed-kuma.mjs` is the script that produced this file. It talks to a
real Kuma instance over Kuma's own socket.io API — the same events its
frontend sends — so every row is written by Kuma's own model layer.

```sh
docker run -d --name kuma-seed -p 3011:3001 \
  -v "$PWD/kuma-data:/app/data" louislam/uptime-kuma:2.4.0
echo '{"type":"sqlite"}' > kuma-data/db-config.json   # skip the setup wizard
# wait for HTTP 200 on localhost:3011 — do NOT open kuma.db with the
# sqlite CLI while waiting: that creates a zero-page file and Kuma then
# refuses to copy its template over it
npm i socket.io-client@4
node seed-kuma.mjs http://localhost:3011
sqlite3 kuma-data/kuma.db "PRAGMA wal_checkpoint(TRUNCATE);"
cp kuma-data/kuma.db kuma-2.4.0.db
```

## Refreshing it for a new Kuma release

1. Diff the new tag's `src/pages/EditMonitor.vue` type selector against
   the list above. If the set changed, the mapping matrix and every
   public comparison number change with it.
2. Re-run the seed against the new image.
3. Update the pinned facts in this file and in the importer's pinned
   constants — they are asserted, so a stale pin fails a test rather
   than quietly publishing a wrong version number.
