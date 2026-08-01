#!/usr/bin/env bash
#
# Restores a dump taken by scripts/backup.sh.
#
# Refuses to run against a database that already holds tables.
#
# That refusal is the point of the script. pg_restore's default is to
# create what is missing and log an error for everything that already
# exists, then exit 0 — so restoring a week-old backup over a live
# database leaves the old rows in place, adds nothing, and reports
# success. The operator learns which of the two databases they are
# looking at some time later, from a customer. Failing loudly on a
# non-empty target is worse than nothing exactly once, and better than
# that outcome every other time.
#
# --force is the deliberate version: it drops each object before
# recreating it (--clean --if-exists), which really does replace the
# contents. It is still not a merge. Nothing here can merge two
# databases, and a flag that pretended to would be the same lie again.
#
# Usage: scripts/restore.sh [OPTIONS] DUMP
#
#       --force         restore into a database that already has tables,
#                       dropping what the archive is about to replace
#       --url URL       connection string (default $DATABASE_URL)
#       --docker        run pg_restore inside the compose Postgres service
#       --service NAME  compose service name      (default postgres)
#       --db NAME       database, --docker only   (default vigil)
#       --user NAME     role, --docker only       (default vigil)
#   -j, --jobs N        parallel restore workers  (default 1)
#   -h, --help
#
# The shipped stack, verbatim:
#
#   docker compose exec -T postgres pg_restore -U vigil -d vigil \
#     --no-owner --no-privileges < vigil.dump
#
# Stop the app and the worker first. Both hold connections and the worker
# writes checks continuously; restoring underneath them races the restore
# against new rows for the same monitors.
set -euo pipefail

DUMP=""
URL="${DATABASE_URL:-}"
MODE="direct"
SERVICE="postgres"
DB="vigil"
USER="vigil"
FORCE="no"
JOBS="1"

while [ $# -gt 0 ]; do
  case "$1" in
    --force)
      FORCE="yes"
      shift
      ;;
    --url)
      URL="$2"
      shift 2
      ;;
    --docker)
      MODE="docker"
      shift
      ;;
    --service)
      SERVICE="$2"
      shift 2
      ;;
    --db)
      DB="$2"
      shift 2
      ;;
    --user)
      USER="$2"
      shift 2
      ;;
    -j | --jobs)
      JOBS="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^#\{0,1\} \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "restore: unknown argument: $1" >&2
      exit 2
      ;;
    *)
      DUMP="$1"
      shift
      ;;
  esac
done

if [ -z "$DUMP" ]; then
  echo "restore: no dump given. Usage: scripts/restore.sh [OPTIONS] DUMP" >&2
  exit 2
fi
if [ ! -r "$DUMP" ]; then
  echo "restore: cannot read $DUMP" >&2
  exit 2
fi
if [ "$MODE" = "direct" ] && [ -z "$URL" ]; then
  echo "restore: no database to restore into." >&2
  echo "  Set DATABASE_URL, pass --url, or use --docker for the shipped stack." >&2
  exit 2
fi

# Checked before anything is dropped, not after. A --force run against an
# unreadable archive would otherwise empty the database and then fail.
if ! pg_restore --list "$DUMP" >/dev/null 2>&1; then
  echo "restore: $DUMP is not a custom-format pg_dump archive." >&2
  echo "  scripts/backup.sh writes one; a plain .sql file is replayed with psql." >&2
  exit 1
fi

# Ordinary and partitioned tables in every schema Vigil could have put
# one in. Counting tables rather than asking whether the database exists:
# a freshly created database is empty, and so is one whose tables were
# dropped by hand, and both are safe targets.
COUNT_SQL="select count(*) from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname !~ '^pg_'"

if [ "$MODE" = "docker" ]; then
  EXISTING="$(docker compose exec -T "$SERVICE" \
    psql -U "$USER" -d "$DB" -tAc "$COUNT_SQL")"
else
  EXISTING="$(psql "$URL" -tAc "$COUNT_SQL")"
fi
EXISTING="$(echo "$EXISTING" | tr -d '[:space:]')"

if [ "$EXISTING" != "0" ] && [ "$FORCE" != "yes" ]; then
  echo "restore: the target database already holds $EXISTING tables." >&2
  echo "" >&2
  echo "  Restoring into it would leave every existing row in place and add" >&2
  echo "  nothing — pg_restore reports that as success. Pick an empty" >&2
  echo "  database, or pass --force to drop and replace what the archive" >&2
  echo "  covers. --force is destructive and does not merge." >&2
  exit 1
fi

RESTORE_FLAGS=(--no-owner --no-privileges --jobs "$JOBS")
if [ "$FORCE" = "yes" ] && [ "$EXISTING" != "0" ]; then
  echo "restore: --force — dropping and replacing $EXISTING existing tables"
  RESTORE_FLAGS+=(--clean --if-exists)
fi

# `set -e` would take the exit code as fatal, and pg_restore returns
# non-zero for warnings that are not failures — a --clean run reports
# every object it could not drop because it was not there. The code is
# captured and judged instead.
STATUS=0
if [ "$MODE" = "docker" ]; then
  echo "restore: restoring $DUMP into $DB via compose service '$SERVICE'"
  docker compose exec -T "$SERVICE" \
    pg_restore -U "$USER" -d "$DB" "${RESTORE_FLAGS[@]}" <"$DUMP" || STATUS=$?
else
  echo "restore: restoring $DUMP into ${URL##*@}"
  pg_restore --dbname="$URL" "${RESTORE_FLAGS[@]}" "$DUMP" || STATUS=$?
fi

if [ "$STATUS" -ne 0 ]; then
  echo "" >&2
  echo "restore: pg_restore exited $STATUS. Read the errors above before" >&2
  echo "  treating this database as restored — with --clean, 'does not" >&2
  echo "  exist' lines are expected and harmless; anything else is not." >&2
  exit "$STATUS"
fi

echo "restore: done. Verify before you trust it:"
echo "  npm run db:migrate    # brings the schema up to this build"
echo "  see docs/BACKUP.md for the row-count check"
