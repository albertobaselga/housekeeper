#!/bin/sh
set -eu

umask 077
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="/backups/objects/${S3_BUCKET}/${timestamp}"
temporary="${target}.partial"
mkdir -p "${temporary}"
trap 'rm -rf "${temporary}"' EXIT HUP INT TERM

mc alias set source http://minio:9000 "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null
mc mirror --overwrite "source/${S3_BUCKET}" "${temporary}"

(
  cd "${temporary}"
  find . -type f -print0 \
    | sort -z \
    | xargs -0 -r sha256sum >SHA256SUMS
)

mv "${temporary}" "${target}"
trap - EXIT HUP INT TERM
echo "Object backup verified: ${target}"
