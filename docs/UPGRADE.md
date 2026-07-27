# Upgrading Vigil Core

Vigil Core is generated from the commercial edition's tree, so its
upgrades are ordinary: pull, install, migrate, restart.

```bash
git pull
npm ci
npm run db:migrate
# restart both processes (app and worker)
```

Migrations are ordered SQL and always additive within a major version.
Take a backup first anyway — `pg_dump -Fc` costs seconds and the one
time you need it is the one time you skipped it.

## 1.0.x → 1.11.0 has no in-place path

**Read this if you installed Core before 28 July 2026.**

Core 1.0.x shipped a single squashed `drizzle/0000_initial.sql` that was
written by hand and shares no lineage with the migrations Core carries
now. There is no migration from one to the other, and running
`db:migrate` against a 1.0.x database will fail rather than corrupt it.

That is a real cost and it is ours, not yours: 1.0.x was published on 25
July 2026 and replaced three days later, so the affected installs are
days old by construction. The path is:

```bash
pg_dump -Fc "$DATABASE_URL" > vigil-1.0.x-backup.dump   # keep this
createdb vigil_new                                       # a fresh database
DATABASE_URL=postgresql://…/vigil_new npm run db:migrate
```

Then recreate your monitors and status page in the new install. Your
check history does not come across; ninety days of it did not exist yet
on an install that old.

**This will not happen again.** Both editions are cut from the same
commit now and share one migration lineage, which is the whole reason
1.11.0 exists. From here an upgrade is `git pull && npm run db:migrate`.

## Rolling back

A release you have already migrated cannot be rolled back by checking
out the old tag — the schema has moved. Restore the dump you took:

```bash
pg_restore --clean --if-exists -d "$DATABASE_URL" vigil-1.0.x-backup.dump
```

Keep `BETTER_AUTH_SECRET` identical across a restore. Sessions and
status-page subscription tokens are signed with it, so changing it logs
everybody out and invalidates every unsubscribe link you have mailed.

## What a version number tells you

Core and the commercial edition always carry the same version, because
they are cut from the same commit. If Core's version ever trails, the
pipeline that produces it is broken — that is a bug worth reporting, and
it is visible from outside without trusting anybody's word for it.
