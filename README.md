# Casa Clara

PWA multi-tenant para la relación laboral doméstica y la operación del hogar:
qué toca hoy, la guía de la casa, el menú y la compra, el calendario, los
contactos y el expediente laboral (jornadas extra, gastos y liquidaciones en
céntimos). Cinco roles —administración, familia, empleada, apoyo y visor— con
aislamiento real por hogar mediante Row Level Security forzada en PostgreSQL.

Monorepo pnpm: SvelteKit (SSR/BFF), worker Node, dominio puro, contratos
compartidos y migraciones PostgreSQL 18. Funciona sin conexión (snapshot
firmado + outbox en IndexedDB) y se despliega hoy con Docker Compose.

> **Todos los datos del repositorio son sintéticos.** Las cuentas demo usan
> dominios `*.demo`, los teléfonos están en rangos no asignables y no hay
> información laboral real. No introduzcas datos personales verdaderos: el
> [ADR 0001](docs/adr/0001-plataforma-autogestionada.md) exige revisión legal y
> política de retención antes de que esto toque una relación laboral de verdad.

Repositorio privado. Consulta [LICENSE](LICENSE): todos los derechos reservados.

## Mapa del monorepo

| Ruta | Contenido |
|---|---|
| `apps/web` | SvelteKit + TypeScript: shell PWA, capacidades por rol, IndexedDB (snapshot/outbox/blobs), `/api/v1` (sync, snapshot, ICS, adjuntos), Better Auth con enlace mágico |
| `apps/worker` | Worker Node: cola `app_private.job_queue`, PDF determinista de justificantes, sincronización ICS, avisos por SMTP, almacenamiento S3 privado |
| `packages/contracts` | Contratos públicos versionados (AppContext, CommandEnvelope, SyncResult, CriticalSnapshot…) con esquemas Zod |
| `packages/domain` | Motor puro: liquidaciones en céntimos `bigint`, máquina de estados de jornadas extra |
| `packages/server` | Primitivas de servidor: transacción autorizada bajo RLS, idempotencia append-only, lote de sync, firma Ed25519 |
| `packages/db` | 17 migraciones PostgreSQL 18, fixtures de dos hogares, suites SQL de esquema/RLS e importador del manual |
| `infra` | Compose local y de staging, Caddy, Dockerfiles, backups, observabilidad y presupuestos de calidad |
| `scripts/ci` | Guardas anti-falso-verde que usan los workflows |
| `docs` | Aceptación, ADR, runbooks, seguridad, UX y plan de despliegue |
| raíz (`app.js`, `logic.js`, `data.js`, `server.mjs`) | Prototipo vanilla conservado (`demo-v0.1.0`) con su propia batería `tests/*.test.mjs` |

## Puesta en marcha

### Requisitos

Node **24.18.0** (fijado en `.nvmrc`/`.node-version` y en `engines`) y pnpm
**10.17.1**. Para las suites que tocan base de datos hace falta un PostgreSQL
**18** al que puedas conectarte como superusuario o, al menos, con permiso para
crear bases y roles: las migraciones crean los roles de grupo `casa_clara_app`
y `casa_clara_worker`, y varias suites crean bases hermanas.

```bash
corepack enable
pnpm install --frozen-lockfile
```

### Modo demo, sin base de datos

```bash
pnpm dev        # http://localhost:5173 con cuentas fixture en memoria
```

Sin `DATABASE_URL` la web sirve datos sintéticos y `/api/v1/sync` responde 503:
nunca finge una confirmación. Con Postgres configurado, cada sesión opera bajo
RLS real.

### Node y PostgreSQL portátiles (sin Docker)

Si no quieres Docker ni tocar el PostgreSQL del sistema, esta es la vía que usa
el equipo en WSL2: un Node y un PostgreSQL desempaquetados en un directorio
temporal y un clúster propio en un puerto alto.

```bash
# Node portátil ya desempaquetado en $NODE_HOME
export PATH="$NODE_HOME/bin:$PATH"

# PostgreSQL 18 portátil: binarios y bibliotecas fuera de las rutas del sistema
export PGBIN="$PG_HOME/usr/lib/postgresql/18/bin"
export LD_LIBRARY_PATH="$PG_HOME/usr/lib/x86_64-linux-gnu"

"$PGBIN/initdb" -D "$PGDATA" -U casa_admin
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-p 54329 -k /tmp/ccpg-socket" -l "$PGDATA/log" start
"$PGBIN/createdb" -h 127.0.0.1 -p 54329 -U casa_admin casaclara_dev

export DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
pnpm db:migrate
```

`pnpm db:migrate` es idempotente: registra cada migración con su SHA-256 y
reejecutarlo no produce cambios. El runner toma un `pg_advisory_lock` de
sesión, así que necesita **conexión directa**, nunca un pooler en modo
transacción.

### Pila completa con Docker Compose

```bash
cp infra/env/local.env.example infra/env/local.env
docker compose --env-file infra/env/local.env -f infra/compose.local.yml up --build --wait
```

Levanta Caddy (`http://localhost:8080`), web, worker, PostgreSQL 18, MinIO,
Mailpit y ClamAV; perfiles opcionales `observability` y `backup`. El
procedimiento de staging sintético está en
[docs/runbooks/staging-synthetic.md](docs/runbooks/staging-synthetic.md).

### Autenticación

Better Auth con enlace mágico como método principal. La contraseña existe sólo
para las cinco cuentas demo locales y únicamente con
`ENABLE_DEMO_PASSWORD_AUTH=true`:

```bash
pnpm --filter @casa-clara/web seed:demo   # requiere DATABASE_AUTH_URL, SEED_DATABASE_URL y las credenciales DEMO_*
```

## Cómo se ejecutan las suites

Todo lo que existe se ejecuta en CI. Esta es la correspondencia exacta entre
comando y job de [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

| Comando | Qué cubre | Necesita Postgres | Job |
|---|---|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | Análisis estático de todos los workspaces | no | `static-analysis` |
| `pnpm --filter @casa-clara/web verify:bundle` | Presupuesto del JS inicial de Hoy y fuga de fixtures a cliente | no | `static-analysis` |
| `pnpm test:unit` | Unidades y dominio de todos los workspaces | no | `unit` |
| `pnpm test:legacy` | Batería `node:test` del prototipo conservado | no | `unit` |
| `scripts/ci/validate-compose.sh` | Contratos de los modelos Compose | no | `compose` |
| `pnpm db:migrate` → `test:db` → `test:rls` → `test:import` → `db:migrate` | Migraciones desde cero, invariantes de esquema, matriz negativa de RLS, importador del manual e idempotencia del runner | **sí** | `database` |
| `pnpm --filter @casa-clara/server test` | Transacción autorizada, idempotencia y sync bajo RLS | **sí** | `integration` |
| `pnpm --filter @casa-clara/web test` | 15 suites de integración de los cargadores de servidor bajo RLS | **sí** | `integration` |
| `pnpm --filter @casa-clara/worker exec vitest run` | Retención y cola del worker con un login `NOBYPASSRLS` | **sí** | `integration` |
| `pnpm test:e2e` | 8 specs `*.e2e.ts`: PWA, offline e IndexedDB en modo fixture | no | `e2e-fixture` |
| `pnpm test:a11y` | axe sobre acceso, Hoy, Emergencias y la hoja «Más» | no | `e2e-fixture` |
| `pnpm test:e2e:db` | **18 specs `*.dbe2e.ts`: la aceptación de los cinco roles contra Postgres real** | **sí** | `e2e-database` |
| `pnpm test:lighthouse` | Presupuestos de rendimiento y accesibilidad 100 | no | `lighthouse` |

Para las suites con base de datos, exporta la conexión administradora antes:

```bash
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
export E2E_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_e2e"
```

> **Ejecuta las suites de base de datos en secuencia, nunca en paralelo.** Cada
> una recrea el esquema y varias crean bases y roles de **nombre fijo**
> (`casaclara_access_it`, `it_casa_clara_app_login`…). Dos suites a la vez sobre
> el mismo clúster se pisan y fallan de formas confusas. En CI cada job levanta
> su propio contenedor de PostgreSQL, que es la manera limpia de aislarlas.

## Qué bloquea un despliegue

El job **`deployable`** de `ci.yml` es la única puerta que hay que exigir en la
protección de rama: reúne los nueve jobs anteriores y falla si alguno no ha
terminado en verde.

Dos guardas existen específicamente contra el falso verde:

- `scripts/ci/run-tests-nonempty.sh` — falla si el runner termina con éxito sin
  haber ejecutado ninguna prueba (nació de un falso verde real en WSL).
- `scripts/ci/assert-suite-coverage.py` — compara el inventario de ficheros de
  spec del árbol con los que aparecen ejecutados en los informes JUnit. Si
  añades una batería que ningún job invoca, o una suite se queda sin base de
  datos y se salta entera, el job `suite-coverage` falla. **No lo relajes: dale
  al fichero el job o el entorno que necesita.**

Detalle en [docs/architecture/delivery-quality-contract.md](docs/architecture/delivery-quality-contract.md).

## Documentación

- Criterios de aceptación y desviaciones aprobadas: [docs/acceptance/brief-v2-adapted.md](docs/acceptance/brief-v2-adapted.md)
- Contrato de entrega y calidad: [docs/architecture/delivery-quality-contract.md](docs/architecture/delivery-quality-contract.md)
- Decisión de plataforma: [docs/adr/0001-plataforma-autogestionada.md](docs/adr/0001-plataforma-autogestionada.md)
- **Despliegue en Vercel + Supabase (auditoría de viabilidad, bloqueantes y coste): [docs/despliegue/plan-vercel-supabase.md](docs/despliegue/plan-vercel-supabase.md)**
- Opciones de acceso sin correo: [docs/despliegue/opciones-de-acceso.md](docs/despliegue/opciones-de-acceso.md)
- Runbooks: [staging sintético](docs/runbooks/staging-synthetic.md) · [backup y restauración](docs/runbooks/backup-restore.md) · [importar el manual](docs/runbooks/importar-manual.md) · [incidente de seguridad](docs/runbooks/security-incident.md)
- Base de seguridad: [docs/security/security-baseline.md](docs/security/security-baseline.md)
- Cómo contribuir: [CONTRIBUTING.md](CONTRIBUTING.md)

## Prototipo original

El prototipo vanilla validado está preservado en el tag
[`demo-v0.1.0`](../../tree/demo-v0.1.0); su estado local no se migra. Sus
ficheros siguen en la raíz y su batería `tests/*.test.mjs` se ejecuta en CI
mediante `pnpm test:legacy`.
