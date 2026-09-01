# Housekeeper

Aplicación web instalable para llevar una casa y la relación laboral con quien
trabaja en ella: qué toca hoy, la guía de la casa, el menú y la compra, el
calendario, los contactos y el expediente laboral —jornadas extra, gastos y
liquidaciones, todo en céntimos—. Cinco papeles —administración, familia,
empleada, apoyo y acceso puntual— con aislamiento real por hogar mediante Row
Level Security **forzada** en PostgreSQL.

> **«Housekeeper» es el nombre del proyecto, no el del producto.** Una misma
> instalación sirve a varias casas: sin sesión la aplicación se anuncia con un
> nombre genérico, y con sesión manda el nombre del hogar. Si vas a escribir
> texto de interfaz, lee primero
> [`apps/web/src/lib/app-title.ts`](apps/web/src/lib/app-title.ts): confundir
> ambas cosas ya causó fallos reales.

Monorepo pnpm: SvelteKit (SSR/BFF), worker Node, dominio puro, contratos
compartidos y migraciones PostgreSQL. Funciona sin conexión —foto crítica
firmada con Ed25519 y bandeja de salida en IndexedDB— y **está en producción
sobre Vercel + Supabase**.

> **En el repositorio todos los datos son sintéticos**: las cuentas de
> demostración usan dominios `*.demo`, los teléfonos están en rangos no
> asignables y no hay información laboral de nadie. Que la aplicación esté en
> producción con un hogar real **no cambia esta regla**: los datos de verdad
> viven fuera del árbol y nunca se copian dentro.

Repositorio privado. Consulta [LICENSE](LICENSE): todos los derechos reservados.

## Operar la aplicación

Si lo que quieres es **usarla como administración** —dar de alta a una persona,
crear una rutina, añadir una nota a la guía, registrar un contrato— o
**instalarla y mantenerla**, empieza por la skill:

**[`.claude/skills/operar-la-casa/`](.claude/skills/operar-la-casa/)**

Está escrita para que un agente o una persona nueva sepa por dónde se hace cada
cosa, con qué papel, y —lo más importante— **qué no hay que hacer**. La regla
que la atraviesa entera: se opera por la pantalla, no por SQL. Escribir directo
en la base salta las invariantes del dominio (libro de solo-añadir, tarifas
congeladas al resolver, versiones inmutables, RLS).

## Mapa del monorepo

| Ruta | Contenido |
|---|---|
| `apps/web` | SvelteKit + TypeScript: marco PWA, capacidades por papel, IndexedDB (foto/bandeja/adjuntos), `/api/v1` (sync, snapshot, ICS, adjuntos, avisos), Better Auth con usuario y contraseña |
| `apps/worker` | Worker Node: cola `app_private.job_queue`, PDF determinista de recibos, sincronización ICS, envío de avisos push |
| `packages/contracts` | Contratos públicos versionados (AppContext, CommandEnvelope, SyncResult, CriticalSnapshot…) con esquemas Zod |
| `packages/domain` | Motor puro: liquidaciones en céntimos `bigint`, máquina de jornadas extra, recurrencia de rutinas, vacaciones |
| `packages/server` | Primitivas de servidor: transacción autorizada bajo RLS, idempotencia de solo-añadir, lote de sync, firma Ed25519 |
| `packages/db` | Migraciones PostgreSQL, fixtures de dos hogares, suites SQL de esquema y RLS, e importador del manual de convivencia |
| `infra` | Compose local y de staging, Caddy, Dockerfiles, copias de seguridad, observabilidad y presupuestos de calidad |
| `scripts` | `ci/` (guardas anti-falso-verde de los workflows) y el empaquetador del manual publicable |
| `docs` | Aceptación, ADR, runbooks, seguridad, UX, despliegue y el manual de usuario |

## Puesta en marcha

### Requisitos

Node **24.18.0** (fijado en `.nvmrc`, `.node-version` y `engines`) y pnpm
**10.17.1**. Para las suites que tocan base de datos hace falta un PostgreSQL
**18** al que puedas conectarte con permiso para crear bases y roles: las
migraciones crean los roles de grupo `casa_clara_app` y `casa_clara_worker`
(nombres legados del proyecto anterior; ver
[docs/despliegue/identificadores-legado.md](docs/despliegue/identificadores-legado.md)),
y varias suites crean bases hermanas.

> Producción corre sobre **PostgreSQL 17** (es lo que ofrece Supabase). Ninguna
> migración usa sintaxis exclusiva de la 18, y esa diferencia está verificada.

```bash
corepack enable
pnpm install --frozen-lockfile
```

**Todas las variables de entorno están documentadas en
[`.env.example`](.env.example)**, con qué hace cada una y qué pasa si falta.

### Modo demostración, sin base de datos

```bash
pnpm dev        # http://localhost:5173, cuentas sintéticas en memoria
```

Sin `DATABASE_URL` la web sirve maquetas y `/api/v1/sync` responde 503: nunca
finge una confirmación. Con Postgres configurado, cada sesión opera bajo RLS de
verdad. El selector de cuentas sintéticas **desaparece del paquete** al
construir salvo que se declare `HOUSEKEEPER_FIXTURE_LOGIN`, y un despliegue que
lo lleve puesto con base de datos se niega a arrancar.

### Node y PostgreSQL portátiles (sin Docker)

```bash
# PostgreSQL portátil: binarios y bibliotecas fuera de las rutas del sistema
export PGBIN="$PG_HOME/usr/lib/postgresql/18/bin"
export LD_LIBRARY_PATH="$PG_HOME/usr/lib/x86_64-linux-gnu"
"$PGBIN/initdb" -D "$PGDATA" -U casa_admin --auth-local=trust --auth-host=trust
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-p 54329 -k /tmp/ccpg-socket" -l "$PGDATA/log" start
"$PGBIN/createdb" -h 127.0.0.1 -p 54329 -U casa_admin housekeeper_dev

export DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/housekeeper_dev"
```

Luego, **en este orden**:

```bash
# 1 · Esquema casa_auth y roles de login (sin esto, el paso 3 no tiene con qué entrar)
pnpm --filter @housekeeper/db bootstrap

# 2 · Migraciones. Repetir el comando debe aplicar cero: la idempotencia es contrato
pnpm db:migrate

# 3 · Cuentas del hogar (requiere DATABASE_AUTH_URL, BETTER_AUTH_SECRET y SEED_DATABASE_URL)
pnpm --filter @housekeeper/web seed:accounts
```

Detalle de cada paso en [`packages/db/README.md`](packages/db/README.md).

Poner **un hogar entero** en pie —roles, migraciones, personas, acuerdo laboral,
manual de convivencia y calendario— son siete pasos y están en
[docs/despliegue/alta-de-hogar.md](docs/despliegue/alta-de-hogar.md), con qué se
verifica en cada uno.

### Pila completa con Docker Compose

```bash
cp infra/env/local.env.example infra/env/local.env
docker compose --env-file infra/env/local.env -f infra/compose.local.yml up --build --wait
```

Levanta Caddy (`http://localhost:8080`), web, worker, PostgreSQL, MinIO y
ClamAV; perfiles opcionales `observability` y `backup`. **Es la vía local y de
staging**, no la de producción. El procedimiento de staging sintético está en
[docs/runbooks/staging-synthetic.md](docs/runbooks/staging-synthetic.md).

## Lo que degrada en silencio

El guardián de arranque solo exige `DATABASE_URL`, `DATABASE_AUTH_URL`,
`BETTER_AUTH_SECRET` y `BETTER_AUTH_URL`: lo justo para poder entrar. **Todo lo
demás falla con elegancia y un mensaje correcto**, lo que significa que una
función puede desplegarse a medias y parecer sana. Ya ocurrió tres veces:

| Falta | Qué se ve | Consecuencia real |
|---|---|---|
| `VAPID_PUBLIC_KEY` · `VAPID_PRIVATE_KEY` · `VAPID_SUBJECT` | «Esta instalación no manda avisos al móvil» | Nadie recibe avisos y parece una decisión de diseño |
| Depósito de Supabase Storage sin crear | 503 al adjuntar | Un justificante fotografiado se pierde |
| `SNAPSHOT_SIGNING_KEY_B64` | Nada | Cada instancia firma con una clave efímera: la foto guardada en el móvil deja de validar |

Por eso hay una **lista de comprobación posterior al despliegue** en la skill de
operación. Ninguna suite cubre esto: las pruebas verifican el código, no tu
proyecto de Vercel.

## Cómo se ejecutan las suites

Todo lo que existe se ejecuta en CI. Correspondencia exacta entre comando y job
de [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

| Comando | Qué cubre | Necesita Postgres | Job |
|---|---|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | Análisis estático de todos los workspaces | no | `static-analysis` |
| `pnpm --filter @housekeeper/web verify:bundle` | Presupuesto del JS inicial de Hoy, módulos desterrados del arranque y fuga de maquetas al cliente ([por qué](docs/architecture/delivery-quality-contract.md#presupuesto-de-arranque-de-hoy)) | no | `static-analysis` |
| `pnpm test:unit` | Unidades y dominio de todos los workspaces | no | `unit` |
| `scripts/ci/validate-compose.sh` | Contratos de los modelos Compose | no | `compose` |
| `pnpm db:migrate` → `test:db` → `test:rls` → `test:import` → `db:migrate` | Migraciones desde cero, invariantes de esquema, matriz negativa de RLS, importador del manual e idempotencia del runner | **sí** | `database` |
| `pnpm --filter @housekeeper/server test` | Transacción autorizada, idempotencia y sync bajo RLS | **sí** | `integration` |
| `pnpm --filter @housekeeper/web test` | Suites de integración de los cargadores de servidor bajo RLS | **sí** | `integration` |
| `pnpm --filter @housekeeper/worker exec vitest run` | Retención, cola y avisos con un login `NOBYPASSRLS` | **sí** | `integration` |
| `pnpm test:e2e` | Specs `*.e2e.ts`: PWA, sin conexión e IndexedDB en modo maqueta | no | `e2e-fixture` |
| `pnpm test:a11y` | axe sobre acceso, Hoy, Emergencias y la hoja «Más» | no | `e2e-fixture` |
| `pnpm test:e2e:db` | **Specs `*.dbe2e.ts`: la aceptación de los cinco papeles contra Postgres real** | **sí** | `e2e-database` |
| `pnpm test:lighthouse` | Presupuestos de rendimiento y accesibilidad 100 | no | `lighthouse` |

Para las suites con base de datos, exporta antes la conexión administradora:

```bash
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/housekeeper_dev"
export E2E_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/housekeeper_e2e"
```

> **Ejecuta las suites de base de datos en secuencia, nunca en paralelo.** Cada
> una recrea el esquema y varias crean bases y roles de **nombre fijo**
> (`housekeeper_access_it`, `it_housekeeper_app_login`…). Dos suites a la vez sobre
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
  al fichero el job o el entorno que necesita.** Esto no es teórico: una
  regresión del feed ICS estuvo meses auto-omitiéndose en CI por leer una
  variable que su job no exportaba.

Detalle en
[docs/architecture/delivery-quality-contract.md](docs/architecture/delivery-quality-contract.md).

## Documentación

**Para usar la aplicación**

- Manual de usuario, por papeles y con capturas: [docs/manual/index.html](docs/manual/index.html)
- Empaquetarlo como página autónoma: `node scripts/construir-manual-publicable.mjs`

**Para operar y desplegar**

- Skill de operación y mantenimiento: [.claude/skills/operar-la-casa/](.claude/skills/operar-la-casa/)
- Alta de un hogar nuevo: [docs/despliegue/alta-de-hogar.md](docs/despliegue/alta-de-hogar.md)
- Runbook de despliegue: [docs/despliegue/runbook-despliegue.md](docs/despliegue/runbook-despliegue.md)
- Puesta en producción, paso a paso y con lo que salió mal: [docs/despliegue/puesta-en-produccion-eg112.md](docs/despliegue/puesta-en-produccion-eg112.md)
- Vercel + Supabase (viabilidad, bloqueantes y coste): [docs/despliegue/plan-vercel-supabase.md](docs/despliegue/plan-vercel-supabase.md)
- Identificadores legados del proyecto anterior (Casa Clara) que siguen vivos en producción: [docs/despliegue/identificadores-legado.md](docs/despliegue/identificadores-legado.md)
- Runbooks: [planificador de la cola](docs/runbooks/planificador-cola.md) · [avisos push](docs/runbooks/notificaciones-push.md) · [copia y restauración](docs/runbooks/backup-restore.md) · [importar el manual](docs/runbooks/importar-manual.md) · [staging sintético](docs/runbooks/staging-synthetic.md) · [incidente de seguridad](docs/runbooks/security-incident.md)

**Cómo está pensado**

- Criterios de aceptación y desviaciones aprobadas: [docs/acceptance/brief-v2-adapted.md](docs/acceptance/brief-v2-adapted.md)
- Contrato de entrega y calidad: [docs/architecture/delivery-quality-contract.md](docs/architecture/delivery-quality-contract.md)
- Personal y contratos: [docs/personal-y-contratos.md](docs/personal-y-contratos.md)
- Rutinas y calendario: [docs/rutinas-y-calendario.md](docs/rutinas-y-calendario.md)
- Avisos al móvil: [docs/notificaciones.md](docs/notificaciones.md)
- Sistema de diseño móvil: [docs/ux/sistema-movil.md](docs/ux/sistema-movil.md)
- Decisiones: [ADR](docs/adr/)
- Base de seguridad: [docs/security/security-baseline.md](docs/security/security-baseline.md)
- Cómo contribuir: [CONTRIBUTING.md](CONTRIBUTING.md)

## Historia

El prototipo original —una aplicación de una sola página, sin monorepo— vivió en
la raíz de este repositorio hasta el 12 de agosto de 2026. Está preservado en
dos tags: [`demo-v0.1.0`](../../tree/demo-v0.1.0), el prototipo validado, y
[`demo-v0.1.1`](../../tree/demo-v0.1.1), el estado exacto que se retiró. Su
estado local no se migra.
