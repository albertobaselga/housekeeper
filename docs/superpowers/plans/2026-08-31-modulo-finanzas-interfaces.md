# Módulo Finanzas — interfaces canónicas y restricciones globales

Este documento acompaña a la spec (`docs/superpowers/specs/2026-08-31-modulo-finanzas-design.md`)
y a los 7 planes de fase (`2026-08-31-modulo-finanzas-fase-*.md`). Fija los nombres, rutas y
firmas que cruzan fronteras de fase. **Ningún plan puede renombrar lo que aparece aquí**; lo
que no aparece es decisión local de cada fase siguiendo los patrones del repo.

## Restricciones globales (aplican a TODAS las tareas de TODOS los planes)

- Trabajar SOLO dentro del worktree `/home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas`
  (rama `worktree-modulo-finanzas`). El repo `/home/abf/github/home-finance` es solo-lectura
  (fuente a portar).
- Node 24 obligatorio: prefijo `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`
  antes de cualquier `pnpm`/`node`.
- Dinero: céntimos como `bigint` (TS) / `bigint` (SQL), NUNCA `Number`/float; solo EUR.
- Idioma: UI, copy, docs y commits en español (`tipo(ámbito): qué cambia`); identificadores en inglés.
- Solo datos sintéticos en el repo (importes, titulares, extractos de prueba inventados).
- Migraciones append-only `00NN_*.sql`, un solo bloque `BEGIN;…COMMIT;`; jamás editar una aplicada.
- Toda spec nueva (unit/e2e/a11y/dbe2e/SQL) cableada a un job de `.github/workflows/ci.yml`
  (lo exige `scripts/ci/assert-suite-coverage.py`).
- CSS solo con tokens de `apps/web/src/app.css` (vigila `apps/web/scripts/lint-css-tokens.mjs`);
  pesos 400/500/700; terracota solo para «ahora».
- Única dependencia nueva permitida: `xlsx` (SheetJS), SOLO en `packages/server` (jamás en cliente).
- La matriz de capacidades NO se reexporta desde la raíz de `@housekeeper/contracts`
  (vigila `apps/web/scripts/verify-today-bundle.mjs`).
- Escrituras de negocio SOLO como comandos por `POST /api/v1/sync`; REST solo para lecturas
  y para la importación multipart.
- TDD: test que falla → implementación mínima → verde → commit. Commits frecuentes.
- Suites de BD en secuencia (bases/roles de nombre fijo); Postgres local 18.4 en Docker para
  db-tests/dbe2e; PRODUCCIÓN (Supabase) prohibida en fases 1–6; en fase 7 solo con
  confirmación explícita de Alberto.
- **El proyecto se llama Housekeeper** (antes Casa Clara): los paquetes son `@housekeeper/*`.
  ⚠️ Los **roles de base de datos NO se renombraron** y siguen siendo `casa_clara_app`,
  `casa_clara_worker` y `casa_clara_app_login` (viven en migraciones ya aplicadas): no los toques.
- **Numeración de migraciones**: `main` ocupó `0034_close_due_notice.sql` y
  `0035_settlement_receipt_document.sql`, así que las nuestras son **`0036_finance.sql`** y
  **`0037_finance_endurecimiento.sql`**. El siguiente número libre es el `0038`.
- **Clúster de pruebas de esta máquina**: contenedor `casaclara-it-pg` (`postgres:18.4-alpine`)
  en `127.0.0.1:5439`, usuario `ci_admin`, contraseña `ci-only-password`.
  ⚠️ **El contenedor y sus bases son efímeros**: algo en esta máquina los ha borrado a mitad de
  una ejecución al menos una vez. **No des por hecho que existen**: compruébalo al empezar y
  recréalo si hace falta —
  `docker run -d --name casaclara-it-pg -e POSTGRES_USER=ci_admin -e POSTGRES_PASSWORD=ci-only-password -e POSTGRES_DB=casaclara_ci_integration -p 5439:5432 postgres:18.4-alpine`—
  y crea con `createdb` la base desechable que vayas a usar. Nunca uses `casaclara_dev` para las
  baterías de navegador: su preparación hace `DROP SCHEMA app CASCADE` sobre la base indicada.
  ⚠️ **Prohibido el puerto 54329**, aunque lo documenten el README y los valores por omisión de
  `apps/web/package.json`: en esta máquina lo ocupa la base de datos embebida de **Paperclip**
  (`/home/abf/.paperclip/instances/default/db`), otra aplicación. Migrar o escribir ahí
  corrompería datos ajenos. Exporta SIEMPRE `TEST_DATABASE_URL`/`E2E_DATABASE_URL`/`DATABASE_URL`
  de forma explícita; nunca dependas del valor por omisión de un script.
- Gates de la rama: `pnpm lint`, `pnpm typecheck`, `pnpm check`, `pnpm test`, `pnpm test:db`,
  `pnpm test:rls` deben quedar en verde al cerrar cada tarea que los afecte.

## Mapa de ficheros por paquete

### packages/contracts
- `src/capabilities.ts` (modificar): añadir `"finance.access"` a `capabilities` (orden
  alfabético: entre `"export.employment.self"` y `"guide.write"`). Ningún rol lo lista
  explícitamente: `family_admin` lo hereda de `allCapabilities`.
- Tipos/esquemas de payloads de comandos de finanzas: donde el repo los tenga hoy para
  `expense.*`/`payment.*` (seguir el patrón existente, mismo fichero/carpeta).

### packages/db
- `migrations/0036_finance.sql` (crear): tablas de §5 de la spec + función
  `app.finance_enabled()` + políticas RLS + grants a `casa_clara_app` + triggers de
  auditoría + índice parcial único de categoría `transferencia` raíz por hogar.
- `fixtures/002_finance.sql` (crear): datos sintéticos de finanzas para los dos hogares
  fixture (roble y olivo) + concesión viva solo para el admin de roble.
- `tests/030_finance_rls.sql` (crear): suite TAP de la matriz negativa de finanzas
  (cumple §4 de la spec: admin-con-concesión ve; admin-sin-concesión 0 filas; los otros 4
  roles 0 filas; cero fugas roble↔olivo; suplantación falla 42501).
- `scripts/migrar-home-finance.mjs` (crear, fase 3): ETL SQLite→Postgres.

### packages/domain
- `src/finance/types.ts`, `provider-norm.ts`, `rules.ts`, `transfers.ts`, `amex.ts`,
  `investments.ts`, `cash.ts`, `recurrence.ts`, `event-rules.ts`, `kpis.ts`, `pivot.ts`,
  `dedup.ts`, `index.ts` (crear). Puro: sin `pg`, sin `fetch`, sin reloj, sin `node:crypto`.
- Tests junto al código siguiendo el patrón del paquete.

### packages/server
- `src/finance/parsers/{index,caixabank,deutschebank,openbank,amex}.ts` (crear).
- `src/finance/dedup-hash.ts` (crear): sha256 sobre la cadena canónica del dominio.
- `src/finance/pipeline.ts` (crear): pipeline post-import unificado.
- `src/finance/queries.ts` (crear): lecturas SQL compartidas por loads y endpoints REST.
- `src/commands/finance.ts` (crear): handlers de comandos + `requireFinanceAdmin`.
- Export del subpath que corresponda siguiendo `package.json` del paquete.

### apps/web
- `src/lib/auth/routing.ts` (modificar): `HOUSEHOLD_MODULES` += `finanzas`;
  `MODULE_CAPABILITY.finanzas = "finance.access"`; `NESTED_ROUTE_CAPABILITY` para
  `analitica`, `movimientos`, `revision`, `eventos`, `importar`, `ajustes`.
- `src/routes/h/[householdId]/+layout.server.ts` (modificar): retirar `finance.access` de
  las capacidades entregadas si la membresía no tiene concesión viva.
- `src/lib/components/AppShell.svelte` (modificar): entrada «Finanzas» en `NAV_ENTRIES` y
  en ambos órdenes; `src/lib/app-title.ts` (`SECTION_LABELS`); `src/lib/components/NavIcon.svelte`
  (path SVG nuevo).
- `src/lib/finance/` (crear): `filters.ts`, `api.ts`, `format.ts` (reexporta/envuelve
  `formatCents`), `pivot-state.ts`.
- `src/lib/components/finance/` (crear): `FinanceFilterBar.svelte`,
  `CashflowChart.svelte`, `NatureStackChart.svelte`, `FinanceSparkline.svelte`,
  `CategoryBars.svelte`, `LedgerTable.svelte`, `CategorySelect.svelte`,
  `EventPicker.svelte`, `RecurrenceChip.svelte`, `FinanceDetailPanel.svelte`,
  `PivotTable.svelte`, `PivotActionBar.svelte`.
- `src/routes/h/[householdId]/finanzas/` (crear): `+page.server.ts` + `+page.svelte`
  (Dashboard) y subcarpetas `analitica/`, `movimientos/`, `revision/`, `eventos/`,
  `importar/`, `ajustes/` (cada una con su par server/svelte).
- `src/routes/api/v1/finance/` (crear): endpoints GET de lectura + POST de importación
  (lista más abajo).
- `src/routes/h/[householdId]/settings/` (modificar): tarjeta «Finanzas» de concesiones.

## Tipos canónicos (packages/domain/src/finance/types.ts)

```ts
export type FinanceBank = "caixabank" | "deutsche_bank" | "openbank" | "amex";
export type FinanceAccountKind = "comun" | "personal" | "inversion";
export type FinanceCategoryKind = "gasto" | "ingreso" | "transferencia";
export type FinanceTransactionStatus =
  "pendiente" | "sugerida_regla" | "sugerida_agente" | "confirmada";
export type FinanceRuleType = "proveedor_exacto" | "concepto_contiene" | "codigo_norma43";
export type FinanceRecurrence = "recurrente" | "extraordinario" | null;

/** Fila normalizada que producen los parsers (fechas ISO yyyy-mm-dd). */
export interface ParsedRow {
  accountRef: string;          // CCC/IBAN/nº de cuenta detectado por fila o cabecera
  bankRef: string;
  opDate: string;
  valueDate: string | null;
  concept: string;
  provider: string | null;
  amountCents: bigint;
  balanceCents: bigint | null;
  codeCommon: string | null;
  codeOwn: string | null;
  dedupRef: string | null;     // solo Amex (columna Referencia)
  bankCategory: string | null; // extensión fase 2: columna «Categoría» de Amex → bank_category
  raw: Record<string, string>; // cabecera→valor del fichero original
}

export interface ParsedStatement {
  bank: FinanceBank;
  accountRefs: string[];       // refs únicas detectadas en el fichero
  rows: ParsedRow[];
}

/** Vista de transacción que consumen las heurísticas puras del dominio. */
export interface FinanceTxView {
  id: string;
  accountId: string;
  opDate: string;
  concept: string;
  provider: string | null;
  providerNorm: string | null;
  amountCents: bigint;
  categoryId: string | null;
  status: FinanceTransactionStatus;
  transferGroupId: string | null;
  recurrence: FinanceRecurrence;
  recurrenceManual: boolean;
  dedupHash: string;
  // Extensión fase 2 (port fiel del origen; se rellenan desde SQL con join a categorías):
  codeCommon: string | null;
  codeOwn: string | null;
  categoryKind: FinanceCategoryKind | null;
}
```

Extensiones fase 2 sobre los tipos canónicos anteriores (añadidos, no renombres): las
lecturas SQL de las fases 4–6 deben incluir el `left join app.finance_categories` para
poblar `categoryKind` en `FinanceTxView`. Los tipos auxiliares definidos en
`types.ts`/`pivot.ts` se alinean con el esquema de la fase 1 (resolución canónica 6):
`FinanceAccountView.bank: FinanceBank | null` y `FinanceEventRuleView.providerNorm: string
| null`; `PivotSourceRow.kind` (pivot.ts) admite además `"inversion"`.

## Funciones canónicas del dominio

```ts
// dedup.ts — cadena canónica; el sha256 lo aplica packages/server
export function dedupKey(row: {
  bankRef: string; opDate: string; amountCents: bigint;
  concept: string; balanceCents: bigint | null; dedupRef: string | null;
}): string;

// provider-norm.ts
export function normalizeProvider(concept: string): { provider: string | null; providerNorm: string | null };
export function paypalVendor(provider: string): string | null;

// rules.ts
export function matchRule(tx: FinanceTxView, rules: FinanceRuleView[]): FinanceRuleView | null;

// transfers.ts
export function detectTransferPairs(txs: FinanceTxView[], accounts: FinanceAccountView[]):
  TransferProposal[];

// amex.ts
export function reconcileAmex(txs: FinanceTxView[], accounts: FinanceAccountView[]): TransferProposal[];

// investments.ts
// `opts.cashAccountId` es OBLIGATORIO y lo resuelve el servidor: el esquema no
// admite `bank = 'efectivo'`, así que el dominio no puede deducir esa cuenta sola.
export function detectInvestmentContributions(
  txs: FinanceTxView[],
  accounts: FinanceAccountView[],
  opts: { cashAccountId: string | null },
): InvestmentMirrorProposal[];

// cash.ts
export function detectCashMovements(
  txs: FinanceTxView[],
  accounts: FinanceAccountView[],
  opts: { cashAccountId: string | null },
): CashProposal[];

// recurrence.ts
export function assessRecurrence(txs: FinanceTxView[]): RecurrenceVerdict[];

// kpis.ts
export interface RangeSummary {
  incomeCents: bigint; expenseCents: bigint; recurringExpenseCents: bigint;
  extraordinaryExpenseCents: bigint; unclassifiedExpenseCents: bigint;
  savingsCents: bigint; netSavingsRate: number | null; grossSavingsRate: number | null;
  investedCents: bigint; investmentRate: number | null;
  freeCashFlowCents: bigint; opsCashFlowCents: bigint;
  receivedContributionsCents: bigint; outgoingTransfersCents: bigint;
  pendingCount: number;
  prev: RangeSummary | null;
}
export function computeRangeSummary(txs: FinanceTxView[], opts: SummaryOptions): RangeSummary;

// pivot.ts
export type PivotDimension = "cat" | "sub" | "nat" | "prov" | "concept" | "movement";
export type PivotSection = "INGRESOS" | "GASTOS" | "EVENTOS" | "INTERNAS" | "INVERSION";
export function buildPivotTree(rows: PivotSourceRow[], dims: PivotDimension[], opts: PivotOptions): PivotTree;
```

Los tipos auxiliares (`FinanceRuleView`, `FinanceAccountView`, `TransferProposal`,
`InvestmentMirrorProposal`, `CashProposal`, `RecurrenceVerdict`, `SummaryOptions`,
`PivotSourceRow`, `PivotOptions`, `PivotTree`) se definen en `types.ts`/`pivot.ts` en la
fase 2 y los consumen tal cual las fases 4–6.

## Funciones canónicas del servidor

```ts
// packages/server/src/finance/parsers/index.ts
export function detectBank(bytes: Uint8Array, filename: string): FinanceBank | null;
export function parseStatement(bytes: Uint8Array, filename: string): ParsedStatement; // lanza FinanceParserError

// packages/server/src/finance/dedup-hash.ts
export function computeDedupHash(row: Parameters<typeof dedupKey>[0]): string; // sha256 hex

// packages/server/src/finance/pipeline.ts — dentro de la transacción autorizada
export async function runPostImportPipeline(client: PoolClient, householdId: string): Promise<PipelineReport>;
// Orden FIJO: reglas → alias PayPal → Amex → inversiones → transferencias → efectivo → recurrencia → reglas de evento

// packages/server/src/commands/finance.ts
export function requireFinanceAdmin(/* mismo shape que requireAdmin + concesión viva */): void;
```

## Comandos de sync (nombres exactos de `kind`)

`finance.grant.write` · `finance.revoke.write` · `finance.account.update` ·
`finance.category.create` · `finance.category.update` · `finance.category.delete` ·
`finance.category.assignConcept` · `finance.rule.create` · `finance.rule.delete` ·
`finance.transaction.update` · `finance.transactions.bulk` ·
`finance.transactions.assignConceptRecurrence` · `finance.transaction.manual.create` ·
`finance.transaction.manual.delete` · `finance.transaction.invest` ·
`finance.transfers.link` · `finance.transfers.unlink` · `finance.event.create` ·
`finance.event.update` · `finance.event.delete` · `finance.event.assignTransactions` ·
`finance.event.assignConcept` · `finance.alias.update` · `finance.import.undo`

Token de invalidación del cliente: `cc:finance`.

## Endpoints REST (todas comprueban sesión + membresía + `requireFinanceAdmin`)

- `GET /api/v1/finance/summary?household=…&from=…&to=…&g=…&acc=…&ev=…&exev=…`
- `GET /api/v1/finance/series` (mismos filtros + `months`)
- `GET /api/v1/finance/analytics` · `GET /api/v1/finance/pivot` (+`dims`,`dupev`)
- `GET /api/v1/finance/breakdown` · `GET /api/v1/finance/providers` (+`limit`)
- `GET /api/v1/finance/transactions` (+`q`,`cat`,`rec`,`status`,`ids`,`group_ids`,
  paginación explícita `limit`/`offset` con `total` en la respuesta — nunca truncar en silencio)
- `GET /api/v1/finance/events-summary` · `GET /api/v1/finance/events/[id]`
- `POST /api/v1/finance/imports/preview` (multipart: `file`)
- `POST /api/v1/finance/imports/confirm` (multipart: `file` + `payload` JSON con cuentas nuevas)

Filtros de URL en cliente (`apps/web/src/lib/finance/filters.ts`): claves `from`, `to`,
`g` (`month|quarter|year`), `acc` (CSV), `ev`, `exev` (CSV), `dims` (CSV), `q`, `cat`,
`rec`, `dupev` — merge no destructivo sobre el query string (contrato del original).

## Esquema SQL: nombres de tablas y columnas clave

Tablas (esquema `app`, todas con `household_id uuid NOT NULL REFERENCES app.households`,
PK `(household_id, id)` con `id uuid DEFAULT gen_random_uuid()`, RLS ENABLE+FORCE, GRANT a
`casa_clara_app`, trigger de auditoría):

`finance_module_grants` (membership_id, granted_by_membership_id, granted_at,
revoked_at, revoked_by_membership_id) · `finance_accounts` (name, bank, kind,
owner_label, bank_ref, owner_aliases jsonb, transfer_refs jsonb, archived_at) ·
`finance_categories` (parent_id, name, kind) · `finance_rules` (rule_type, pattern,
category_id, priority, origin) · `finance_import_batches` (filename, bank, imported_at,
new_count, dup_count) · `finance_transactions` (account_id, batch_id, op_date, value_date,
concept, provider, provider_norm, amount_cents, balance_cents, code_common, code_own,
category_id, status, transfer_group_id, dedup_hash, recurrence, recurrence_manual,
bank_category, raw jsonb, currency_code CHECK='EUR') · `finance_provider_aliases`
(provider_norm, display) · `finance_events` (name) · `finance_transaction_events`
(transaction_id, event_id) · `finance_event_rules` (provider_norm, concept_norm, category_id).

Función de cerrojo: `app.finance_enabled() RETURNS boolean` (rol `family_admin` Y concesión
viva para `app.current_membership_id()`). Todas las políticas `finance_*` la exigen salvo
`finance_module_grants` (legible por cualquier admin del hogar; mutable solo vía comandos).

## Resoluciones canónicas (auditoría del 2026-09-01) — MANDAN sobre lo que diga cualquier plan

La auditoría cruzada de los 7 planes encontró contradicciones entre fases. Estas son las
decisiones firmes; cada plan se corrigió para cumplirlas. Ante cualquier duda futura, esta
sección gana.

1. **Imports del dominio**: SIEMPRE por el subpath `@housekeeper/domain/finance`, nunca desde
   la raíz `@housekeeper/domain` (que no reexporta finanzas, por presupuesto de bundle).
2. **Lecturas de Analítica y pivot**: las produce la FASE 4 en
   `packages/server/src/finance/queries.ts`, con estas firmas exactas, y la fase 6 solo las consume:
   - `readFinanceAnalytics(client, householdId, filters): Promise<{ rows: AnalyticsRow[] }>`
     donde `AnalyticsRow = { kind: 'gasto'|'ingreso'|'inversion'; monthly: Record<string, { totalCents: string; recCents: string; extCents: string }> }`
   - `readFinancePivot(client, householdId, filters): Promise<{ months: string[]; rows: PivotSourceRow[] }>`
   La fase 4 crea también `apps/web/src/routes/api/v1/finance/analytics/+server.ts` y
   `.../pivot/+server.ts` (este parsea `dims` y `dupev`) y sus métodos en `$lib/finance/api.ts`.
3. **`buildPivotTree`**: tercer argumento `{ monthsCount: number; dupEventIds?: ReadonlySet<string> }`
   (nunca `{ months }`).
4. **Propiedad de ficheros compartidos** (quien CREA / quien MODIFICA):
   - `apps/web/src/lib/finance/commands.ts` → crea fase 1 (`grantFinanceAccess`,
     `revokeFinanceAccess`); fase 5 lo **modifica** para añadir `financeCommand`.
   - `apps/web/tests/finance-commands.test.ts` → crea fase 1; fase 5 lo **modifica**.
   - `apps/web/src/lib/finance/pivot-state.ts` → crea fase 4 con
     `PIVOT_DIMENSIONS`, `DEFAULT_DIMS`, `parseDims(param): PivotDimension[]`,
     `serializeDims(dims): string | null`; fase 6 lo **modifica** conservando esos nombres y
     el retorno `string | null` (nada de `ALL_DIMS`/`dimsToParam`).
   - `apps/web/e2e/finanzas.e2e.ts` → crea fase 4; fase 7 lo **modifica** (añade al final).
   - `apps/web/e2e/finanzas-importar.dbe2e.ts` → crea fase 5; fase 7 lo **modifica** o lo
     omite (nunca lo reescribe).
5. **Payloads de comando** (manda el esquema Zod de la fase 5; la fase 6 se alinea):
   - `finance.transactions.bulk`: `{ kind, transactionIds: string[], categoryId?, status? }` —
     `status` es **opcional** (permite cambiar solo la categoría en bloque).
   - `finance.transaction.invest`: `{ kind, transactionId, accountId }` (nunca `txId`).
   - Añadir evento en bloque → `finance.event.assignTransactions`
     `{ kind, eventId, transactionIds, action: 'add'|'remove' }`; fijar naturaleza →
     `finance.transactions.assignConceptRecurrence`.
6. **Vocabulario de `bank`**: `finance_accounts.bank` es NULL para cuentas sin banco
   (Efectivo, inversión, manuales) y el CHECK admite solo los cuatro bancos reales;
   `finance_import_batches.bank` admite además `'manual'`. El ETL (fase 3) **traduce**
   `efectivo`/`inversion`/`manual` del origen a NULL en cuentas y falla con mensaje claro ante
   un valor no contemplado. El dominio (fase 2) identifica la cuenta de inversión por
   `kind === 'inversion'` y la de efectivo por `cashAccountId` explícito (nunca por `bank`).
7. **Categorías**: `UNIQUE NULLS NOT DISTINCT (household_id, parent_id, name)` y trigger que
   impide un tercer nivel (árbol de 2 niveles, spec §5). La **fase 1** siembra de forma
   idempotente el árbol de categorías del hogar —incluida la única raíz `kind='transferencia'`—
   al conceder Finanzas por primera vez en ese hogar (portando `home-finance/backend/app/seed.py`).
8. **`raw`**: la columna es `jsonb NOT NULL DEFAULT '{}'`; el ETL coalesce `NULL → '{}'`.
9. **`FinanceTxView` completo en las lecturas**: `queries.ts` debe traer `code_common`,
   `code_own` y el `kind` de la categoría (`categoryKind`) y tipar sin aserciones `as`;
   `computeRangeSummary` recibe TODAS las transacciones del hogar (el filtrado es interno).
10. **`SummaryOptions`** son exactamente `{ from, to, accounts, accountIds?, eventId?,
    excludeEventIds?, eventIdsByTx? }`.
11. **Códigos de error de acceso**: **403** en ruta declarada sin capacidad («Esta parte la
    lleva la familia.»); **404** solo en ruta hija NO declarada. Todos los e2e se alinean.
12. **CLI del ETL** (produce fase 3, consume fase 7):
    `node packages/db/scripts/migrar-home-finance.mjs --sqlite <ruta> --database-url <url>
    --household <slug> --backup-dir <dir> [--dry-run|--verify-only]`. `--sqlite` y
    `--database-url` son obligatorios; el guion NO lee `DATABASE_URL` del entorno.
13. **Runbook de migración**: `docs/runbooks/migracion-home-finance.md` (nombre único).
14. **Muestras de extractos**: se GENERAN por código
    (`packages/server/src/finance/parsers/synthetic-samples.ts`); nunca ficheros binarios en git.
    Los e2e cargan el fichero en memoria con `setInputFiles({ name, mimeType, buffer })`.
15. **`E2E_DATABASE_URL` explícita siempre** antes de `pnpm test:e2e:db`
    (`postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_wt_u`): el valor por
    omisión del `package.json` apunta al 54329 prohibido.

## Dependencias entre fases

| Fase | Consume | Produce |
|---|---|---|
| 1 Cimientos | — | Esquema 0036 vivo, capacidad, `requireFinanceAdmin`, routing+nav+páginas esqueleto, tarjeta de concesiones, fixtures, suite RLS 030 |
| 2 Dominio y parsers | tipos de fase 1 (solo contratos) | `domain/finance` completo, parsers, `computeDedupHash`, pipeline |
| 3 ETL | esquema (1), `computeDedupHash` + parsers (2, para verificación cruzada) | `migrar-home-finance.mjs` + runbook de ensayo local |
| 4 UI lectura | 1 (routing/esquema), 2 (kpis/pivot vía `queries.ts`) | FilterBar, Dashboard, Movimientos (lectura), DetailPanel, endpoints GET, gráficas SVG |
| 5 UI escritura | 1, 2 (pipeline), 4 (componentes) | comandos + Revisión, edición, Eventos, Importar, Ajustes del módulo |
| 6 Analítica | 2 (pivot), 4 (infra UI) | Analítica completa + PivotTable con DnD + PivotActionBar |
| 7 Endurecimiento | todas | a11y/e2e/dbe2e completos, CI, manual+runbooks, despliegue, migración real (con confirmación), retirada |

Paralelismo permitido en ejecución: 2 ∥ 1 (el dominio no toca la BD); 3 tras 1+2;
4 tras 1+2; 5 tras 4 (comparte componentes); 6 tras 4 (∥ 5); 7 al final.
