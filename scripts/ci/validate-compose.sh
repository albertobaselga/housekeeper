#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose -f infra/compose.local.yml config --quiet

  staging_env=(
    RELEASE_TAG=validation
    POSTGRES_USER=validation
    POSTGRES_PASSWORD=validation-only-password
    POSTGRES_DB=validation
    APP_DB_PASSWORD=validation-only-app-password
    WORKER_DB_PASSWORD=validation-only-worker-password
    AUTH_DB_PASSWORD=validation-only-auth-password
    BETTER_AUTH_SECRET=validation-only-auth-secret-at-least-32-bytes
    SNAPSHOT_SIGNING_KEY_B64=dmFsaWRhdGlvbi1vbmx5
    MINIO_ROOT_USER=validation-user
    MINIO_ROOT_PASSWORD=validation-only-object-password
    S3_BUCKET=validation
    'SMTP_FROM=Housekeeper validation <no-reply@housekeeper.test>'
    GRAFANA_ADMIN_USER=validation
    GRAFANA_ADMIN_PASSWORD=validation-only-grafana-password
  )
  env "${staging_env[@]}" docker compose -f infra/compose.staging.yml config --quiet

  # Host del worker (Vercel + Supabase): sin postgres ni minio, con Supabase al
  # otro lado. Las variables son de validación, no de ningún entorno real.
  worker_env=(
    RELEASE_TAG=validation
    WORKER_DATABASE_URL=postgresql://validation@127.0.0.1:5432/validation
    S3_ENDPOINT=https://validation.supabase.co/storage/v1/s3
    S3_REGION=eu-central-1
    S3_PRIVATE_BUCKET=validation
    S3_ACCESS_KEY_ID=validation
    S3_SECRET_ACCESS_KEY=validation-only-object-password
    SMTP_HOST=smtp.validation.test
    'SMTP_FROM=Housekeeper validation <no-reply@housekeeper.test>'
    CLAMAV_GATEWAY_TOKEN=validation-only-clamav-token
    CLAMAV_TLS_DIR=/tmp/housekeeper-validation-tls
  )
  env "${worker_env[@]}" docker compose -f infra/compose.worker.yml config --quiet
else
  echo "Docker Compose unavailable; running structural YAML validation instead." >&2
  python3 scripts/ci/validate-compose.py \
    infra/compose.local.yml infra/compose.staging.yml infra/compose.worker.yml
fi
