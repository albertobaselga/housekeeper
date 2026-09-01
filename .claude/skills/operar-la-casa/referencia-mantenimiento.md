# Mantenimiento

Migraciones, la cola en producción, copias, rotación de secretos, la batería de
pruebas y qué mirar cuando algo falla.

---

## Migraciones

### El runner

`packages/db/scripts/migrate.mjs`, que se invoca como `pnpm db:migrate` (o
`pnpm --filter @housekeeper/db migrate`). Sólo lee `DATABASE_URL`.

Aplica en orden todos los ficheros `NNNN_*.sql` de `packages/db/migrations/` que
falten, **cada uno en su propia transacción junto con su fila de registro** en
`public.schema_migrations` (nombre + SHA-256).

**Idempotencia.** Reejecutarlo sobre una base al día no cambia nada y dice
`Database is up to date; no migrations applied.` Verificado.

**Si editas una migración ya aplicada, aborta**:

```
0021_… was already applied with a different checksum;
write a new migration instead of editing it
```

Eso no se relaja: se escribe una migración nueva.

**Formato.** Cada `.sql` tiene que ser un único bloque `BEGIN; … COMMIT;`, para
que el runner pueda aplicarlo y registrarlo atómicamente. Si no, falla al leerlo.

**Cerrojo.** Toma un `pg_advisory_lock` de **sesión**, así que necesita
**conexión directa** (5432), nunca un *pooler* en modo transacción.

**Sobre Supabase**: si el rol conectado no puede saltarse RLS, el runner
intercala `0018_rls_force_compat.sql` **entre** migraciones y lo dice por
pantalla. Es normal: varias migraciones vuelven a forzar RLS, y las funciones
`SECURITY DEFINER` con `SET row_security = off` no se pueden ni crear mientras el
forzado siga puesto.

### `--until` no es una opción de línea de órdenes

Es un parámetro de la función exportada `applyMigrations(client, { log, until })`
y **sólo lo usan las pruebas**: detiene la aplicación **después** del fichero
indicado, para dejar una base en un punto intermedio, sembrar historial y seguir
migrando.

Existe por una lección concreta: **una migración puede pasar en verde con las
tablas vacías y romperse con historial.** Le ocurrió a la 0021 con los eventos de
trabajo extra (`cannot ALTER TABLE … because it has pending trigger events`).
Por eso hay suites que migran hasta un punto, siembran y siguen
(`migrate-with-history.test.mjs`, `migrate-job-queue-timezone.test.mjs`).

**Al escribir una migración nueva, prueba contra una base con datos**, no sólo
contra una vacía.

### Por qué las destructivas van separadas del despliegue anterior

Cuando un cambio retira algo que el cliente todavía puede estar usando, se parte
en dos migraciones y **dos despliegues**: una que **expande** y otra que
**contrae**. El caso vivo es la cadencia de rutinas — 0023 expandió, 0033
contrajo — y la razón está escrita en la propia 0033:

> «T10 nunca se adelanta ni se mezcla — separarla del despliegue anterior es la
> única garantía de que un envelope offline antiguo no se pierda.»

Esta aplicación funciona **sin conexión**: un móvil puede llevar en su IndexedDB
un comando encolado con el formato anterior. Si contraes en el mismo despliegue
que expandes, ese comando se pierde. Con la separación, para cuando se retira el
formato viejo ya no queda ninguna cola guardándolo — y si llegara igualmente
tarde, **se rechaza por su nombre** (`routine_cadence_format_retired`) en vez de
traducirse a ciegas, porque la tabla de traducción miente cuando la cadencia rica
no cabe en el vocabulario viejo.

La 0033 documenta además el orden obligatorio de una contracción, y la parte que
de verdad importa: **el cuerpo de una función SQL se guarda como texto y no se
comprueba al renombrar una columna**. Sin recrear las funciones que la citan, la
migración pasa en verde, la base queda «bien» y el feed ICS revienta en caliente
la primera vez que alguien lo usa.

---

## El planificador de la cola

En producción **no hay worker desplegado**: la cola la drena `pg_cron` llamando
con `pg_net` a `POST /api/v1/jobs/run`, que ejecuta los **mismos manejadores** del
worker. Runbook completo, con el SQL:
[docs/runbooks/planificador-cola.md](../../../docs/runbooks/planificador-cola.md).

```
pg_cron ──cada 5 min──▶ pg_net ──POST──▶ /api/v1/jobs/run (Vercel)
                                              │
                                              ▼
                                runOneJob() sobre app_private.job_queue
```

**Son seis tipos de trabajo**: `document.render_receipt`, `ics.sync_source`,
`ics.sync_all`, `notification.push`, `notification.close_due_sweep`
(barrido mensual del tercer aviso, «el mes está a punto de acabar»; migración
0034) y `maintenance.prune_discovery`. Los dos de avisos —`notification.push`
y `notification.close_due_sweep`— **sólo se registran si hay claves VAPID**;
sin ellas la cola se vacía igual, solo que sin esos dos.

### Comprobar que drena

```bash
curl -si -X POST https://casa.ejemplo.es/api/v1/jobs/run \
  -H "x-housekeeper-job-token: $JOB_RUNNER_TOKEN"
```

Una respuesta sana:

```json
{"ran":2,"remaining":0,"reclaimed":{"requeued":0,"dead":0},
 "stoppedBy":"empty","elapsedMs":143,"budgetMs":8000}
```

Y desde la base:

```sql
-- Lo que contestó la web DE VERDAD (el cron sólo dice que el SQL corrió).
select id, created, status_code, content
  from net._http_response order by created desc limit 10;

-- Y el efecto: nada atascado.
select status, job_type, count(*)
  from app_private.job_queue group by 1, 2 order by 1, 2;
```

| Lectura | Qué significa |
|---|---|
| `status_code = 401` | El token de Vercel y el del Vault no coinciden |
| `status_code = 503` `job_runner_unavailable` | Falta alguna variable en Vercel |
| `status_code = 503` `job_queue_unavailable` | La base no responde, o el rol no puede tocar la cola |
| `net._http_response` vacío | El cron no llega a llamar: mira `cron.job.active` |
| `stoppedBy: "budget"` con `remaining` alto y sostenido | Entra más rápido de lo que se vacía: sube `JOB_RUNNER_BUDGET_MS` o baja el cron a `*/2` |
| `reclaimed.dead > 0` | Agotó sus intentos: mira `last_error` **antes** de re-encolarlo |
| Trabajos atascados en `running` | El ejecutor murió a mitad. Se rescatan solos pasado `JOB_RUNNER_LEASE_MS` (5 min) |

**Criterio de salida real**, no de palabra: una liquidación cerrada genera su PDF
en menos de cinco minutos, y un feed ICS enlazado aparece en el calendario sin que
nadie toque nada.

**Cola vacía y nada periódico** en una base recién sembrada es normal: no hay
ninguna fila que sirva de ancla. Hay que sembrar el primer trabajo a mano
(§4.5 del [runbook de despliegue](../../../docs/despliegue/runbook-despliegue.md));
a partir de ahí el drenaje re-arma las cadenas solo, porque cada trabajo se
re-encola a sí mismo.

**Pausar sin borrar** (una migración larga):

```sql
update cron.job set active = false where jobname = 'casa-clara-drenaje-cola';
```

(`casa-clara-drenaje-cola` es el nombre legado de la tarea de cron del proyecto
anterior; ver
[docs/despliegue/identificadores-legado.md](../../../docs/despliegue/identificadores-legado.md).)

Los dos ejecutores —el demonio y el drenaje— **pueden convivir**: el reclamo usa
`for update skip locked`, así que se reparten los trabajos y ninguno ejecuta el
mismo dos veces.

---

## Copias de seguridad y restauración

**No hay copias automáticas, y es una decisión, no un olvido**: el propietario
quiere pedirlas cuando le apetezca y saber que están enteras. `pnpm backup:full`
no programa nada y no borra nada.

```bash
export BACKUP_DATABASE_URL="$DIRECTA"    # DIRECTA (5432): pg_dump NO va por el pooler
export S3_ENDPOINT=… S3_REGION=… S3_PRIVATE_BUCKET=… \
       S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…
pnpm backup:full
```

Hace las dos mitades —base y adjuntos— y **sólo entonces** da el directorio por
bueno:

1. `pg_dump --format=custom --compress=zstd:9` **y lo verifica con
   `pg_restore --list`**.
2. Descarga todos los objetos del bucket y **falla si el recuento no coincide**
   con el listado.
3. Escribe `SHA256SUMS` y `manifest.json`. La cadena de conexión **no** se
   escribe: llevaría la contraseña.
4. Renombra desde `.partial`. **Una copia interrumpida no se puede confundir con
   una buena.**

**Lo que este comando NO hace, y el ADR 0001 exige**: cifrar la copia y guardarla
**fuera del proveedor**. Mientras eso no se decida, la copia se queda donde la
deje quien la ejecute.

Restaurar es el camino inverso y tiene su runbook:
[docs/runbooks/backup-restore.md](../../../docs/runbooks/backup-restore.md).
**Ensaya la restauración antes de necesitarla**: una copia que nunca se ha
restaurado no es una copia, es un fichero.

---

## Rotación de secretos

Lo que se rompe al rotar cada uno. Esto es lo que hay que saber **antes** de
tocarlos.

| Secreto | Al rotarlo | Cómo se hace sin ventana de caída |
|---|---|---|
| `BETTER_AUTH_SECRET` | **Invalida todas las sesiones**: todo el mundo tiene que volver a entrar. Las contraseñas siguen valiendo | Avisar. No hay forma de evitarlo |
| `JOB_RUNNER_TOKEN` | Ventana de 401 en el drenaje | **Primero el Vault de Supabase, después Vercel.** Al revés hay 401 seguro. Perder una o dos pasadas da igual: la cola espera |
| `VAPID_*` | **Invalida TODAS las suscripciones a la vez.** Hay que volver a suscribir a cada persona **con su teléfono delante** | No se rotan por higiene. Sólo ante compromiso |
| `SNAPSHOT_SIGNING_KEY_B64` | Los snapshots offline ya emitidos dejan de verificar; los dispositivos piden uno nuevo | Poco daño, pero hazlo fuera de hora |
| Contraseñas de rol (`APP_DB_PASSWORD`…) | Reponerlas es `pnpm --filter @housekeeper/db bootstrap` con la variable nueva; hay que actualizar **la cadena de conexión de cada consumidor** | Rol a rol, comprobando cada uno |
| `SUPABASE_SERVICE_ROLE_KEY` | Los adjuntos dejan de subirse y de servirse | Rotar en Supabase y en Vercel en la misma operación |
| Token del feed ICS | El calendario suscrito deja de actualizarse en el dispositivo de quien lo tenga | Comando `ics_feed` / `revoke` y volver a enlazar |

Si lo que hay es un **incidente**, no una rotación planificada:
[docs/runbooks/security-incident.md](../../../docs/runbooks/security-incident.md).

---

## La batería de pruebas

Todo lo que existe se ejecuta en CI. La correspondencia exacta entre comando y
job está en el [README](../../../README.md#cómo-se-ejecutan-las-suites) y en
[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml); los diez jobs son
`static-analysis`, `unit`, `compose`, `database`, `integration`, `e2e-fixture`,
`e2e-database`, `lighthouse`, `suite-coverage` y `deployable`.

### Sin base de datos

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm --filter @housekeeper/web verify:bundle   # presupuesto de arranque de Hoy
pnpm test:unit
pnpm test:legacy                              # el prototipo conservado
pnpm test:e2e                                 # 8 specs *.e2e.ts (PWA, offline)
pnpm test:a11y                                # axe
```

### Con base de datos

Exporta primero la conexión **administradora** (no la de la aplicación: estas
suites crean y destruyen esquemas):

```bash
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/housekeeper_dev"
export E2E_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/housekeeper_e2e"
```

```bash
pnpm db:migrate                               # desde cero
pnpm test:db                                  # invariantes de esquema
pnpm test:rls                                 # matriz negativa de RLS
pnpm test:import                              # importador del manual
pnpm db:migrate                               # y otra vez: idempotencia del runner
pnpm --filter @housekeeper/server test
pnpm --filter @housekeeper/web test
pnpm --filter @housekeeper/worker exec vitest run
pnpm test:e2e:db                              # 18 specs *.dbe2e.ts, los cinco roles
```

Verificado: `pnpm test:rls` contra una base propia responde
`# tests 1 passed, 0 failed of 1`.

> **En secuencia, nunca en paralelo.** Cada suite recrea el esquema y varias
> crean bases y roles de **nombre fijo** (`housekeeper_access_it`,
> `it_housekeeper_app_login`…). Dos a la vez sobre el mismo clúster se pisan y
> fallan de formas confusas. En CI cada job levanta su propio contenedor, que es
> la manera limpia de aislarlas.

**`run-sql-tests.mjs` es destructivo por diseño**: hace
`DROP SCHEMA app CASCADE` sobre la base que le digas. Nunca lo apuntes a una base
que te importe.

### Las dos guardas anti-falso-verde

No se relajan. Existen porque el falso verde ya pasó:

- `scripts/ci/run-tests-nonempty.sh` — falla si el runner termina con éxito **sin
  haber ejecutado ninguna prueba** (nació de un falso verde real en WSL).
- `scripts/ci/assert-suite-coverage.py` — compara los ficheros de spec del árbol
  con los que aparecen ejecutados en los informes JUnit. Si añades una batería que
  ningún job invoca, o una suite se queda sin base de datos y se salta entera, el
  job `suite-coverage` falla. **Dale al fichero el job o el entorno que necesita**,
  no relajes la guarda.

El job **`deployable`** reúne los nueve anteriores y es la única puerta que hay
que exigir en la protección de rama.

---

## Diagnóstico

### Lo primero, siempre

```bash
curl -s https://casa.ejemplo.es/api/health
# {"status":"ok",…,"synthetic":false,"fixtureLogin":false}
```

### Por síntoma

| Síntoma | Mira |
|---|---|
| **Nadie puede entrar (401 para todos)** | ¿Las tablas de Better Auth están en `casa_auth` o en `public`? Es la trampa de `DATABASE_AUTH_URL`. Ver [instalación](referencia-instalacion.md#2-las-personas) |
| **La entrada muestra tarjetas de cuentas** | Falta la base de identidad. **No estás sirviendo datos reales** |
| **El servidor no arranca y nombra variables** | La regla indivisible. El mensaje dice exactamente cuáles faltan; se arregla en el panel y con un despliegue, nunca desde dentro de la aplicación |
| **El PDF del recibo no llega** | La cola. `POST /api/v1/jobs/run` y `app_private.job_queue` |
| **El calendario enlazado sigue vacío** | La cola otra vez: sin drenaje, la primera lectura no ocurre nunca |
| **Los avisos no llegan sólo a los iPhone** | `VAPID_SUBJECT` sucio. Apple contesta 403 `BadJwtToken`, y sólo Apple |
| **No se pueden subir justificantes (503)** | No hay depósito configurado. No es transitorio |
| **«Sin trabajo extra disponible» en Contrato** | El acuerdo nació **mudo**. No tiene arreglo hacia atrás: ver [operaciones](referencia-operaciones.md#contratos) |
| **Un comando se rechaza con `routine_cadence_format_retired`** | Alguien manda la cadencia vieja (`frequency`). Es un rechazo honesto, no un fallo |
| **403 al entrar en una pantalla** | Falta la capacidad. Comprueba el rol de **esa membresía**, no de la persona |
| **404 en una pantalla que existe** | `guardForPath()` falla cerrada: una ruta hija no declarada en `NESTED_ROUTE_CAPABILITY` no se sirve |
| **La build muere antes de `vite build`** | El guardián de configuración. Fallar ahí es gratis: el despliegue anterior sigue sirviendo |
| **Una migración aborta por checksum** | Alguien editó una migración ya aplicada. Se escribe una nueva |

### Registro

Cada pasada de la cola deja una línea JSON en los logs de la función:

```json
{"scope":"web:jobs","msg":"job queue drained",
 "counts":{"ran":2,"remaining":0,"requeued":0,"dead":0},"ms":143}
```

**Ni nombres ni contenido: sólo identificadores técnicos.** Si añades trazas,
mantenlo así.

### Dónde NO buscar

- `GET /api/metrics` de la **web** en serverless: cada invocación es un proceso
  nuevo, así que sus contadores son ruido. No lo conectes a ningún Prometheus.
  Los del **worker** sí son reales.
- El correo: **no existe** desde la migración 0029. Si algo esperaba un aviso por
  correo, esperaba en vano.
