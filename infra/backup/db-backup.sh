#!/bin/sh
set -eu

umask 077
: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"

retention_days="${BACKUP_RETENTION_DAYS:-14}"
case "${retention_days}" in
  ''|*[!0-9]*)
    echo "BACKUP_RETENTION_DAYS must be a non-negative integer" >&2
    exit 64
    ;;
esac

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="/backups/postgres/${PGDATABASE}-${timestamp}.dump"
temporary="${target}.partial"
mkdir -p /backups/postgres
trap 'rm -f "${temporary}"' EXIT HUP INT TERM

pg_dump \
  --format=custom \
  --compress=zstd:9 \
  --no-owner \
  --no-acl \
  --file="${temporary}" \
  "${PGDATABASE}"

pg_restore --list "${temporary}" >/dev/null
mv "${temporary}" "${target}"
sha256sum "${target}" >"${target}.sha256"
trap - EXIT HUP INT TERM

find /backups/postgres -type f \
  \( -name '*.dump' -o -name '*.dump.sha256' \) \
  -mtime "+${retention_days}" -delete

echo "Database backup verified: ${target}"
