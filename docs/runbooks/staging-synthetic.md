# Runbook: staging sintético

Staging valida la aplicación integrada sin convertirse en producción ni alojar datos personales reales.

## Preparación

1. Crear `infra/env/staging.env` desde el ejemplo, generar valores aleatorios y conservarlo fuera de Git. Incluye `SNAPSHOT_SIGNING_KEY_B64` (`openssl genpkey -algorithm ed25519 | base64 -w0`): sin ella los snapshots críticos no sobreviven reinicios ni réplicas.
2. Usar un `RELEASE_TAG` inmutable asociado al commit, no `latest`.
3. Confirmar que `ALLOW_SYNTHETIC_DATA_ONLY=true` y que todos los nombres/correos/adjuntos de seed son ficticios. En staging la contraseña demo queda deshabilitada (`ENABLE_DEMO_PASSWORD_AUTH` ausente): el acceso es por magic link, entregado en Mailpit.
4. Validar configuración antes de construir:

```bash
docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml config --quiet
```

## Despliegue

```bash
docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml \
  up -d postgres minio mailpit clamav

docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml \
  run --rm web pnpm db:migrate

docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml \
  up --build -d --wait
```

Para sembrar cuentas sintéticas con contraseña (solo si el entorno lo permite explícitamente con `ENABLE_DEMO_PASSWORD_AUTH=true` y las variables `DEMO_*`; en staging normal, no):

```bash
docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml \
  run --rm -e SEED_DATABASE_URL="postgresql://…propietario-de-migraciones…" \
  web pnpm --filter @casa-clara/web seed:demo
```

Después, ejecutar smoke de los cinco roles, matriz RLS, una escritura offline, PDF, adjunto en cuarentena y modo avión. Mailpit debe contener únicamente identidades `.demo` o equivalentes sintéticas.

## Observabilidad y backup

```bash
docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml \
  --profile observability up -d --wait

docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml \
  --profile backup run --rm db-backup
```

Las métricas no contienen IDs ni texto de producto. El backup se restaura siguiendo el drill antes de cerrar una fase.

## Rollback

- Revertir web/worker fijando el `RELEASE_TAG` anterior y recreando esos servicios.
- Las migraciones siguen expand/migrate/contract; no se revierte destructivamente una DB compartida. Aplicar una migración correctiva.
- Si una release cambia service worker o IndexedDB, probar explícitamente actualización desde la release anterior y preservar outbox pendiente.
- Un rollback no autoriza saltarse RLS, checksum o evidencia de aceptación.
