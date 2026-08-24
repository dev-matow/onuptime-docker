#!/usr/bin/env bash
#
# Takes a restorable dump of the Vigil database.
#
# Custom format (-Fc), not plain SQL. A .sql file can only be replayed
# whole, into a database that is already empty, in the order it was
# written; a custom-format archive can be listed, restored in parallel,
# and restored selectively when only one table is wrong. It is also the
# only format `scripts/restore.sh` accepts, so the two cannot drift.
#
# Safe against a live system. pg_dump reads inside one repeatable-read
# snapshot and takes ACCESS SHARE locks only: writers keep writing, and
# the dump is a consistent instant rather than a smear across the time it
# took to run. What it does conflict with is DDL — a migration running
# concurrently will block one of the two. Take the backup before the
# upgrade, not during it.
#
# Ownership and grants are deliberately left out (--no-owner
# --no-privileges). The shipped stack connects as `vigil` and a local
# install usually as `postgres`, and a dump that names its roles refuses
# to restore where they do not exist. Vigil has no roles of its own and
# no grants worth carrying, so this costs nothing and makes the archive
# portable between the two shapes an operator actually has. What it means
# is stated plainly in docs/BACKUP.md rather than discovered at 3am.
#
# Usage: scripts/backup.sh [OPTIONS]
#
#   -o, --output PATH   where to write (default ./backups/vigil-<utc>.dump)
#       --url URL       connection string (default $DATABASE_URL)
#       --docker        run pg_dump inside the compose Postgres service
#                       instead, which is where the shipped stack keeps it
#       --service NAME  compose service name      (default postgres)
#       --db NAME       database, --docker only   (default vigil)
#       --user NAME     role, --docker only       (default vigil)
#   -h, --help
#
# The shipped stack, verbatim:
#
#   docker compose exec -T postgres pg_dump -U vigil -d vigil \
#     --format=custom --compress=9 --no-owner --no-privileges > vigil.dump
#
# `-T` is not optional there. Without it Compose allocates a TTY, and the
# archive arrives with CRLF translated into it and pg_restore rejecting it.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OUTPUT=""
URL="${DATABASE_URL:-}"
MODE="direct"
SERVICE="postgres"
DB="vigil"
USER="vigil"

while [ $# -gt 0 ]; do
  case "$1" in
    -o | --output)
      OUTPUT="$2"
      shift 2
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
    -h | --help)
      sed -n '2,43p' "${BASH_SOURCE[0]}" | sed 's/^#\{0,1\} \{0,1\}//'
      exit 0
      ;;
    *)
      echo "backup: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ "$MODE" = "direct" ] && [ -z "$URL" ]; then
  echo "backup: no database to dump." >&2
  echo "  Set DATABASE_URL, pass --url, or use --docker for the shipped stack." >&2
  exit 2
fi

if [ -z "$OUTPUT" ]; then
  OUTPUT="$REPO/backups/vigil-$(date -u +%Y%m%dT%H%M%SZ).dump"
fi
mkdir -p "$(dirname "$OUTPUT")"

# The default lands inside the repository, and a dump holds password
# hashes, live session tokens and every subscriber's address. The
# repository's .gitignore does not cover it — so the directory excludes
# itself, here, where the choice of default was made. An operator who
# passes -o somewhere else never sees this.
if [ "$(dirname "$OUTPUT")" = "$REPO/backups" ] && [ ! -e "$REPO/backups/.gitignore" ]; then
  printf '*\n' >"$REPO/backups/.gitignore"
fi

# Written to a temporary name and moved into place at the end. A dump
# interrupted halfway is still a file of plausible size with a plausible
# name, and the next person to need it will not find out until they need
# it — so it never gets that name.
PARTIAL="$OUTPUT.partial"
trap 'rm -f "$PARTIAL"' EXIT

DUMP_FLAGS=(--format=custom --compress=9 --no-owner --no-privileges)

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

if [ "$MODE" = "docker" ]; then
  echo "backup: dumping $DB from compose service '$SERVICE'"
  docker compose exec -T "$SERVICE" \
    pg_dump -U "$USER" -d "$DB" "${DUMP_FLAGS[@]}" >"$PARTIAL"
else
  # Host and database only — a connection string carries a password.
  echo "backup: dumping ${URL##*@}"
  pg_dump "$URL" "${DUMP_FLAGS[@]}" --file="$PARTIAL"
fi

# A truncated archive is the failure this catches: pg_dump can exit 0
# having written a partial stream when the redirect above was cut short.
# `pg_restore --list` parses the archive's table of contents, which is the
# cheapest proof that what was written can be read back.
# The reason is kept, not swallowed. "not readable" with nothing after it
# sent one investigation looking for a truncated file when the real
# answer was a version mismatch, and pg_restore had said so.
if ! LIST_ERROR="$(list_archive "$PARTIAL" 2>&1 >/dev/null)"; then
  echo "backup: the archive pg_dump produced is not readable — nothing kept." >&2
  [ -z "$LIST_ERROR" ] || printf '  %s
' "$LIST_ERROR" >&2
  exit 1
fi

# Readable is not the same as useful, and this is the difference. An
# archive of a database with no tables parses perfectly — it is what you
# get from a database name with a typo in it, or from one the migrations
# never ran against. Kept, because an empty database is occasionally the
# honest answer, and said out loud, because usually it is not.
ENTRIES="$(list_archive "$PARTIAL" | grep -c '^[0-9]' || true)"
if [ "$ENTRIES" -eq 0 ]; then
  echo "backup: WARNING — the database held nothing to dump." >&2
  echo "  Check that the name is the one Vigil migrates into." >&2
fi

mv "$PARTIAL" "$OUTPUT"
trap - EXIT

echo "backup: wrote $OUTPUT ($(du -h "$OUTPUT" | cut -f1), $ENTRIES archive entries)"
echo "backup: restore it with  scripts/restore.sh $OUTPUT"
