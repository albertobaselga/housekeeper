# Runbook: backup, verificación y restauración

Este procedimiento cubre los Compose **local** y **staging sintético**. No es un diseño de backup de producción. Un backup no cuenta hasta que se restaura y valida.

## Crear el backup

Elegir un único fichero Compose y reutilizarlo en todos los comandos de la sesión:

```bash
docker compose -f infra/compose.local.yml --profile backup run --rm db-backup
docker compose -f infra/compose.local.yml --profile backup run --rm object-backup
```

Para staging, añadir `--env-file infra/env/staging.env` y sustituir el fichero por `infra/compose.staging.yml`. Los jobs:

- escriben primero un nombre `.partial`;
- verifican que `pg_restore` puede leer el dump o generan un manifest SHA-256;
- publican el resultado mediante renombrado atómico;
- no incluyen secretos en el nombre ni en la salida.

El volumen `backup_data` está en el mismo host: sirve para drills, no protege contra pérdida del host. Antes de producción hará falta copia cifrada externa, política de retención y objetivos RPO/RTO aprobados.

## Drill de base de datos

Nunca restaurar sobre la base activa. Crear una base aislada con nombre exacto:

```bash
docker compose -f infra/compose.local.yml exec -T postgres \
  sh -eu -c 'dropdb --if-exists -U "$POSTGRES_USER" casaclara_restore_verify && createdb -U "$POSTGRES_USER" casaclara_restore_verify'
```

Verificar checksum y restaurar el dump más reciente desde el volumen de backup:

```bash
docker compose -f infra/compose.local.yml --profile backup run --rm \
  -e PGDATABASE=casaclara_restore_verify \
  --entrypoint /bin/sh db-backup -eu -c '
    restore_archive="$(find /backups/postgres -maxdepth 1 -type f -name "*.dump" | sort | tail -n 1)"
    test -n "$restore_archive"
    sha256sum -c "${restore_archive}.sha256"
    pg_restore --exit-on-error --no-owner --no-acl --dbname="$PGDATABASE" "$restore_archive"
  '
```

Ejecutar migraciones y la batería DB/RLS contra `casaclara_restore_verify`. Comparar, como mínimo, recuentos de hogares, membresías, asientos, liquidaciones cerradas, pagos, auditoría y objetos referenciados. La prueba falla ante referencias a adjuntos inexistentes.

Cuando la evidencia esté guardada, eliminar solo la base de verificación explícita:

```bash
docker compose -f infra/compose.local.yml exec -T postgres \
  sh -eu -c 'dropdb --if-exists -U "$POSTGRES_USER" casaclara_restore_verify'
```

El destino permanece como literal deliberadamente; no sustituirlo por una variable no comprobada.

## Drill de objetos

Restaurar siempre a un bucket nuevo `casaclara-restore-verify`, nunca al bucket fuente. El job `object-backup` monta los snapshots bajo `/backups/objects/<bucket>/<timestamp>`.

1. Validar `SHA256SUMS` desde dentro del snapshot.
2. Crear el bucket de verificación como privado.
3. Ejecutar `mc mirror` hacia el bucket nuevo.
4. Comparar número, tamaño y hash de objetos; comprobar además que la aplicación no publica objetos en cuarentena.
5. Eliminar el bucket de verificación solo después de conservar el acta del drill.

## Evidencia y frecuencia

- Ejecutar un drill al cerrar cada fase y, cuando exista operación real, al menos mensualmente.
- Registrar commit, imagen, timestamp, tamaño, hash, duración, resultado DB/RLS y responsable.
- Fallo de checksum, dump ilegible, objeto ausente o RLS distinta después de restaurar es P1 y bloquea despliegues.
- Nunca adjuntar dumps, nombres personales, tokens ni logs con PII a GitHub Actions.
