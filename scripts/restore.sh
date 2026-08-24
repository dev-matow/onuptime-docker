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

# Read back by the binary that wrote it, never by whatever the host
# happens to have.
#
# In --docker mode the archive comes out of the pg_dump inside the
# container, and only a pg_restore of at least that version can parse it.
# The host client is frequently OLDER than the server in the image: an
# Ubuntu runner ships PostgreSQL 16 and this stack runs 18, and asking
# the 16 to read an 18 archive reported a perfectly good backup as
# unreadable and deleted it. The supported single-host install has no
# client at all, which is the other half of the same answer.
#
# pg_restore with no filename reads standard input, and a custom-format
# archive on a non-seekable stream is a case it handles.
list_archive() {
  if [ "$MODE" = "docker" ]; then
    docker compose exec -T "$SERVICE" pg_restore --list <"$1"
  else
    pg_restore --list "$1"
  fi
}

# Checked before anything is dropped, not after. A --force run against an
# unreadable archive would otherwise empty the database and then fail.
if ! list_archive "$DUMP" >/dev/null 2>&1; then
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
# non-zero for errors it IGNORED rather than for a restore that failed.
# So the code is captured and the errors themselves are judged, which is
# what the paragraph that used to be here claimed and the code did not
# do.
STATUS=0
RESTORE_LOG="$(mktemp -t vigil-restore-log.XXXXXX)"
trap 'rm -f "$RESTORE_LOG"' EXIT
if [ "$MODE" = "docker" ]; then
  echo "restore: restoring $DUMP into $DB via compose service '$SERVICE'"
  docker compose exec -T "$SERVICE" \
    pg_restore -U "$USER" -d "$DB" "${RESTORE_FLAGS[@]}" <"$DUMP" 2>&1 |
    tee "$RESTORE_LOG" || STATUS=$?
else
  echo "restore: restoring $DUMP into ${URL##*@}"
  pg_restore --dbname="$URL" "${RESTORE_FLAGS[@]}" "$DUMP" 2>&1 |
    tee "$RESTORE_LOG" || STATUS=$?
fi

# ── which errors were they ───────────────────────────────────────────
#
# A --clean pass issues a DROP for every object in the archive before
# recreating it, and on any Vigil database three of those DROPs fail as
# a matter of course:
#
#   pg_restore: error: could not execute query: ERROR:  cannot drop
#   inherited constraint "job_common_pkey" of relation "job_common"
#
# pg-boss partitions `job` and `queue_stats`; a partition's constraint
# cannot be dropped on the partition, and dropping the parent takes it
# with it regardless. pg_restore ignores them, prints "errors ignored on
# restore: 3" and exits 1 — so a --force restore of a real Vigil dump
# always reported failure while having restored everything correctly.
# `does not exist` is the other benign one, from an object the archive
# names and the target never had.
#
# Anything else still fails. The rule reads the error text rather than
# counting errors, because a count would have to be maintained against a
# schema that grows a partition a day.
UNEXPECTED=""
if [ "$STATUS" -ne 0 ]; then
  UNEXPECTED="$(grep '^pg_restore: error:' "$RESTORE_LOG" |
    grep -v -e 'does not exist' -e 'cannot drop inherited constraint' || true)"
fi

if [ -n "$UNEXPECTED" ]; then
  echo "" >&2
  echo "restore: pg_restore exited $STATUS with errors that a --clean pass" >&2
  echo "  does not produce by itself. Read them before treating this" >&2
  echo "  database as restored:" >&2
  printf '  %s\n' "$UNEXPECTED" >&2
  exit "$STATUS"
fi

if [ "$STATUS" -ne 0 ]; then
  echo "restore: pg_restore exited $STATUS, and every error it reported is one"
  echo "  a --clean pass produces against partitioned tables. Those objects"
  echo "  were dropped with their parents and recreated from the archive."
fi

echo "restore: done. Verify before you trust it:"
echo "  npm run db:migrate    # brings the schema up to this build"
echo "  see docs/BACKUP.md for the row-count check"
