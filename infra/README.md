# Infraestructura local y staging sintético

Esta carpeta define dos entornos sin datos reales ni secretos versionados. No es una receta de producción.

## Contrato de servicios

| Servicio | Imagen/artefacto | Healthcheck |
|---|---|---|
| Caddy | `caddy:2.11.2-alpine` | `/healthz` |
| PostgreSQL | `postgres:18.4-alpine` con checksums | `pg_isready` |
| Web | build de `@casa-clara/web`, puerto 3000 | `WEB_HEALTH_PATH` (por defecto `/api/health`) |
| Worker | build de `@casa-clara/worker`, puerto 3001 | `/health` |
| MinIO | release fechada, bucket privado | `/minio/health/live` |
| ClamAV | `1.4.5` | ping de `clamd` |

Aquí había un Mailpit para ver los correos del worker. La aplicación no manda
correo a nadie (migración 0029): no hay remitente que configurar, ni servidor
SMTP que levantar, ni bandeja local que mirar. El canal es la aplicación.

Los filtros de workspace se pueden cambiar con `WEB_WORKSPACE_FILTER` y `WORKER_WORKSPACE_FILTER`. Los contenedores de aplicación se ejecutan sin root, con filesystem de solo lectura, sin capabilities y con `no-new-privileges`.

## Local

Los valores por defecto son identificadores sintéticos y no deben reutilizarse fuera de la máquina de desarrollo.

```bash
docker compose -f infra/compose.local.yml config --quiet
docker compose -f infra/compose.local.yml up --build --wait
```

La aplicación queda en `http://localhost:8080` y MinIO en `http://localhost:9001`.

Para habilitar métricas locales:

```bash
docker compose -f infra/compose.local.yml --profile observability up -d --wait
```

Prometheus queda ligado a `127.0.0.1:9090` y Grafana a `127.0.0.1:3002`. Grafana no envía analítica y solo recibe métricas técnicas sin PII.

## Staging sintético

```bash
cp infra/env/staging.env.example infra/env/staging.env
# Sustituir todos los valores marcados; el fichero está ignorado por infra/.gitignore.
docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml config --quiet
docker compose --env-file infra/env/staging.env -f infra/compose.staging.yml up --build --wait
```

Añadir `127.0.0.1 staging.casaclara.test` al hosts local. Caddy usa una CA interna para este entorno; no se debe instalar su raíz como confianza global fuera del equipo de pruebas. Staging establece `ALLOW_SYNTHETIC_DATA_ONLY=true`; importar datos reales constituye un incidente.

## Backups bajo demanda

Los servicios del perfil `backup` son jobs de una sola ejecución, por lo que no tienen healthcheck persistente. Cada job valida el resultado antes de publicarlo en el volumen `backup_data`.

```bash
docker compose -f infra/compose.local.yml --profile backup run --rm db-backup
docker compose -f infra/compose.local.yml --profile backup run --rm object-backup
```

El volumen local no es una copia externa. El procedimiento completo de verificación y restauración está en `docs/runbooks/backup-restore.md`.
