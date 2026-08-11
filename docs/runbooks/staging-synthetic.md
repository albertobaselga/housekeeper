# Runbook: staging sintético

Staging valida la aplicación integrada sin convertirse en producción ni alojar datos personales reales.

## Preparación

1. Crear `infra/env/staging.env` desde el ejemplo, generar valores aleatorios y conservarlo fuera de Git. Incluye `SNAPSHOT_SIGNING_KEY_B64` (`openssl genpkey -algorithm ed25519 | base64 -w0`): sin ella los snapshots críticos no sobreviven reinicios ni réplicas.
2. Usar un `RELEASE_TAG` inmutable asociado al commit, no `latest`.
3. Confirmar que `ALLOW_SYNTHETIC_DATA_ONLY=true` y que todos los nombres/correos/adjuntos de seed son ficticios. El acceso es por usuario y contraseña; en staging las cuentas son sintéticas y se dan de alta con el guion del paso siguiente. No hay correo en ninguna parte: la migración 0029 retiró la salida SMTP y con ella el Mailpit de los entornos.
4. Validar configuración antes de construir:

```bash
docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml config --quiet
```

## Despliegue

```bash
docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml \
  up -d postgres minio clamav

docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml \
  run --rm web pnpm db:migrate

docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml \
  up --build -d --wait
```

Para dar de alta las cuentas sintéticas de staging, con un JSON de personas ficticias guardado **fuera del repositorio** (formato en [docs/despliegue/acceso-produccion.md](../despliegue/acceso-produccion.md)):

```bash
docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml \
  run --rm -e SEED_DATABASE_URL="postgresql://…propietario-de-migraciones…" \
  -v /ruta/fuera/del/repo/staging-sintetico.json:/tmp/hogar.json:ro \
  web pnpm --filter @casa-clara/web seed:accounts --config /tmp/hogar.json
```

El guion imprime las contraseñas generadas una sola vez. En staging pueden anotarse en el registro de la prueba; en producción no salen de la conversación en persona.

Después, ejecutar smoke de los cinco roles, matriz RLS, una escritura offline, PDF, adjunto en cuarentena y modo avión.

## Retención de datos de descubrimiento

La poda de `app.wiki_page_reads` y `app.search_gap_events` la ejecuta el worker
con el job `maintenance.prune_discovery` (función `app_private.prune_discovery_data`
de la migración 0012; mínimo duro de 30 días, por defecto 45 días de lecturas y
180 de huecos de búsqueda). El worker la auto-encola al arrancar si no hay
ninguna pendiente y se re-encola sola cada 7 días al completar.

Único caso que requiere intervención: una base recién sembrada cuya
`app_private.job_queue` está completamente vacía. Como `household_id` es NOT
NULL y el worker no puede leer `app.households` (a propósito), no tiene ningún
hogar que tomar prestado y se abstiene. En ese caso el operador encola la
primera poda con el rol propietario de migraciones:

```sql
INSERT INTO app_private.job_queue (household_id, job_type, payload, run_at)
SELECT id, 'maintenance.prune_discovery',
       '{"readsKeepDays": 45, "gapsKeepDays": 180}', now()
  FROM app.households
 ORDER BY created_at
 LIMIT 1;
```

A partir de ahí el ciclo semanal se mantiene solo (y cualquier reinicio del
worker lo re-encola si se perdiera, porque la cola ya nunca está vacía).

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
