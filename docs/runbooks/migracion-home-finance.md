# Runbook: migración de home-finance a casa-clara (módulo Finanzas)

Migración ÚNICA de `/home/abf/github/home-finance/backend/data/finanzas.db`
(SQLite) al módulo Finanzas de casa-clara. Guion:
`packages/db/scripts/migrar-home-finance.mjs`. El guion lee la SQLite en solo
lectura, escribe por conexión directa (5432) con rol propietario en UNA sola
transacción, y aborta si el hogar destino ya tiene datos de finanzas. Toda
ejecución imprime y guarda un informe de verificación —también las que abortan,
con una sección `## Aborto` y el motivo—; sin `Resultado: OK` no hay migración
válida. La retirada del sistema antiguo es de la fase 7 y NO se ejecuta desde
este runbook.

**Contrato de invocación (cópialo tal cual; no hay atajos):**

```
node packages/db/scripts/migrar-home-finance.mjs \
  --sqlite <ruta al .db> --database-url <postgresql://…> --household <slug> \
  [--backup-dir <dir, por omisión ~/copias-home-finance>] \
  [--dry-run | --verify-only] [--force-empty-check]
```

`--sqlite`, `--database-url` y `--household` son OBLIGATORIOS y el guion **no
lee `DATABASE_URL` del entorno**: `DATABASE_URL=… node …migrar-home-finance.mjs
--household x` sale con código 2 («Falta --sqlite»). Códigos de salida: 0
verificación OK, 1 fallo o aborto, 2 error de uso.

Prefijo obligatorio de toda sesión:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper
```

## Paso 0 — copia de seguridad datada, SIEMPRE, antes de nada

Fuera de AMBOS repos (el guion se niega a escribir dentro de un repo git):

```bash
mkdir -p ~/copias-home-finance
cp /home/abf/github/home-finance/backend/data/finanzas.db \
   ~/copias-home-finance/finanzas-$(date +%Y-%m-%dT%H-%M-%S).db
sha256sum /home/abf/github/home-finance/backend/data/finanzas.db ~/copias-home-finance/finanzas-*.db
```

Los dos sha256 de la copia recién creada y el original deben coincidir. El
guion repite esta copia por sí mismo en cada ejecución que escribe; este paso
manual existe para que haya copia aunque el guion nunca llegue a arrancar.

Comprobación opcional del origen (solo lectura; la spec documenta 1.111
transacciones de enero–junio de 2026, el número real puede haber crecido):

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[1],{readOnly:true});
console.log(db.prepare('SELECT count(*) AS n FROM transactions').get());
db.close();" ~/copias-home-finance/finanzas-<fecha>.db
```

## Ensayo local (obligatorio antes de producción)

Todo el ensayo se hace DESDE LA COPIA, nunca desde el fichero vivo. Para
ensayar sin datos reales, fabrica una base sintética equivalente:

```bash
node packages/db/scripts/home-finance-sintetica.mjs ~/copias-home-finance/finanzas-sintetica.db
```

1. Base de ensayo LIMPIA (recreada de cero en el clúster compartido; no toques
   `casaclara_dev`, `casaclara_etl` ni ninguna otra base con `_it`/`_rt`: son de
   otras suites):

```bash
docker exec casaclara-it-pg dropdb -U ci_admin --if-exists casaclara_ensayo
docker exec casaclara-it-pg createdb -U ci_admin casaclara_ensayo
export DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_ensayo"
```

2. Esquema completo (todas las migraciones pendientes en orden; hoy llega
   hasta la 0037_finance_endurecimiento — los roles de grupo los crea la
   0001):

```bash
pnpm --filter @housekeeper/db migrate
```

3. Hogar del ensayo (o sigue `docs/despliegue/alta-de-hogar.md` si vas a hacer
   el smoke de la web con cuentas de verdad):

```bash
docker exec -i casaclara-it-pg psql -U ci_admin -d casaclara_ensayo -c \
  "SET row_security = off;
   INSERT INTO app.households (slug, display_name) VALUES ('hogar-ensayo', 'Hogar del ensayo');"
```

4. ETL en seco, luego real, luego verificación. **Ejecuta con `node` directo,
   no con `pnpm --filter @housekeeper/db migrar:home-finance -- …`**: con
   pnpm 10.17.1 (el fijado en `packageManager`) ese `--` no se descarta, se
   reenvía tal cual al guion, que lo rechaza como argumento desconocido y sale
   con código 2 antes de tocar nada — comprobado al ensayar este runbook.
   Ejecuta siempre desde la raíz del repo:

```bash
node packages/db/scripts/migrar-home-finance.mjs \
  --sqlite ~/copias-home-finance/finanzas-sintetica.db \
  --database-url "$DATABASE_URL" --household hogar-ensayo --dry-run
node packages/db/scripts/migrar-home-finance.mjs \
  --sqlite ~/copias-home-finance/finanzas-sintetica.db \
  --database-url "$DATABASE_URL" --household hogar-ensayo
node packages/db/scripts/migrar-home-finance.mjs \
  --sqlite ~/copias-home-finance/finanzas-sintetica.db \
  --database-url "$DATABASE_URL" --household hogar-ensayo --verify-only
```

Las tres ejecuciones deben terminar en `Resultado: OK` (códigos de salida 0).
El `--dry-run` migra dentro de una transacción y hace `ROLLBACK` al final (no
se salta ningún paso), así que el hogar sigue vacío para la ejecución real que
va después. El informe queda en
`~/copias-home-finance/informe-migracion-<fecha>.md`. Conserva el del ensayo
real: es el contraste del smoke.

5. Smoke de la UI (cuando existan las pantallas de las fases 4–6): montar la
   web contra este `DATABASE_URL` según
   `.claude/skills/operar-la-casa/referencia-instalacion.md`, conceder
   Finanzas al admin del ensayo desde Ajustes del hogar, y recorrer las 7
   pantallas contrastando los números con el informe.

6. Limpieza: se borra **la base del ensayo**, nunca el contenedor.
   `casaclara-it-pg` es el clúster compartido de pruebas de esta máquina (lo
   usan `test:db`, `test:rls`, `test:import` y los dbe2e): un `docker rm -f`
   ahí se llevaría por delante trabajo ajeno.

```bash
docker exec casaclara-it-pg dropdb -U ci_admin --if-exists casaclara_ensayo
```

Para ensayar con los datos reales: repite 1–6 con
`--sqlite ~/copias-home-finance/finanzas-<fecha>.db` (la copia del Paso 0) y
contrasta además con `backend/data/informe-semestre1-2026.md` del repo viejo.

## Producción (Supabase) — SOLO con confirmación explícita de Alberto

**No ejecutes nada de esta sección sin esa confirmación, dada para esta
migración concreta.** Es un paso de la fase 7 y este runbook NO la ejecuta; el
ensayo local completo (con datos reales) tiene que haber terminado en
`Resultado: OK` antes.

1. Paso 0 de nuevo (copia datada del día).
2. Copia de seguridad de casa-clara ANTES de tocar nada en producción:
   `BACKUP_DATABASE_URL=<conexión directa 5432 del propietario> pnpm backup:full`
   (ver `docs/runbooks/backup-restore.md`).
3. `pnpm db:migrate` contra Supabase con la conexión DIRECTA 5432 del
   propietario y `sslmode=verify-full` explícito (ver
   `docs/despliegue/supabase-esquema.md` y `docs/despliegue/runbook-despliegue.md`;
   nunca por el pooler, porque el runner toma `pg_advisory_lock` de sesión).
4. ETL con `--dry-run` contra producción, con esa misma conexión directa;
   revisar el informe completo.
5. ETL real; el informe debe decir `Resultado: OK`; después `--verify-only`.
6. Conceder Finanzas a la cuenta de Alberto (Ajustes → Finanzas) y comprobar
   visualmente las 7 pantallas contra el informe y contra
   `backend/data/informe-semestre1-2026.md`.
7. `pnpm backup:full` de casa-clara con los datos ya migrados (drill de
   restauración según `docs/runbooks/backup-restore.md`).
8. La retirada del sistema antiguo (parar `cf-finanzas`, quemar credenciales,
   nota en el README del repo viejo) es de la fase 7 y tiene su propio plan.

Si cualquier paso imprime `Resultado: FALLO`, se aborta: el guion ya ha
revertido (o ni siquiera ha escrito). No se «arregla a mano» en producción:
se diagnostica en local con `--verify-only` y la copia del Paso 0.
