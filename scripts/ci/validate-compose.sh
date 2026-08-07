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
    AUTH_SECRET=validation-only-auth-secret-at-least-32-bytes
    MINIO_ROOT_USER=validation-user
    MINIO_ROOT_PASSWORD=validation-only-object-password
    S3_BUCKET=validation
    GRAFANA_ADMIN_USER=validation
    GRAFANA_ADMIN_PASSWORD=validation-only-grafana-password
  )
  env "${staging_env[@]}" docker compose -f infra/compose.staging.yml config --quiet
else
  echo "Docker Compose unavailable; running structural YAML validation instead." >&2
  python3 scripts/ci/validate-compose.py infra/compose.local.yml infra/compose.staging.yml
fi
