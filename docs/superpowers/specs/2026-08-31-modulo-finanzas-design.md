# Módulo «Finanzas»: fusión de home-finance en casa-clara

Fecha: 2026-08-31 · Estado: aprobado en conversación, pendiente de plan de implementación
Rama de trabajo: `worktree-modulo-finanzas` (worktree `.claude/worktrees/modulo-finanzas`)

## 1. Contexto y objetivo

La aplicación **home-finance** (`/home/abf/github/home-finance`, FastAPI + SQLite + React 19)
gestiona las finanzas familiares: importa extractos de CaixaBank, Deutsche Bank, OpenBank y
Amex, categoriza movimientos, detecta transferencias entre cuentas propias y muestra
dashboards de ahorro. Corría en local expuesta por un quick tunnel de Cloudflare y hoy está
caída (sin proceso en :8000); sus datos (1.111 transacciones, enero–junio 2026) viven en un
único fichero SQLite en esta máquina.

El objetivo es **fusionarla en casa-clara como un módulo más del hogar**, exclusivo de
administradores y activable cuenta a cuenta, con sus datos migrados a la base de producción
(Supabase) y el sistema antiguo retirado. No se copia código: se replica el dominio y la
experiencia dentro del stack de casa-clara (SvelteKit + Postgres con RLS + comandos
idempotentes), siguiendo todas las convenciones del repo.

## 2. Decisiones ya tomadas (con Alberto)

1. **Activación**: cualquier `family_admin` concede o revoca Finanzas a otros
   administradores desde Ajustes. Los admins nuevos nacen con Finanzas apagado. Tras la
   migración se activa solo a la cuenta de Alberto.
2. **Gráficas**: SVG artesanal con los tokens de casa-clara. Sin librería de charts.
3. **Pivot de Analítica**: réplica completa desde el principio, incluido el drag-and-drop
   (con la barra de acciones como alternativa accesible y táctil).
4. **Corte de datos**: migración única y retirada — copia de seguridad, ETL ensayado en
   local, verificación, apagado de `cf-finanzas` y rotación de las credenciales antiguas.

## 3. Alcance

Siete pantallas bajo `/h/[householdId]/finanzas`: Dashboard, Analítica (con pivot completo),
Movimientos, Revisión, Eventos, Importar y Ajustes del módulo. Importadores de los cuatro
bancos. Migración de los datos existentes. Matriz de permisos con la nueva dimensión de
concesión por cuenta.

**Fuera de alcance (explícito):**

- Notificaciones push de finanzas: la política de la casa las limita a dos avisos
  (`docs/notificaciones.md` §6) y este módulo no la reabre.
- Soporte offline del módulo: es un panel de administración, funciona online. Sus escrituras
  usan igualmente `queueCommand` (contrato uniforme), pero Finanzas no entra en el snapshot
  crítico firmado ni en el precache del service worker.
- El agente `/categorizar`: fase posterior (skill del repo housekeeper). El estado
  `sugerida_agente` y el origen de reglas `agente` quedan preparados en el esquema.
- Importadores de bancos nuevos y multi-divisa (se mantiene `CHECK (currency_code = 'EUR')`).
- Página «Inversiones» separada: como en el original, la inversión es un tipo de cuenta,
  una sección del pivot y acciones del panel de detalle.

## 4. Permisos: doble cerrojo, impuesto en RLS

`family_admin` recibe todas las capacidades por construcción (`roleCapabilities.family_admin
= allCapabilities`), así que una capacidad sola no permite «activarlo solo a unas cuentas».
El diseño usa **dos requisitos simultáneos**:

1. **Capacidad `finance.access`** en `packages/contracts/src/capabilities.ts` (orden
   alfabético: entre `export.employment.self` y `guide.write`). En la matriz solo la
   reciben los `family_admin` (vía `allCapabilities`); ningún otro rol la lista. El
   submódulo `/capabilities` NO se reexporta desde la raíz (regla del presupuesto de Hoy).
2. **Concesión por membresía**: tabla `app.finance_module_grants` — `household_id`,
   `membership_id` (referencia compuesta al hogar), `granted_by_membership_id`,
   `granted_at`, `revoked_at`, `revoked_by_membership_id`. Una concesión viva es una fila
   con `revoked_at IS NULL`; revocar escribe `revoked_at` (histórico conservado, patrón
   `push_subscriptions`/`must_change_password`). Un trigger impide conceder a membresías
   cuyo rol no sea `family_admin`.

**Imposición en cada capa:**

- **RLS (la que cuenta)**: función SQL `app.finance_enabled()` → `app.current_household_role()
  = 'family_admin' AND EXISTS (concesión viva para app.current_membership_id())`. TODAS las
  políticas de TODAS las tablas `finance_*` —con la única excepción de
  `finance_module_grants`— (SELECT, INSERT, UPDATE, DELETE) exigen
  `app.tenant_context_matches() AND app.finance_enabled()`. Un admin sin concesión ve cero
  filas aunque llame a la API a mano; interna (`employee_live_in`), apoyo (`helper`),
  miembro de familia y acceso puntual (`viewer`) ven cero filas por rol. La propia
  `finance_module_grants` es legible por cualquier admin del hogar (para pintar Ajustes)
  y solo mutable vía comandos.
- **Servidor**: helper `requireFinanceAdmin` en `packages/server` (análogo a
  `requireAdmin`) que verifica rol + concesión dentro de la transacción autorizada; lo usan
  todos los handlers de comandos y todos los endpoints REST de finanzas.
- **Routing**: `MODULE_CAPABILITY['finanzas'] = 'finance.access'` y una entrada en
  `NESTED_ROUTE_CAPABILITY` por CADA ruta hija (fail-closed: lo no declarado es 404).
- **AppContext**: `+layout.server.ts` calcula `capabilities = capabilitiesFor(role)` y
  **retira** `finance.access` si la membresía no tiene concesión viva. Así el AppShell, el
  guard de rutas y la UI funcionan sin cambios de mecanismo, y el cliente nunca ve el
  módulo si no le corresponde.
- **Ajustes**: tarjeta «Finanzas» en `/h/[id]/settings` que lista las membresías
  `family_admin` con interruptor conceder/revocar. Comandos `finance.grant.write` /
  `finance.revoke.write` (requieren `access.manage` + rol admin del emisor; un admin puede
  revocarse a sí mismo — otro admin puede devolvérselo).

**Pruebas**: `packages/db/tests/020_rls_matrix.sql` gana una sección de finanzas con, como
mínimo: admin con concesión ve las filas de su hogar; admin sin concesión = 0 filas;
`family_member`/`employee_live_in`/`helper`/`viewer` = 0 filas; cero fugas entre los
hogares roble y olivo; suplantación de contexto falla 42501. Las fixtures
(`fixtures/001_two_households.sql` o fichero nuevo de finanzas) añaden datos sintéticos de
finanzas a ambos hogares y concesión solo a un admin de roble.

## 5. Modelo de datos: migración `0036_finance.sql`

Un solo fichero `BEGIN;…COMMIT;` append-only, siguiente número libre (0036). Nueve tablas
espejo del origen más la de concesiones, todas en el esquema `app`, con `household_id`,
clave compuesta `(household_id, id)` donde aplica, `ENABLE + FORCE ROW LEVEL SECURITY`,
`GRANT` explícito a `casa_clara_app`, y trigger de auditoría (`app_private.write_audit_event`):

| Tabla | Contenido y notas |
|---|---|
| `finance_module_grants` | Concesión por membresía (§4). |
| `finance_accounts` | `name`, `bank`, `kind` (`comun`\|`personal`\|`inversion`), `owner_label` (texto libre; el origen usaba el literal padre/madre/familia), `bank_ref` (UNIQUE por hogar), `owner_aliases jsonb`, `transfer_refs jsonb` (las refs de inversión dejan de estar hardcodeadas en código), `archived_at`. |
| `finance_categories` | Árbol de 2 niveles (`parent_id`), `name`, `kind` (`gasto`\|`ingreso`\|`transferencia`). La semilla del origen (`seed.py`) se replica como datos por hogar al activar el módulo o migrar. Exactamente una categoría `transferencia` por hogar (invariante del origen; se protege con índice parcial único sobre `kind='transferencia'` en raíz). |
| `finance_rules` | `rule_type` (`proveedor_exacto`\|`concepto_contiene`\|`codigo_norma43`), `pattern`, `category_id`, `priority`, `origin` (`manual`\|`agente`). |
| `finance_import_batches` | `filename`, `bank`, `imported_at`, conteos. Borrar un lote = deshacer la importación (ON DELETE CASCADE sobre sus transacciones, como el origen). |
| `finance_transactions` | `account_id`, `batch_id` (nullable: manuales), `op_date date`, `value_date date`, `concept`, `provider`, `provider_norm`, `amount_cents bigint`, `balance_cents bigint`, `code_common`, `code_own`, `category_id`, `status` (`pendiente`\|`sugerida_regla`\|`sugerida_agente`\|`confirmada`), `transfer_group_id uuid`, `dedup_hash` (UNIQUE por hogar), `recurrence`, `recurrence_manual`, `bank_category`, `raw jsonb`. Índices por `(household_id, op_date)`, `(household_id, status)`. |
| `finance_provider_aliases` | `provider_norm` (UNIQUE por hogar) → `display`. |
| `finance_events` | `name` (UNIQUE por hogar). Etiquetas transversales («Semana Santa 2026»). |
| `finance_transaction_events` | N:M transacción↔evento (UNIQUE por par). |
| `finance_event_rules` | Asignación automática a evento por (`provider_norm`,`concept_norm`) o por `category_id`. |

Convenciones de dinero: céntimos `bigint`, `CHECK (currency_code = 'EUR')` donde haya
importe con divisa, formato es-ES con `formatCents`/`MoneyCents` del dominio. Ninguna
columna de dinero es float, nunca.

**Desviación deliberada del patrón append-only laboral**: las transacciones de finanzas son
un conjunto de trabajo analítico — recategorizar, confirmar, agrupar y corregir es el uso
normal. Se permiten UPDATE (y DELETE solo de manuales y de lotes al deshacer una
importación), con el trigger de auditoría registrando cada mutación. El ledger laboral
existente (liquidaciones, pagos, anticipos) no se toca ni se mezcla: dos dominios contables
separados a propósito, y la frontera de visibilidad salarial existente (AC-12) no se
debilita.

Compatibilidad Supabase: mismas reglas que el resto (0018 relaja FORCE entre migraciones;
funciones `SECURITY DEFINER` solo si hacen falta y con `SET row_security = off` justificado).
La suite `tests/010` (ninguna tabla sin RLS) cubre las tablas nuevas automáticamente.

## 6. Dominio y lógica portada

### `packages/domain/src/finance/` (puro: sin pg, sin fetch, sin reloj)

Portar con intención de test equivalente al origen (`backend/app/*.py` y los tests de
`frontend/src/features/analytics/*`):

- `provider-norm.ts` — normalización de proveedores (tarjetas, SEPA, transferencias 04/073,
  Bizum, MyBox, PayPal `PAYPAL *X` → vendor).
- `rules.ts` — motor de categorización: `proveedor_exacto` > `concepto_contiene` >
  `codigo_norma43`, por prioridad y especificidad; solo toca `pendiente` → `sugerida_regla`.
- `transfers.ts` — detección de cruces: patas de cuentas distintas, importes exactamente
  opuestos, ≤3 días; palabras TRANSFERENCIA/TRASPASO + `owner_aliases` confirman;
  recuperación de patas huérfanas y de «Aportaciones» confirmadas.
- `amex.ts` — conciliación recibo (+) ↔ cargo bancario (−), importe exacto, ±10 días.
- `investments.ts` — detección de aportaciones por `transfer_refs` de cuentas `inversion`
  (datos, no código) y generación de patas espejo `invmirror-`.
- `cash.ts` — doble entrada de efectivo (retirada = gasto «Efectivo»; gasto manual en
  Efectivo crea contrapartida `cashpair-`).
- `recurrence.ts` — huella de proveedor sin referencias; recurrente si ≥3 meses o 2 con
  señal fuerte (mediana estable ≤35 %, mismo día ±4 con vuelta de mes, o patrón
  RECIBO/NÓMINA/CUOTA/PRÉSTAMO o códigos 03/05); respeta `recurrence_manual`.
- `event-rules.ts` — aplicación de reglas de evento (asignación exclusiva).
- `kpis.ts` — tasas de ahorro neta/bruta, inversión, free/ops cash flow, comparativa con el
  periodo anterior alineado a meses, aportaciones recibidas al filtrar cuentas, medias por
  meses completos.
- `pivot.ts` — construcción del árbol del pivot (secciones INGRESOS/GASTOS/EVENTOS/
  INTERNAS/INVERSIÓN + TOTAL NETO, dimensiones cat/sub/nat/prov/concept/movement,
  acumulado/promedio/ticket/por-mes, `dupev`). Portado con los tests del original
  (`pivotTree.test.ts` y compañía) reescritos en vitest del monorepo.
- `dedup.ts` — cálculo canónico de la cadena a hashear (`bank_ref|fecha|importe|concepto
  normalizado|saldo[|ref]`); el sha256 en sí lo aplica `packages/server` (node:crypto).

### `packages/server/src/finance/`

- `parsers/` — CaixaBank (.xls binario, CCC de 20 dígitos por fila), Deutsche Bank (.xls,
  IBAN en cabecera «Cuenta:»), OpenBank (HTML disfrazado de .xls, iso-8859-1), Amex (.xlsx,
  hoja «Detalles de la operación», signo invertido, columna Referencia como `dedup_ref`).
  Detección de banco por contenido (`PK`/HTML OPENBANK/celdas características), como
  `importer.detect_bank`. Dependencia nueva: **SheetJS (`xlsx`)** para BIFF/.xlsx, solo en
  servidor (nunca alcanza el cliente).
- `pipeline.ts` — el pipeline post-import **unificado en una sola función** con el orden
  crítico del origen: reglas → alias PayPal → conciliación Amex → inversiones →
  transferencias → efectivo → recurrencia → reglas de evento. (En el origen estaba
  duplicado en `api.py` y `cli.py`; aquí una sola verdad.)
- `commands/finance.ts` — handlers de comandos (§7) con `requireFinanceAdmin`.
- Los prefijos semánticos de `dedup_hash` (`manual-`, `cashpair-`, `invmirror-`) se
  conservan para compatibilidad con los datos migrados y el deshacer de importaciones.

## 7. Superficie de API

### Lecturas

- `+page.server.ts` de cada pantalla carga el primer render bajo RLS (patrón
  `demoOrUnavailable()` con fixtures sintéticas para el modo demo).
- Endpoints REST GET bajo `/api/v1/finance/…` para la interactividad de filtros sin
  recarga (summary, series, analytics, pivot, breakdown, providers, transactions,
  events-summary, event-detail). Cada uno comprueba sesión + `membershipIn` +
  `requireFinanceAdmin`; el guard del hook no cubre `/api`, así que la comprobación es
  explícita en cada endpoint. Filtros en query string con el mismo contrato del origen
  (`from,to,g,acc,ev` + `dims,q,exev,dupev,cat,rec` por pantalla), cap de 1000 filas del
  origen sustituido por paginación explícita (nunca truncar en silencio).

### Importación (multipart, sin estado entre peticiones)

Vercel es efímero entre invocaciones, así que `preview` y `confirm` reciben ambos el
fichero (el flujo del origen guardaba un `upload_id` en disco; aquí el cliente reenvía):

- `POST /api/v1/finance/imports/preview` — multipart; devuelve banco detectado, nº
  nuevas/duplicadas, muestra, `unknown_refs` (cuentas por crear).
- `POST /api/v1/finance/imports/confirm` — multipart + JSON de cuentas nuevas; parsea de
  nuevo (determinista por `dedup_hash`), inserta lote + transacciones y ejecuta el
  pipeline. Síncrono (1.000 filas ≪ 60 s de `maxDuration`); no encola trabajos.
  Los extractos NO se persisten en ningún almacenamiento.

### Comandos por `/api/v1/sync` (escrituras de negocio, idempotentes con `operationId`)

`finance.grant.write`, `finance.revoke.write`, `finance.account.update`,
`finance.category.create/update/delete`, `finance.category.assignConcept`,
`finance.rule.create/delete`, `finance.transaction.update` (categoría, estado+`create_rule`,
concepto, recurrencia, eventos), `finance.transactions.bulk`,
`finance.transactions.assignConceptRecurrence`, `finance.transaction.manual.create/delete`,
`finance.transaction.invest`, `finance.transfers.link/unlink`,
`finance.event.create/update/delete`, `finance.event.assignTransactions`,
`finance.event.assignConcept`, `finance.alias.update`, `finance.import.undo`.
Todos registrados en el dispatcher de `sync/+server.ts`, todos con `requireFinanceAdmin`
(los `grant/revoke` además exigen `access.manage`), errores en el diccionario compartido de
códigos, acuse veraz synced/queued/rejected/conflict vía `queueCommand`/`OptimisticActions`
y token de invalidación propio (`cc:finance`).

## 8. UI

Rutas bajo `/h/[householdId]/finanzas/…`: `finanzas` (Dashboard), `analitica`,
`movimientos`, `revision`, `eventos`, `importar`, `ajustes`. Alta coordinada en los 5
puntos obligatorios: `HOUSEHOLD_MODULES` + `MODULE_CAPABILITY` + `NESTED_ROUTE_CAPABILITY`
(routing), `NAV_ENTRIES` + ambos órdenes (AppShell; etiqueta «Finanzas»), `SECTION_LABELS`
(app-title), path SVG de trazo único en `NavIcon.svelte`, y las capacidades en contracts.

- **Dashboard**: 5 KPIs (Ingresos, Gastos con desglose ♻/✦/—, Ahorro con sparkline, Tasa de
  ahorro con enlace «N sin revisar», Inversión), deltas contra el periodo anterior, flujo
  de caja (barras ingresos/gastos + línea ahorro, 12 cubos hacia atrás), gasto por
  categoría (barras horizontales expandibles con «ver →»), top 10 proveedores.
- **Analítica**: KPIs ampliados (bruta/neta, free/ops cash flow), fila de medias
  mensuales, partidas (eventos) excluibles de KPIs y gráfica, gráfica apilada por
  naturaleza + líneas de ahorro, resumen mensual transpuesto, y **pivot completo**:
  secciones con bandas, dimensiones reordenables persistidas en URL, columnas
  Acumulado/Promedio/Ticket/mes ordenables, árbol expandible, buscador con chips tipados
  (atajo `/`), selección con Shift, **drag-and-drop** a categorías/eventos con toast
  «Deshacer», barra de acciones flotante (alternativa accesible/táctil al DnD) y panel de
  detalle.
- **Movimientos**: tabla ledger (fecha, cuenta, concepto con alias ✎ y ⇄, categoría
  inline, eventos, tipo, importe tabular), filtros locales, selección múltiple (eventos,
  vincular transferencia si suma 0), añadir manual, borrar manuales, panel de detalle con
  «Datos del origen» (`raw`).
- **Revisión**: pendientes/sugeridas con confirmación fila a fila o en bloque, checkbox
  «Regla» que crea regla al confirmar, badge de pendientes en la navegación del módulo.
- **Eventos**: crear/renombrar/borrar (desvincula, no borra), totales del periodo,
  desglose por categoría.
- **Importar**: fichero → previsualización (nuevas/duplicadas, cuentas desconocidas con
  formulario) → confirmar → historial con deshacer.
- **Ajustes del módulo**: cuentas (nombre, tipo, titular, aliases, `transfer_refs`),
  árbol de categorías, reglas (borrar), alias de proveedores. La concesión por admin vive
  en los Ajustes GENERALES del hogar (§4), no aquí.

**Sistema visual**: tokens y componentes de casa-clara (`app.css` por capas, linter de
tokens, Atkinson Hyperlegible, `.cifra` tabular, `.ledger-list`, `.summary-strip`,
`PageHeader`, chips y botones de la casa; nada de terracota fuera de «ahora»). El panel de
detalle reutiliza el patrón `modalDialog` accesible del AppShell. **Gráficas SVG
artesanales** en componentes Svelte propios (`lib/components/finance/`): barras, apiladas,
línea y sparkline con tokens; sin dependencias. Estados vacíos honestos («no hay datos» ≠
«no puedes verlo»). Copy en español según `docs/ux/sistema-movil.md`.

**Presupuestos**: todo el código de finanzas vive en el chunk de sus rutas (nada alcanza el
layout raíz ni el grafo inicial de Hoy — lo vigila `verify-today-bundle.mjs`); SheetJS es
solo-servidor; móvil primero con el breakpoint de la casa; `prefers-reduced-motion`
respetado. DnD con fallback completo por barra de acciones (axe serious/critical = 0).

## 9. Migración de datos (ETL) y retirada del sistema antiguo

Guion `packages/db/scripts/migrar-home-finance.mjs` (en el repo; los datos jamás):

1. **Antes de nada**: copia de seguridad datada de
   `/home/abf/github/home-finance/backend/data/finanzas.db` fuera del árbol de ambos repos.
2. Lee SQLite con `node:sqlite` (Node 24, sin dependencia nueva); escribe Postgres por
   conexión **directa 5432** con rol propietario (como las migraciones), en una sola
   transacción, mapeando enteros→UUID con tablas de correspondencia, fechas TEXT→`date`,
   JSON→`jsonb`, preservando `dedup_hash`, `transfer_group_id`, estados y prefijos.
   Parámetros: `--household <slug>` (el hogar real), `--dry-run`, `--verify-only`.
   Idempotencia: si el hogar ya tiene datos de finanzas, aborta salvo `--force-empty-check`.
3. **Informe de verificación** (obligatorio, se imprime y se guarda en local): conteos por
   tabla origen=destino; suma de `amount_cents` por cuenta y por mes idénticas; nº de
   grupos de transferencia y, por grupo, si suma 0 (los grupos descuadrados se cuentan y
   se listan como AVISO no bloqueante: el origen tiene patas huérfanas legítimas,
   `transfers.py::orphan_legs`); distribución de estados; min/max de fechas.
4. **Ensayo**: contra el Postgres 18.4 local en Docker (migraciones 0001–0036 + ETL +
   informe + smoke de la UI con ese hogar).
5. **Producción**: `pnpm db:migrate` en Supabase → ETL → informe → activar concesión a la
   cuenta de Alberto → comprobación visual de las 7 pantallas contra los números del
   informe (`backend/data/informe-semestre1-2026.md` como contraste adicional).
6. **Retirada**: `docker stop cf-finanzas && docker rm cf-finanzas`; retirar las variables
   `FINANZAS_AUTH_*` del `.env` del repo viejo (credenciales quemadas); `pnpm backup:full`
   de casa-clara con los datos ya migrados; nota en el repo home-finance (README) de que el
   sistema queda congelado y dónde vive ahora. Los extractos de `samples/` se conservan en
   esta máquina como archivo personal (no se suben a ningún sitio).

## 10. Seguridad de los datos financieros

- RLS de doble cerrojo (§4) verificada por la matriz negativa ampliada; `tests/010` impide
  tablas sin RLS; los roles de ejecución siguen NOBYPASSRLS y sin propiedad.
- Ningún dato real en el repo: fixtures y muestras de parsers **sintéticas** (extractos
  fabricados a mano con importes y titulares inventados, formato idéntico al real);
  `ALLOW_SYNTHETIC_DATA_ONLY` sigue aplicando. La regla del origen se mantiene: la BD
  SQLite y `samples/` nunca entran en git.
- Extractos subidos: se procesan en memoria y no se persisten; sin bucket nuevo.
- Auditoría: toda mutación de finanzas pasa por los triggers de `audit_events` con autoría.
- Sin superficies nuevas sin autenticar: los endpoints REST comprueban sesión + membresía +
  concesión uno a uno; el catch-all del origen y su cookie compartida desaparecen con la
  retirada; secretos antiguos quemados.
- El manual de la casa y la skill `operar-la-casa` se actualizan con el módulo (quién lo ve,
  cómo se concede, cómo se importa el mes).

## 11. Pruebas y CI

- **Unit (vitest)**: dominio completo de `packages/domain/src/finance/` (transferencias,
  recurrencia, KPIs, pivot con los casos del original, dedup, reglas, provider-norm);
  parsers con muestras sintéticas (sin `skip` silencioso: las muestras van al repo);
  pipeline unificado con un caso integral.
- **SQL**: `tests/010` (cobertura RLS automática) + sección nueva en `020_rls_matrix.sql`
  (§4) + fixtures de finanzas para roble y olivo.
- **dbe2e (`*.dbe2e.ts`)**: importar→previsualizar→confirmar→deshacer contra Postgres
  real; comandos de escritura con acuse; concesión/revocación cambiando lo visible.
- **e2e + a11y (fixture)**: navegación de las 7 pantallas como admin-con-concesión; 403/404
  para el resto de roles y para admin sin concesión; axe serious/critical = 0 en Dashboard,
  Movimientos y Analítica (añadidas a la suite crítica).
- **CI**: cada spec nueva cableada a un job de `.github/workflows/ci.yml`
  (`assert-suite-coverage.py` lo exige); `verify-today-bundle.mjs` y Lighthouse deben
  seguir verdes (finanzas no toca el arranque).

## 12. Fases de implementación

1. **Cimientos** — contracts (capacidad + tipos de comando), migración `0036`, RLS +
   fixtures + matriz negativa, `requireFinanceAdmin`, routing + nav + página esqueleto,
   tarjeta de concesiones en Ajustes.
2. **Dominio y parsers** — `domain/finance` completo con tests; parsers + pipeline en
   `server/finance` con muestras sintéticas.
3. **ETL** — guion + ensayo local + informe de verificación.
4. **UI de lectura** — barra de filtros, Dashboard, Movimientos (lectura), panel de
   detalle, gráficas SVG.
5. **UI de escritura** — Revisión, edición en Movimientos, Eventos, Importar, Ajustes del
   módulo; comandos + outbox.
6. **Analítica** — KPIs ampliados, resumen mensual, gráfica apilada, pivot completo con
   DnD + barra de acciones.
7. **Endurecimiento y entrega** — a11y/e2e/dbe2e, presupuestos, manual + runbook de
   migración, despliegue, migración real, retirada del sistema antiguo.

Cada fase deja la rama verde (todos los gates de CI) y se ejecutará con equipos de
subagentes según el plan de implementación (documento aparte, skill writing-plans).

## 13. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Única copia de la BD origen en esta máquina | Copia de seguridad datada ANTES de cualquier otra cosa (fase 3, paso 1). |
| Producción viva con familia real | Ensayo completo en Postgres local; migración `0036` probada contra base con datos; ETL con `--dry-run` e informe obligatorio. |
| Fuga de acceso a datos financieros | Doble cerrojo en RLS + matriz negativa con casos explícitos + revisión de seguridad en fase 7. |
| Parsers TS divergen del comportamiento Python | Muestras sintéticas por banco con resultados esperados extraídos del comportamiento real del origen; verificación cruzada durante el ETL (los datos migrados YA pasaron por los parsers Python: los hashes deben coincidir con los que produce el TS sobre las mismas cadenas). |
| Pivot complejo (DnD) con regresiones | Portar también sus tests (`pivotTree`, selección, dnd); barra de acciones como camino equivalente verificado por e2e. |
| Presupuesto de arranque de Hoy | Todo finanzas en chunks de ruta; SheetJS solo-servidor; `verify-today-bundle.mjs` en CI. |
| El orden del pipeline post-import es semántica | Función única con test integral que fija el orden. |
