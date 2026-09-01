# ETL de migración home-finance → casa-clara — Plan de implementación (Fase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guion `packages/db/scripts/migrar-home-finance.mjs` que migra la SQLite de home-finance a Postgres en una sola transacción con informe de verificación obligatorio, más tests contra Postgres local con SQLite sintética y el runbook del ensayo.

**Architecture:** El ETL es un guion Node puro en `packages/db/scripts` (patrón `migrate.mjs`): lee SQLite con `node:sqlite`, escribe Postgres con `pg` por conexión directa de propietario, y verifica cruzando los `dedup_hash` con el `computeDedupHash` de fase 2, cargado desde `.mjs` mediante un hook de resolución `.js→.ts` sobre el type-stripping de Node 24 (mecanismo ya verificado en este worktree). Los tests son `.test.mjs` de vitest en `packages/db` (patrón `migrate-with-history.test.mjs`) contra una SQLite sintética con la DDL del origen (`/home/abf/github/home-finance/backend/app/models.py`).

**Tech Stack:** Node 24 (`node:sqlite`, `module.registerHooks`, type stripping), `pg` 8.22.0, vitest 3.2.4, Postgres 18.4 en Docker, markdown.

**Spec:** /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/specs/2026-08-31-modulo-finanzas-design.md — con /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/plans/2026-08-31-modulo-finanzas-interfaces.md

## Global Constraints

- Trabajar SOLO dentro del worktree `/home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas`; el repo `/home/abf/github/home-finance` es solo-lectura.
- Node 24 obligatorio: prefijo `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"` antes de cualquier `pnpm`/`node`.
- Dinero: céntimos como `bigint` (TS) / `bigint` (SQL), NUNCA `Number`/float; solo EUR.
- Idioma: UI, copy, docs y commits en español (`tipo(ámbito): qué cambia`); identificadores en inglés.
- Solo datos sintéticos en el repo.
- Migraciones append-only `00NN_*.sql`, un solo bloque `BEGIN;…COMMIT;`; jamás editar una aplicada.
- Toda spec nueva cableada a un job de `.github/workflows/ci.yml` (lo exige `scripts/ci/assert-suite-coverage.py`).
- CSS solo con tokens de `apps/web/src/app.css`; pesos 400/500/700; terracota solo para «ahora».
- Única dependencia nueva permitida: `xlsx` (SheetJS), SOLO en `packages/server`. Esta fase no añade NINGUNA.
- La matriz de capacidades NO se reexporta desde la raíz de `@housekeeper/contracts`.
- Escrituras de negocio SOLO como comandos por `POST /api/v1/sync`; REST solo lecturas + importación multipart.
- TDD: test que falla → implementación mínima → verde → commit. Commits frecuentes.
- Suites de BD en secuencia; Postgres local 18.4 en Docker; PRODUCCIÓN (Supabase) prohibida en fases 1–6; en fase 7 solo con confirmación explícita de Alberto.
- Gates: `pnpm lint`, `pnpm typecheck`, `pnpm check`, `pnpm test`, `pnpm test:db`, `pnpm test:rls` en verde al cerrar cada tarea que los afecte.

**Notas de fase (léelas antes de cualquier tarea):**
- Esta fase consume el esquema `0036_finance.sql` (fase 1) y `packages/server/src/finance/dedup-hash.ts` de fase 2 con firma `computeDedupHash(row: { bankRef: string; opDate: string; amountCents: bigint; concept: string; balanceCents: bigint | null; dedupRef: string | null }): string`.
- CI: los `.test.mjs` de `packages/db/scripts/` los descubre `packages/db/vitest.config.mjs` (`include: ['scripts/**/*.test.mjs']`, `fileParallelism: false`) y los ejecuta el job `database` de `ci.yml` con `scripts/ci/run-tests-nonempty.sh pnpm test:import` (línea 115 del workflow). **Ojo con el mito de `runIf`**: `packages/db` NO expone script `test`, así que `pnpm test` (`pnpm -r --if-present test`) del job `unit` no ejecuta nada de este paquete; `describe.runIf(Boolean(process.env.TEST_DATABASE_URL))` sirve para poder correr `pnpm test:import` en local sin Postgres, no para saltar el job `unit`. Consecuencia práctica: `migrar-home-finance.test.mjs` (que no necesita base) también corre solo en el job `database`, y eso es aceptable. No hay que tocar `ci.yml`: el inventario de `assert-suite-coverage.py` excluye `packages/{domain,contracts,db}` a propósito (comentario de las líneas 310-318 del workflow) porque su evidencia sale de `run-tests-nonempty.sh` en los jobs `unit` y `database`.
- Postgres local para las tareas 5–7 (una sola vez):

```bash
# Clúster compartido de pruebas de esta máquina (ya levantado; la base casaclara_etl ya existe).
docker start casaclara-it-pg 2>/dev/null || true
until docker exec casaclara-it-pg pg_isready -U ci_admin; do sleep 1; done
export TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_etl"
```

⚠️ **Nunca uses el puerto 54329** (valor por omisión del README y de `package.json`): en esta máquina lo ocupa la base embebida de Paperclip, otra aplicación. Exporta siempre la variable explícitamente.

---

### Task 1: Cargador de módulos TS para guiones node (`cargar-ts.mjs`)

**Files:**
- Create: `packages/db/scripts/cargar-ts.mjs`
- Test: `packages/db/scripts/cargar-ts.test.mjs`

**Interfaces:**
- Consumes: `computeDedupHash` (fase 2, `packages/server/src/finance/dedup-hash.ts`).
- Produces: `export const rutaDedupHash: URL`; `export async function importarModuloTs(url): Promise<Record<string, unknown>>`.

**Contexto:** los TS del monorepo importan con extensión `.js` (`packages/domain/src/index.ts`: `export * from "./errors.js"`). El type stripping de Node 24 no reescribe especificadores, así que `node` a pelo falla; `module.registerHooks` con reintento `.js→.ts` lo resuelve (verificado con Node v24.15.0 sobre la cadena de `@housekeeper/domain`). El hook exige `import()` dinámico: los import estáticos se resuelven antes de evaluar el módulo que instala el hook.

- [ ] **Step 1: Test que falla** — crear `packages/db/scripts/cargar-ts.test.mjs`:

```js
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeDedupHash } from '../../server/src/finance/dedup-hash.ts';

const guion = fileURLToPath(new URL('./cargar-ts.mjs', import.meta.url));
const FILA_SONDA = {
  bankRef: '00490001512345678901', opDate: '2026-01-10', amountCents: -2550n,
  concept: 'COMPRA SONDA', balanceCents: 150000n, dedupRef: null
};

describe('cargar-ts', () => {
  it('carga computeDedupHash con node a pelo y coincide con vitest', () => {
    const salida = execFileSync(process.execPath, [guion], { encoding: 'utf8' }).trim();
    const esperado = computeDedupHash(FILA_SONDA);
    expect(esperado).toMatch(/^[0-9a-f]{64}$/);
    expect(salida.split('\n').at(-1)).toBe(esperado);
  });
});
```

- [ ] **Step 2: Verlo fallar**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @housekeeper/db exec vitest run scripts/cargar-ts.test.mjs
```

Esperado: FAIL, `Cannot find module … scripts/cargar-ts.mjs`.

- [ ] **Step 3: Implementación** — crear `packages/db/scripts/cargar-ts.mjs`:

```js
// Cargar TS del monorepo desde un guion .mjs con `node` a pelo: el type
// stripping de Node 24 no reescribe los especificadores «./x.js» → x.ts que
// usan los fuentes, así que este hook reintenta con .ts SOLO si la
// resolución original falla. Importar SIEMPRE con importarModuloTs (dinámico).
import { registerHooks } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

let hooksInstalados = false;

function instalarResolucionTs() {
  if (hooksInstalados) return;
  hooksInstalados = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.endsWith('.js')) {
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        }
        throw error;
      }
    }
  });
}

/** Ruta canónica del hash de deduplicación de fase 2. */
export const rutaDedupHash = new URL('../../server/src/finance/dedup-hash.ts', import.meta.url);

export async function importarModuloTs(url) {
  instalarResolucionTs();
  return import(url.href ?? url);
}

// Autosonda: imprime el hash de una fila fija (la que espera el test).
const esEjecucionDirecta =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esEjecucionDirecta) {
  const { computeDedupHash } = await importarModuloTs(rutaDedupHash);
  console.log(computeDedupHash({
    bankRef: '00490001512345678901', opDate: '2026-01-10', amountCents: -2550n,
    concept: 'COMPRA SONDA', balanceCents: 150000n, dedupRef: null
  }));
}
```

- [ ] **Step 4: Verde** — mismo comando del Step 2. Esperado: PASS, 1 test. Si falla con `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, la cadena de fase 2 usa sintaxis TS no borrable: es defecto de fase 2, repórtalo, no lo parchees aquí.

- [ ] **Step 5: Commit**

```bash
git add packages/db/scripts/cargar-ts.mjs packages/db/scripts/cargar-ts.test.mjs
git commit -m "feat(db): cargador .js→.ts para que los guiones node usen código de fase 2"
```

---

### Task 2: SQLite sintética con el esquema del origen

**Files:**
- Create: `packages/db/scripts/home-finance-sintetica.mjs`
- Test: `packages/db/scripts/home-finance-sintetica.test.mjs`

**Interfaces:**
- Consumes: `importarModuloTs`, `rutaDedupHash` (Task 1); `computeDedupHash` (fase 2).
- Produces: `construirSqliteSintetica(ruta, { computeDedupHash, corromperHashDeTx = null })`; constantes `DDL_ORIGEN`, `GRUPO_TRASPASO`, `GRUPO_INVERSION`, `GRUPO_HUERFANO`, `CUENTAS`, `CATEGORIAS`, `REGLAS`, `LOTES`, `TRANSACCIONES`, `ALIAS`, `EVENTOS`, `TRANSACCION_EVENTOS`, `REGLAS_EVENTO`, `TOTALES`, `SUMAS_CUENTA_MES`. CLI: `node scripts/home-finance-sintetica.mjs <ruta-salida.db>`.

**Contexto:** DDL calcada de `/home/abf/github/home-finance/backend/app/models.py` (incluidas las columnas que `db.py::ensure_schema` añade: `recurrence`, `recurrence_manual`, `bank_category`, `raw`, `event_rules.category_id`, `accounts.transfer_refs`). Datos 100 % inventados. Hashes «reales» = `computeDedupHash`; los sintéticos llevan los prefijos del origen (`manual-`, `cashpair-`, `invmirror-`). La tx amex lleva `dedup_ref` (columna Referencia de Amex) que el origen NO persiste: por eso el ETL la excluirá de la verificación cruzada.

**La muestra tiene que contener las formas raras del origen, o el ensayo miente.** Tres exigencias verificadas en el repo de origen:
1. **Cuentas virtuales**: `backend/app/cash.py:14-25` crea `Efectivo` con `bank='efectivo'`, `kind='comun'`, `bank_ref='EFECTIVO'`, y `backend/app/investments.py:15-30` crea las cuentas de inversión con `bank='inversion'`, `kind='inversion'` y `transfer_refs` (las refs viven en la cuenta de INVERSIÓN, no en la cuenta bancaria). El vocabulario completo de `accounts.bank` en el origen es `caixabank|deutsche_bank|efectivo|manual|inversion|openbank` (`backend/app/api.py:22`), y el destino solo admite los cuatro bancos reales o NULL: por eso la muestra incluye esas dos cuentas, para que el ETL ejercite la traducción a NULL.
2. **Patas sintéticas en su cuenta**: la contrapartida `cashpair-` la crea `create_cash_counterleg` DENTRO de la cuenta Efectivo (`cash.py:44-58`, con hash `cashpair-<hash del gasto>`), y el espejo `invmirror-` dentro de la cuenta de inversión. Si la muestra las deja en la cuenta CaixaBank, el ensayo no prueba la forma real de los datos.
3. **Lote manual**: `import_batches.bank` toma también `'manual'` en el origen (`backend/app/api.py:506`); el destino lo admite (resolución canónica 6 del doc de interfaces), así que la muestra trae un lote `bank:'manual'` para fijarlo.

Y una cuarta, del lado de la verificación: `backend/app/transfers.py:32-42` (`orphan_legs`) demuestra que el origen puede tener **grupos de transferencia de una sola pata**, con suma ≠ 0. La muestra incluye uno (`GRUPO_HUERFANO`) para que la comparación origen↔destino no lo confunda con un fallo de migración (tarea 4).

- [ ] **Step 1: Test que falla** — crear `packages/db/scripts/home-finance-sintetica.test.mjs`:

```js
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeDedupHash } from '../../server/src/finance/dedup-hash.ts';
import { construirSqliteSintetica, CUENTAS, TOTALES, TRANSACCIONES } from './home-finance-sintetica.mjs';

const hashDe = (id) => {
  const t = TRANSACCIONES.find((x) => x.id === id);
  const cuenta = CUENTAS.find((c) => c.id === t.account_id);
  return computeDedupHash({
    bankRef: cuenta.bank_ref, opDate: t.op_date, amountCents: t.amount_cents,
    concept: t.concept, balanceCents: t.balance_cents, dedupRef: t.dedup_ref ?? null
  });
};

describe('home-finance-sintetica', () => {
  let dir;
  beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-sintetica-')); });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('construye la base con los conteos prometidos y hashes recomputables', () => {
    const ruta = path.join(dir, 'finanzas-sintetica.db');
    construirSqliteSintetica(ruta, { computeDedupHash });
    const db = new DatabaseSync(ruta, { readOnly: true });
    try {
      const contar = (t) => Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n);
      expect(contar('accounts')).toBe(TOTALES.accounts);
      expect(contar('categories')).toBe(TOTALES.categories);
      expect(contar('rules')).toBe(TOTALES.rules);
      expect(contar('import_batches')).toBe(TOTALES.importBatches);
      expect(contar('transactions')).toBe(TOTALES.transactions);
      expect(contar('provider_aliases')).toBe(TOTALES.providerAliases);
      expect(contar('events')).toBe(TOTALES.events);
      expect(contar('transaction_events')).toBe(TOTALES.transactionEvents);
      expect(contar('event_rules')).toBe(TOTALES.eventRules);
      expect(Number(db.prepare('SELECT count(*) AS n FROM rules WHERE active = 1').get().n))
        .toBe(TOTALES.rulesActivas);
      expect(db.prepare('SELECT dedup_hash FROM transactions WHERE id = 1').get().dedup_hash)
        .toBe(hashDe(1));
      // Las formas raras del origen están presentes: cuentas virtuales y lote manual.
      expect(db.prepare("SELECT group_concat(bank_ref, ',') AS refs FROM accounts WHERE bank IN ('efectivo', 'inversion') ORDER BY id").get().refs)
        .toBe('EFECTIVO,INV-SINTETICO');
      expect(Number(db.prepare("SELECT count(*) AS n FROM import_batches WHERE bank = 'manual'").get().n)).toBe(1);
      expect(Number(db.prepare('SELECT count(DISTINCT transfer_group_id) AS n FROM transactions WHERE transfer_group_id IS NOT NULL').get().n))
        .toBe(TOTALES.gruposTransferencia);
    } finally { db.close(); }
  });

  it('corromperHashDeTx cambia SOLO el hash pedido', () => {
    const ruta = path.join(dir, 'finanzas-corrupta.db');
    construirSqliteSintetica(ruta, { computeDedupHash, corromperHashDeTx: 2 });
    const db = new DatabaseSync(ruta, { readOnly: true });
    try {
      const fila = db.prepare('SELECT dedup_hash FROM transactions WHERE id = 2').get();
      expect(fila.dedup_hash).not.toBe(hashDe(2));
      expect(fila.dedup_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(db.prepare('SELECT dedup_hash FROM transactions WHERE id = 1').get().dedup_hash)
        .toBe(hashDe(1));
    } finally { db.close(); }
  });
});
```

- [ ] **Step 2: Verlo fallar**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @housekeeper/db exec vitest run scripts/home-finance-sintetica.test.mjs
```

Esperado: FAIL, `Cannot find module … home-finance-sintetica.mjs`.

- [ ] **Step 3: Implementación** — crear `packages/db/scripts/home-finance-sintetica.mjs`:

```js
// SQLite SINTÉTICA con el MISMO esquema que el origen home-finance (DDL
// calcada de backend/app/models.py + columnas de ensure_schema). Solo datos
// inventados: con esto ensayan los tests del ETL sin acercarse a la base real.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { importarModuloTs, rutaDedupHash } from './cargar-ts.mjs';

export const DDL_ORIGEN = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY, name VARCHAR(80) NOT NULL, bank VARCHAR(20) NOT NULL,
  kind VARCHAR(10) NOT NULL, owner VARCHAR(10) NOT NULL,
  bank_ref VARCHAR(34) NOT NULL UNIQUE, owner_aliases JSON, transfer_refs JSON
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY, name VARCHAR(60) NOT NULL,
  parent_id INTEGER REFERENCES categories(id), kind VARCHAR(15) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY, filename VARCHAR(255) NOT NULL, bank VARCHAR(20) NOT NULL,
  imported_at DATETIME NOT NULL, new_count INTEGER NOT NULL DEFAULT 0,
  dup_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  op_date DATE NOT NULL, value_date DATE, concept TEXT NOT NULL,
  provider VARCHAR(200) NOT NULL DEFAULT '', amount_cents INTEGER NOT NULL,
  balance_cents INTEGER, code_common VARCHAR(2), code_own VARCHAR(3),
  category_id INTEGER REFERENCES categories(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pendiente', transfer_group_id VARCHAR(36),
  dedup_hash VARCHAR(64) NOT NULL UNIQUE, recurrence VARCHAR(15),
  recurrence_manual BOOLEAN NOT NULL DEFAULT 0, bank_category VARCHAR(120), raw JSON
);
CREATE TABLE rules (
  id INTEGER PRIMARY KEY, match_type VARCHAR(20) NOT NULL, pattern VARCHAR(200) NOT NULL,
  code_common VARCHAR(2), category_id INTEGER NOT NULL REFERENCES categories(id),
  origin VARCHAR(10) NOT NULL DEFAULT 'manual',
  learned_from_id INTEGER REFERENCES transactions(id),
  priority INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT 1
);
CREATE TABLE provider_aliases (
  id INTEGER PRIMARY KEY, provider_norm VARCHAR(200) NOT NULL UNIQUE,
  alias VARCHAR(120) NOT NULL
);
CREATE TABLE events (id INTEGER PRIMARY KEY, name VARCHAR(80) NOT NULL UNIQUE);
CREATE TABLE transaction_events (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id),
  UNIQUE (transaction_id, event_id)
);
CREATE TABLE event_rules (
  id INTEGER PRIMARY KEY, provider_norm VARCHAR(200) NOT NULL,
  concept_norm VARCHAR(300), category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  UNIQUE (provider_norm, concept_norm, category_id)
);
`;

export const GRUPO_TRASPASO = 'e7b8c9d0-1234-4abc-8def-000000000001';
export const GRUPO_INVERSION = 'e7b8c9d0-1234-4abc-8def-000000000002';
// Pata suelta: el origen las admite (transfers.py::orphan_legs). No es un error.
export const GRUPO_HUERFANO = 'e7b8c9d0-1234-4abc-8def-000000000003';

export const CUENTAS = [
  { id: 1, name: 'Cuenta Común', bank: 'caixabank', kind: 'comun', owner: 'familia', bank_ref: '00490001512345678901', owner_aliases: ['FAMILIA PRUEBA'], transfer_refs: [] },
  { id: 2, name: 'Cuenta Padre', bank: 'deutsche_bank', kind: 'personal', owner: 'padre', bank_ref: 'ES9100190020961234567890', owner_aliases: ['PADRE PRUEBA'], transfer_refs: [] },
  { id: 3, name: 'Tarjeta Amex', bank: 'amex', kind: 'personal', owner: 'padre', bank_ref: 'AMEX-SINTETICA-1001', owner_aliases: [], transfer_refs: [] },
  // Cuentas virtuales del origen: bank fuera del vocabulario del destino (→ NULL en 0036).
  { id: 4, name: 'Efectivo', bank: 'efectivo', kind: 'comun', owner: 'familia', bank_ref: 'EFECTIVO', owner_aliases: [], transfer_refs: [] },
  { id: 5, name: 'Fondo Sintético Indexado', bank: 'inversion', kind: 'inversion', owner: 'familia', bank_ref: 'INV-SINTETICO', owner_aliases: [], transfer_refs: ['REF-FONDO-01'] }
];

export const CATEGORIAS = [
  { id: 1, name: 'Vivienda', parent_id: null, kind: 'gasto', sort_order: 0 },
  { id: 2, name: 'Suministros', parent_id: 1, kind: 'gasto', sort_order: 0 },
  { id: 3, name: 'Alimentación', parent_id: null, kind: 'gasto', sort_order: 1 },
  { id: 4, name: 'Supermercado', parent_id: 3, kind: 'gasto', sort_order: 0 },
  { id: 5, name: 'Nómina', parent_id: null, kind: 'ingreso', sort_order: 2 },
  { id: 6, name: 'Transferencia interna', parent_id: null, kind: 'transferencia', sort_order: 3 }
];

export const REGLAS = [
  { id: 1, match_type: 'proveedor_exacto', pattern: 'SUPERMERCADOS ACME', code_common: null, category_id: 4, origin: 'manual', priority: 0, active: 1 },
  { id: 2, match_type: 'codigo_norma43', pattern: '03', code_common: '03', category_id: 5, origin: 'manual', priority: 0, active: 1 },
  { id: 3, match_type: 'concepto_contiene', pattern: 'LUZ', code_common: null, category_id: 2, origin: 'manual', priority: 5, active: 0 },
  { id: 4, match_type: 'proveedor_exacto', pattern: 'BAR PEPE SINTETICO', code_common: '02', category_id: 3, origin: 'agente', priority: 0, active: 1 }
];

export const LOTES = [
  { id: 1, filename: 'extracto-comun-enero.xls', bank: 'caixabank', imported_at: '2026-02-01 10:00:00', new_count: 3, dup_count: 0 },
  { id: 2, filename: 'amex-enero.xlsx', bank: 'amex', imported_at: '2026-02-02 10:30:00', new_count: 1, dup_count: 0 },
  { id: 3, filename: 'db-febrero.xls', bank: 'deutsche_bank', imported_at: '2026-03-02 09:00:00', new_count: 6, dup_count: 1 },
  // Lote de altas manuales: bank='manual', que el destino SÍ admite en lotes.
  { id: 4, filename: 'manual', bank: 'manual', imported_at: '2026-02-14 12:00:00', new_count: 2, dup_count: 0 }
];

// hash 'sha256' = lo calcula construirSqliteSintetica con computeDedupHash;
// cualquier otro valor se guarda literal (prefijos del origen).
export const TRANSACCIONES = [
  { id: 1, account_id: 1, batch_id: 1, op_date: '2026-01-10', value_date: '2026-01-11', concept: 'COMPRA SUPERMERCADOS ACME S.L. TARJETA 9999', provider: 'SUPERMERCADOS ACME', amount_cents: -2550n, balance_cents: 150000n, code_common: '01', code_own: 'TCR', category_id: 4, status: 'confirmada', transfer_group_id: null, hash: 'sha256', recurrence: null, recurrence_manual: 0, bank_category: 'Supermercados', raw: { Concepto: 'COMPRA SUPERMERCADOS ACME S.L.', Importe: '-25,50' } },
  { id: 2, account_id: 1, batch_id: 1, op_date: '2026-01-31', value_date: null, concept: 'NOMINA EMPRESA EJEMPLO SL', provider: 'EMPRESA EJEMPLO', amount_cents: 250000n, balance_cents: 400000n, code_common: '03', code_own: null, category_id: 5, status: 'confirmada', transfer_group_id: null, hash: 'sha256', recurrence: 'recurrente', recurrence_manual: 1, bank_category: null, raw: null },
  { id: 3, account_id: 1, batch_id: 1, op_date: '2026-02-05', value_date: null, concept: 'TRASPASO A CUENTA PADRE', provider: '', amount_cents: -50000n, balance_cents: 350000n, code_common: '04', code_own: null, category_id: 6, status: 'confirmada', transfer_group_id: GRUPO_TRASPASO, hash: 'sha256', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  { id: 4, account_id: 2, batch_id: 3, op_date: '2026-02-05', value_date: null, concept: 'TRASPASO RECIBIDO DE CUENTA COMUN', provider: '', amount_cents: 50000n, balance_cents: 60000n, code_common: '04', code_own: null, category_id: 6, status: 'confirmada', transfer_group_id: GRUPO_TRASPASO, hash: 'sha256', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  // 5 y 6: par de efectivo, ambas patas en la cuenta virtual Efectivo (cash.py:44-58);
  // el hash de la contrapartida es literalmente `cashpair-<hash del gasto>`.
  { id: 5, account_id: 4, batch_id: 4, op_date: '2026-02-14', value_date: null, concept: 'GASTO EN EFECTIVO FARMACIA', provider: 'Farmacia Ñuñez', amount_cents: -2000n, balance_cents: null, code_common: null, code_own: null, category_id: 3, status: 'confirmada', transfer_group_id: null, hash: 'manual-a1b2c3d4e5f60718', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  { id: 6, account_id: 4, batch_id: 4, op_date: '2026-02-14', value_date: null, concept: 'Contrapartida efectivo — GASTO EN EFECTIVO FARMACIA', provider: 'EFECTIVO', amount_cents: 2000n, balance_cents: null, code_common: null, code_own: null, category_id: 3, status: 'confirmada', transfer_group_id: null, hash: 'cashpair-manual-a1b2c3d4e5f60718', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  { id: 7, account_id: 3, batch_id: 2, op_date: '2026-01-20', value_date: null, concept: 'RESTAURANTE EJEMPLO MADRID', provider: 'RESTAURANTE EJEMPLO', amount_cents: -1234n, balance_cents: null, code_common: null, code_own: null, category_id: 3, status: 'sugerida_regla', transfer_group_id: null, hash: 'sha256', dedup_ref: 'REF-AMEX-0001', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  { id: 8, account_id: 2, batch_id: 3, op_date: '2026-02-20', value_date: null, concept: 'RECIBO LUZ ENERGIA EJEMPLO SL', provider: 'ENERGIA EJEMPLO', amount_cents: -6789n, balance_cents: 53211n, code_common: '05', code_own: null, category_id: null, status: 'pendiente', transfer_group_id: null, hash: 'sha256', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  { id: 9, account_id: 2, batch_id: 3, op_date: '2026-03-01', value_date: null, concept: 'APORTACION FONDO REF-FONDO-01', provider: '', amount_cents: -10000n, balance_cents: 43211n, code_common: '04', code_own: null, category_id: 6, status: 'confirmada', transfer_group_id: GRUPO_INVERSION, hash: 'sha256', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  // 10: espejo de inversión, en la cuenta virtual de inversión (investments.py:52-70).
  { id: 10, account_id: 5, batch_id: 3, op_date: '2026-03-01', value_date: null, concept: 'APORTACION FONDO ESPEJO', provider: '', amount_cents: 10000n, balance_cents: null, code_common: null, code_own: null, category_id: 6, status: 'confirmada', transfer_group_id: GRUPO_INVERSION, hash: 'invmirror-c3d4e5f607182930', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  // 11: pata huérfana (grupo de una sola pata, suma ≠ 0). El origen las tiene; migrarlas
  // tal cual es lo correcto, y la comparación de la tarea 4 NO debe tomarlo por un fallo.
  { id: 11, account_id: 2, batch_id: 3, op_date: '2026-03-05', value_date: null, concept: 'TRASPASO PENDIENTE DE PAREJA', provider: '', amount_cents: -7500n, balance_cents: 35711n, code_common: '04', code_own: null, category_id: 6, status: 'confirmada', transfer_group_id: GRUPO_HUERFANO, hash: 'sha256', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null }
];

export const ALIAS = [{ id: 1, provider_norm: 'SUPERMERCADOS ACME', alias: 'Acme' }];
export const EVENTOS = [{ id: 1, name: 'Semana Santa Sintética 2026' }];
export const TRANSACCION_EVENTOS = [{ id: 1, transaction_id: 1, event_id: 1 }];
export const REGLAS_EVENTO = [
  { id: 1, provider_norm: 'SUPERMERCADOS ACME', concept_norm: null, category_id: null, event_id: 1 },
  { id: 2, provider_norm: '', concept_norm: null, category_id: 4, event_id: 1 }
];

// Números derivados de las constantes de arriba. NINGÚN test del plan repite
// estos valores como literal: todos los importan de aquí (una sola verdad).
export const TOTALES = {
  accounts: 5, categories: 6, rules: 4, rulesActivas: 3, importBatches: 4,
  transactions: 11, providerAliases: 1, events: 1, transactionEvents: 1, eventRules: 2,
  // comprobables = hash sha256 y cuenta no-amex: 1, 2, 3, 4, 8, 9, 11.
  // descartados = amex (7) + prefijos manual-/cashpair-/invmirror- (5, 6, 10).
  hashesComprobables: 7, hashesDescartados: 4, gruposTransferencia: 3,
  estados: { confirmada: 9, pendiente: 1, sugerida_regla: 1 },
  fechaMin: '2026-01-10', fechaMax: '2026-03-05'
};

export const SUMAS_CUENTA_MES = {
  '00490001512345678901': { '2026-01': 247450n, '2026-02': -50000n },
  ES9100190020961234567890: { '2026-02': 43211n, '2026-03': -17500n },
  'AMEX-SINTETICA-1001': { '2026-01': -1234n },
  EFECTIVO: { '2026-02': 0n },
  'INV-SINTETICO': { '2026-03': 10000n }
};

export function construirSqliteSintetica(ruta, { computeDedupHash, corromperHashDeTx = null }) {
  const db = new DatabaseSync(ruta);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(DDL_ORIGEN);
    const cuenta = db.prepare('INSERT INTO accounts (id, name, bank, kind, owner, bank_ref, owner_aliases, transfer_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const c of CUENTAS) cuenta.run(c.id, c.name, c.bank, c.kind, c.owner, c.bank_ref, JSON.stringify(c.owner_aliases), JSON.stringify(c.transfer_refs));
    const categoria = db.prepare('INSERT INTO categories (id, name, parent_id, kind, sort_order) VALUES (?, ?, ?, ?, ?)');
    for (const c of CATEGORIAS) categoria.run(c.id, c.name, c.parent_id, c.kind, c.sort_order);
    const lote = db.prepare('INSERT INTO import_batches (id, filename, bank, imported_at, new_count, dup_count) VALUES (?, ?, ?, ?, ?, ?)');
    for (const b of LOTES) lote.run(b.id, b.filename, b.bank, b.imported_at, b.new_count, b.dup_count);
    const transaccion = db.prepare(`INSERT INTO transactions
      (id, account_id, batch_id, op_date, value_date, concept, provider, amount_cents, balance_cents,
       code_common, code_own, category_id, status, transfer_group_id, dedup_hash, recurrence,
       recurrence_manual, bank_category, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of TRANSACCIONES) {
      const cuentaDeTx = CUENTAS.find((c) => c.id === t.account_id);
      let hash = t.hash === 'sha256'
        ? computeDedupHash({
            bankRef: cuentaDeTx.bank_ref, opDate: t.op_date, amountCents: t.amount_cents,
            concept: t.concept, balanceCents: t.balance_cents, dedupRef: t.dedup_ref ?? null
          })
        : t.hash;
      if (t.id === corromperHashDeTx) {
        hash = hash.startsWith('0') ? `1${hash.slice(1)}` : `0${hash.slice(1)}`;
      }
      transaccion.run(t.id, t.account_id, t.batch_id, t.op_date, t.value_date, t.concept, t.provider,
        t.amount_cents, t.balance_cents, t.code_common, t.code_own, t.category_id, t.status,
        t.transfer_group_id, hash, t.recurrence, t.recurrence_manual, t.bank_category,
        t.raw === null ? null : JSON.stringify(t.raw));
    }
    const regla = db.prepare('INSERT INTO rules (id, match_type, pattern, code_common, category_id, origin, learned_from_id, priority, active) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)');
    for (const r of REGLAS) regla.run(r.id, r.match_type, r.pattern, r.code_common, r.category_id, r.origin, r.priority, r.active);
    const alias = db.prepare('INSERT INTO provider_aliases (id, provider_norm, alias) VALUES (?, ?, ?)');
    for (const a of ALIAS) alias.run(a.id, a.provider_norm, a.alias);
    const evento = db.prepare('INSERT INTO events (id, name) VALUES (?, ?)');
    for (const e of EVENTOS) evento.run(e.id, e.name);
    const te = db.prepare('INSERT INTO transaction_events (id, transaction_id, event_id) VALUES (?, ?, ?)');
    for (const v of TRANSACCION_EVENTOS) te.run(v.id, v.transaction_id, v.event_id);
    const re = db.prepare('INSERT INTO event_rules (id, provider_norm, concept_norm, category_id, event_id) VALUES (?, ?, ?, ?, ?)');
    for (const v of REGLAS_EVENTO) re.run(v.id, v.provider_norm, v.concept_norm, v.category_id, v.event_id);
  } finally {
    db.close();
  }
}

const esEjecucionDirecta =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esEjecucionDirecta) {
  const destino = process.argv[2];
  if (!destino) {
    console.error('Uso: node scripts/home-finance-sintetica.mjs <ruta-salida.db>');
    process.exit(2);
  }
  const { computeDedupHash } = await importarModuloTs(rutaDedupHash);
  construirSqliteSintetica(destino, { computeDedupHash });
  console.log(`SQLite sintética escrita en ${destino} (${TOTALES.transactions} transacciones).`);
}
```

- [ ] **Step 4: Verde** — mismo comando del Step 2. Esperado: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/scripts/home-finance-sintetica.mjs packages/db/scripts/home-finance-sintetica.test.mjs
git commit -m "feat(db): sqlite sintética con el esquema del origen home-finance"
```

---

### Task 3: ETL — argumentos, copia de seguridad (PASO 0) y lectura del origen

**Files:**
- Create: `packages/db/scripts/migrar-home-finance.mjs`
- Test: `packages/db/scripts/migrar-home-finance.test.mjs`

**Interfaces:**
- Consumes: Task 1 y 2; `computeDedupHash` (fase 2).
- Produces (exports del guion): `class ErrorDeUso extends Error`; `parseArgs(argv): { sqlite, databaseUrl, household, backupDir, dryRun, verifyOnly, forceEmptyCheck }`; `normText(valor: string): string`; `estaDentroDeUnRepo(dir): Promise<boolean>`; `hacerCopiaSeguridad(rutaSqlite, backupDir, ahora?): Promise<{ destino, sha256 }>`; `leerOrigen(rutaSqlite): { accounts, categories, rules, importBatches, transactions, providerAliases, events, transactionEvents, eventRules }` (importes `bigint`, ids `Number`, booleanos JS, columnas JSON como TEXTO verbatim).

**Contexto:** `normText` replica EXACTAMENTE `backend/app/money.py::norm_text` del origen (NFKD → quitar marcas combinantes → colapsar espacios → trim → mayúsculas); se congela aquí a propósito porque los datos migrados deben casar con lo que el origen escribió, no con lo que la normalización de fase 2 evolucione. La copia de seguridad (spec §9.1) se niega a escribir dentro de CUALQUIER repo git (cubre casa-clara y home-finance de una vez).

- [ ] **Step 1: Test que falla** — crear `packages/db/scripts/migrar-home-finance.test.mjs`:

```js
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeDedupHash } from '../../server/src/finance/dedup-hash.ts';
import { construirSqliteSintetica, CUENTAS, TOTALES } from './home-finance-sintetica.mjs';
import { ErrorDeUso, hacerCopiaSeguridad, leerOrigen, normText, parseArgs } from './migrar-home-finance.mjs';

describe('parseArgs', () => {
  it('lee flags con valor y banderas', () => {
    expect(parseArgs(['--sqlite', '/tmp/x.db', '--database-url', 'postgresql://u@h/db',
      '--household', 'hogar', '--backup-dir', '/tmp/copias', '--dry-run']))
      .toMatchObject({ sqlite: '/tmp/x.db', databaseUrl: 'postgresql://u@h/db', household: 'hogar',
        backupDir: '/tmp/copias', dryRun: true, verifyOnly: false, forceEmptyCheck: false });
  });
  it('rechaza ausencias, desconocidos y combinaciones imposibles', () => {
    expect(() => parseArgs([])).toThrow(ErrorDeUso);
    expect(() => parseArgs(['--sqlite'])).toThrow(/necesita un valor/);
    expect(() => parseArgs(['--sqlite', 'a', '--database-url', 'b', '--household', 'c', '--rarisimo'])).toThrow(/desconocido/);
    expect(() => parseArgs(['--sqlite', 'a', '--database-url', 'b', '--household', 'c', '--dry-run', '--verify-only'])).toThrow(/excluyentes/);
  });
});

describe('normText (réplica de money.py::norm_text)', () => {
  it('quita acentos, colapsa espacios y pasa a mayúsculas', () => {
    expect(normText('  Café  con\tleche  ')).toBe('CAFE CON LECHE');
    expect(normText('Peluquería Ñoño')).toBe('PELUQUERIA NONO');
  });
});

describe('hacerCopiaSeguridad', () => {
  it('se niega a copiar dentro de un repositorio git', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'copia-repo-'));
    try {
      await mkdir(path.join(dir, '.git'));
      await expect(hacerCopiaSeguridad('/no/importa.db', path.join(dir, 'sub', 'copias')))
        .rejects.toThrow(/fuera de ambos repos/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('crea una copia datada idéntica fuera de cualquier repo', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'copia-ok-'));
    try {
      const original = path.join(dir, 'finanzas.db');
      await writeFile(original, 'contenido sintético');
      const { destino, sha256 } = await hacerCopiaSeguridad(
        original, path.join(dir, 'copias'), new Date('2026-08-31T10:00:00.000Z'));
      expect(path.basename(destino)).toBe('finanzas-2026-08-31T10-00-00-000Z.db');
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('leerOrigen', () => {
  it('lee todas las tablas con importes bigint, ids number y booleanos JS', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'origen-'));
    try {
      const ruta = path.join(dir, 'sintetica.db');
      construirSqliteSintetica(ruta, { computeDedupHash });
      const origen = leerOrigen(ruta);
      expect(origen.transactions).toHaveLength(TOTALES.transactions);
      expect(origen.accounts.map((c) => c.bank_ref)).toEqual(CUENTAS.map((c) => c.bank_ref));
      const primera = origen.transactions.find((t) => t.id === 1);
      expect(typeof primera.amount_cents).toBe('bigint');
      expect(primera.op_date).toBe('2026-01-10');
      expect(primera.recurrence_manual).toBe(false);
      expect(origen.transactions.find((t) => t.id === 2).recurrence_manual).toBe(true);
      expect(typeof primera.raw).toBe('string'); // JSON verbatim, sin reserializar
      // raw es nullable en el origen y NOT NULL en 0036: leerOrigen lo coalesce a '{}'.
      expect(origen.transactions.find((t) => t.id === 2).raw).toBe('{}');
      expect(origen.rules).toHaveLength(TOTALES.rules); // la inactiva también: filtra migrar()
      expect(origen.rules.find((r) => r.id === 3).active).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Verlo fallar**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @housekeeper/db exec vitest run scripts/migrar-home-finance.test.mjs
```

Esperado: FAIL, `Cannot find module … migrar-home-finance.mjs`.

- [ ] **Step 3: Implementación** — crear `packages/db/scripts/migrar-home-finance.mjs`:

```js
// ETL única de home-finance (SQLite) → casa-clara (Postgres, esquema 0036).
// Runbook: docs/runbooks/migracion-home-finance.md. Se ejecuta con `node` a
// pelo por conexión DIRECTA (5432) del propietario, como las migraciones.
// PASO 0 innegociable: copia de seguridad datada del .db FUERA de ambos repos.
// Imports EXACTOS de esta tarea: `pnpm lint` aplica @typescript-eslint/no-unused-vars
// como error también a los .mjs, así que cada tarea añade solo lo que estrena.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class ErrorDeUso extends Error {}

const USO = `Uso: node scripts/migrar-home-finance.mjs \\
  --sqlite <ruta finanzas.db> --database-url <postgresql://…> --household <slug> \\
  [--backup-dir <dir>] [--dry-run] [--verify-only] [--force-empty-check]`;

export function parseArgs(argv) {
  const opciones = {
    sqlite: null, databaseUrl: null, household: null,
    backupDir: path.join(os.homedir(), 'copias-home-finance'),
    dryRun: false, verifyOnly: false, forceEmptyCheck: false
  };
  const conValor = { '--sqlite': 'sqlite', '--database-url': 'databaseUrl', '--household': 'household', '--backup-dir': 'backupDir' };
  const banderas = { '--dry-run': 'dryRun', '--verify-only': 'verifyOnly', '--force-empty-check': 'forceEmptyCheck' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg in conValor) {
      const valor = argv[i + 1];
      if (!valor || valor.startsWith('--')) throw new ErrorDeUso(`${arg} necesita un valor.\n${USO}`);
      opciones[conValor[arg]] = valor;
      i += 1;
    } else if (arg in banderas) {
      opciones[banderas[arg]] = true;
    } else {
      throw new ErrorDeUso(`Argumento desconocido: ${arg}.\n${USO}`);
    }
  }
  for (const [bandera, clave] of [['--sqlite', 'sqlite'], ['--database-url', 'databaseUrl'], ['--household', 'household']]) {
    if (!opciones[clave]) throw new ErrorDeUso(`Falta ${bandera}.\n${USO}`);
  }
  if (opciones.dryRun && opciones.verifyOnly) throw new ErrorDeUso(`--dry-run y --verify-only son excluyentes.\n${USO}`);
  return opciones;
}

// Réplica EXACTA de backend/app/money.py::norm_text del origen, congelada a
// propósito: lo migrado debe casar con los alias que el origen escribió.
export function normText(valor) {
  const sinMarcas = valor.normalize('NFKD').replace(/\p{M}+/gu, '');
  return sinMarcas.replace(/\s+/g, ' ').trim().toUpperCase();
}

/** «Fuera de ambos repos» hecho comprobable: fuera de CUALQUIER repo git. */
export async function estaDentroDeUnRepo(dir) {
  let actual = path.resolve(dir);
  for (;;) {
    try {
      await access(path.join(actual, '.git'));
      return true;
    } catch {
      const padre = path.dirname(actual);
      if (padre === actual) return false;
      actual = padre;
    }
  }
}

export async function hacerCopiaSeguridad(rutaSqlite, backupDir, ahora = new Date()) {
  if (await estaDentroDeUnRepo(backupDir)) {
    throw new Error(`El directorio de copias ${backupDir} está dentro de un repositorio git; la copia de seguridad debe vivir fuera de ambos repos.`);
  }
  await mkdir(backupDir, { recursive: true });
  const sello = ahora.toISOString().replace(/[:.]/g, '-');
  const destino = path.join(backupDir, `finanzas-${sello}.db`);
  await copyFile(rutaSqlite, destino, constants.COPYFILE_EXCL);
  const [origen, copia] = await Promise.all([readFile(rutaSqlite), readFile(destino)]);
  const sha256 = createHash('sha256').update(origen).digest('hex');
  if (sha256 !== createHash('sha256').update(copia).digest('hex')) {
    throw new Error('La copia de seguridad no coincide con el original (sha256 distinto).');
  }
  return { destino, sha256 };
}

export function leerOrigen(rutaSqlite) {
  const db = new DatabaseSync(rutaSqlite, { readOnly: true });
  try {
    const todo = (sql) => {
      const stmt = db.prepare(sql);
      stmt.setReadBigInts(true); // céntimos SIEMPRE bigint, nunca Number
      return stmt.all();
    };
    const n = (v) => (v === null ? null : Number(v));
    return {
      accounts: todo('SELECT id, name, bank, kind, owner, bank_ref, owner_aliases, transfer_refs FROM accounts ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), owner_aliases: f.owner_aliases ?? '[]', transfer_refs: f.transfer_refs ?? '[]' })),
      categories: todo('SELECT id, name, parent_id, kind FROM categories ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), parent_id: n(f.parent_id) })),
      rules: todo('SELECT id, match_type, pattern, code_common, category_id, origin, priority, active FROM rules ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), category_id: n(f.category_id), priority: n(f.priority), active: f.active === 1n })),
      importBatches: todo('SELECT id, filename, bank, imported_at, new_count, dup_count FROM import_batches ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), new_count: n(f.new_count), dup_count: n(f.dup_count) })),
      // `raw` es nullable en el origen (models.py:74) y en 0036 la columna es
      // `jsonb NOT NULL DEFAULT '{}'` con CHECK de objeto: se coalesce AQUÍ, una
      // sola vez, igual que owner_aliases/transfer_refs (resolución canónica 8).
      transactions: todo(`SELECT id, account_id, batch_id, op_date, value_date, concept, provider,
          amount_cents, balance_cents, code_common, code_own, category_id, status,
          transfer_group_id, dedup_hash, recurrence, recurrence_manual, bank_category, raw
          FROM transactions ORDER BY id`)
        .map((f) => ({ ...f, id: n(f.id), account_id: n(f.account_id), batch_id: n(f.batch_id),
          category_id: n(f.category_id), recurrence_manual: f.recurrence_manual === 1n,
          raw: f.raw ?? '{}' })),
      providerAliases: todo('SELECT id, provider_norm, alias FROM provider_aliases ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id) })),
      events: todo('SELECT id, name FROM events ORDER BY id').map((f) => ({ ...f, id: n(f.id) })),
      transactionEvents: todo('SELECT id, transaction_id, event_id FROM transaction_events ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), transaction_id: n(f.transaction_id), event_id: n(f.event_id) })),
      eventRules: todo('SELECT id, provider_norm, concept_norm, category_id, event_id FROM event_rules ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), category_id: n(f.category_id), event_id: n(f.event_id) }))
    };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Verde** — mismo comando del Step 2. Esperado: PASS, 6 tests (2 de `parseArgs`, 1 de `normText`, 2 de `hacerCopiaSeguridad`, 1 de `leerOrigen`).

- [ ] **Step 5: Lint del fichero nuevo** — el guion se cierra sin imports sobrantes; compruébalo ya, no al final de la fase:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm exec eslint packages/db/scripts/migrar-home-finance.mjs packages/db/scripts/migrar-home-finance.test.mjs
```

Esperado: sin salida (0 problemas). Las tareas 5 y 6 amplían los imports en su propio Step 3, cuando estrenan cada símbolo.

- [ ] **Step 6: Commit**

```bash
git add packages/db/scripts/migrar-home-finance.mjs packages/db/scripts/migrar-home-finance.test.mjs
git commit -m "feat(db): ETL home-finance — argumentos, copia de seguridad y lectura del origen"
```

---

### Task 4: ETL — resúmenes, comparación, verificación cruzada e informe

**Files:**
- Modify: `packages/db/scripts/migrar-home-finance.mjs` (añadir funciones al final, antes de ningún bloque de ejecución directa)
- Test: `packages/db/scripts/migrar-home-finance.test.mjs` (añadir describes)

**Interfaces:**
- Consumes: `leerOrigen` (Task 3); `computeDedupHash` (fase 2).
- Produces: `resumenOrigen(origen)` y `resumenDestino(client, householdId)` (Task 5) con la MISMA forma `{ conteos: Record<string, number>, sumasCuentaMes: Map<string, bigint>, grupos: Map<string, { patas: number, suma: bigint }>, estados: Map<string, number>, fechaMin: string|null, fechaMax: string|null }`; `avisosOrigen(origen): string[]`; `validarOrigen(origen): string[]`; `compararResumenes(a, b): { ok: boolean, lineas: Array<{ seccion, etiqueta, ok, detalle }> }`; `verificarHashes(origen, computeDedupHash, { muestra = 500 }): { comprobados, descartados, discrepancias: Array<{ id, esperado, recalculado }> }`; `renderInforme({ modo, hogar, rutaSqlite, copia, comparacion, hashes, avisos, motivoAborto, ahora? }): string`; vocabularios `BANCOS_CUENTA_ORIGEN`, `BANCOS_LOTE_DESTINO`, `ESTADOS_DESTINO`, `CLASES_CUENTA_DESTINO`, `CLASES_CATEGORIA_DESTINO`, `TIPOS_REGLA_DESTINO`, `ORIGENES_REGLA_DESTINO`.

**Dos separaciones que esta tarea fija (y de las que dependen las tareas 5 y 6):**
- **Comparar ≠ auditar.** `compararResumenes` solo responde «¿lo que hay en destino es lo mismo que había en origen?». El invariante «cada grupo de transferencia neteaa 0» (spec §9.3) NO se comprueba ahí: el origen tiene patas huérfanas legítimas (`transfers.py::orphan_legs`) y bloquear por eso haría fallar una migración fiel. Ese invariante se informa como aviso, sin bloquear.
- **Validar ≠ reventar.** `validarOrigen` comprueba ANTES de abrir la transacción los invariantes que 0036 impone y el origen no garantiza (una sola raíz `transferencia`, árbol de 2 niveles, `concept` ≤ 500, vocabularios de `status`/`kind`/`rule_type`/`origin`/`bank`), para que el fallo sea una lista legible en el informe y no un error crudo de `pg` a mitad de escritura.

- [ ] **Step 1: Tests que fallan** — añadir al final de `migrar-home-finance.test.mjs` (y a sus imports: `avisosOrigen, compararResumenes, renderInforme, resumenOrigen, validarOrigen, verificarHashes` desde `./migrar-home-finance.mjs`, y `GRUPO_HUERFANO, GRUPO_TRASPASO, SUMAS_CUENTA_MES` desde `./home-finance-sintetica.mjs`):

```js
async function crearOrigenSintetico(corromperHashDeTx = null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'resumen-'));
  const ruta = path.join(dir, 'sintetica.db');
  construirSqliteSintetica(ruta, { computeDedupHash, corromperHashDeTx });
  const origen = leerOrigen(ruta);
  await rm(dir, { recursive: true, force: true });
  return origen;
}

describe('resumenOrigen y compararResumenes', () => {
  it('agrega conteos, sumas cuenta·mes, grupos, estados y fechas', async () => {
    const resumen = resumenOrigen(await crearOrigenSintetico());
    expect(resumen.conteos.finance_transactions).toBe(TOTALES.transactions);
    expect(resumen.conteos.finance_rules).toBe(TOTALES.rulesActivas); // solo activas: es lo que migrará
    expect(resumen.sumasCuentaMes.get('00490001512345678901|2026-01'))
      .toBe(SUMAS_CUENTA_MES['00490001512345678901']['2026-01']);
    expect(resumen.sumasCuentaMes.get('EFECTIVO|2026-02')).toBe(SUMAS_CUENTA_MES.EFECTIVO['2026-02']);
    expect(resumen.grupos.size).toBe(TOTALES.gruposTransferencia);
    expect(resumen.grupos.get(GRUPO_TRASPASO)).toEqual({ patas: 2, suma: 0n });
    expect(Object.fromEntries(resumen.estados)).toEqual(TOTALES.estados);
    expect(resumen.fechaMin).toBe(TOTALES.fechaMin);
    expect(resumen.fechaMax).toBe(TOTALES.fechaMax);
  });
  it('una comparación idéntica es OK y una rota señala la línea', async () => {
    const origen = await crearOrigenSintetico();
    const a = resumenOrigen(origen);
    expect(compararResumenes(a, resumenOrigen(origen)).ok).toBe(true);
    const b = resumenOrigen(origen);
    b.grupos.set(GRUPO_TRASPASO, { patas: 2, suma: 5n });
    const rota = compararResumenes(a, b);
    expect(rota.ok).toBe(false);
    expect(rota.lineas.filter((l) => !l.ok).map((l) => l.etiqueta))
      .toContain(`grupo ${GRUPO_TRASPASO} (patas y suma)`);
  });
  it('una pata huérfana del origen NO rompe la comparación', async () => {
    const origen = await crearOrigenSintetico();
    const resumen = resumenOrigen(origen);
    expect(resumen.grupos.get(GRUPO_HUERFANO)).toEqual({ patas: 1, suma: -7500n });
    const comparacion = compararResumenes(resumen, resumenOrigen(origen));
    expect(comparacion.ok).toBe(true);
    expect(comparacion.lineas.find((l) => l.etiqueta === `grupo ${GRUPO_HUERFANO} (patas y suma)`).ok)
      .toBe(true);
  });
});

describe('verificarHashes', () => {
  it('recalcula la muestra y descarta prefijos y amex', async () => {
    expect(verificarHashes(await crearOrigenSintetico(), computeDedupHash))
      .toMatchObject({ comprobados: TOTALES.hashesComprobables,
        descartados: TOTALES.hashesDescartados, discrepancias: [] });
  });
  it('detecta un hash corrupto', async () => {
    const resultado = verificarHashes(await crearOrigenSintetico(2), computeDedupHash);
    expect(resultado.discrepancias).toHaveLength(1);
    expect(resultado.discrepancias[0].id).toBe(2);
  });
});

describe('validarOrigen', () => {
  it('la muestra íntegra no tiene ningún problema', async () => {
    expect(validarOrigen(await crearOrigenSintetico())).toEqual([]);
  });
  it('detecta doble raíz transferencia, concepto larguísimo y banco desconocido', async () => {
    const origen = await crearOrigenSintetico();
    origen.categories.push({ id: 99, name: 'Traspasos duplicados', parent_id: null, kind: 'transferencia' });
    origen.transactions[0].concept = 'X'.repeat(501);
    origen.accounts[0].bank = 'bancoinventado';
    expect(validarOrigen(origen)).toEqual([
      '2 categoría(s) raíz de tipo «transferencia» en el origen; el destino admite exactamente una (índice único parcial de 0036).',
      '1 transacción(es) con concept de más de 500 caracteres (ids: 1); el destino lo limita con CHECK.',
      'Cuenta 1 («Cuenta Común») con bank «bancoinventado» fuera del vocabulario del origen (caixabank, deutsche_bank, openbank, amex, efectivo, inversion, manual).'
    ]);
  });
});

describe('avisosOrigen y renderInforme', () => {
  it('avisa de todo lo que el destino no conserva, sin bloquear', async () => {
    expect(avisosOrigen(await crearOrigenSintetico())).toEqual([
      '1 regla(s) inactiva(s) del origen no se migran (el esquema destino no conserva reglas apagadas).',
      '1 regla(s) activa(s) con code_common fuera de codigo_norma43 pierden ese filtro (columna sin equivalente en destino).',
      'El orden manual del árbol de categorías (categories.sort_order) no se conserva: el destino ordena por nombre.',
      'La procedencia de las reglas aprendidas (rules.learned_from_id) no se conserva: el destino solo guarda origin.',
      `1 grupo(s) de transferencia del origen no netean 0 (patas huérfanas, spec §9.3; se migran tal cual): ${GRUPO_HUERFANO} (patas=1, suma=-7500).`
    ]);
  });
  it('el informe contiene las secciones obligatorias y el resultado', async () => {
    const resumen = resumenOrigen(await crearOrigenSintetico());
    const texto = renderInforme({
      modo: 'real', hogar: 'hogar-prueba', rutaSqlite: '/tmp/finanzas.db',
      copia: { destino: '/home/abf/copias-home-finance/finanzas-2026-08-31T10-00-00-000Z.db', sha256: 'a'.repeat(64) },
      comparacion: compararResumenes(resumen, resumen),
      hashes: { comprobados: TOTALES.hashesComprobables, descartados: TOTALES.hashesDescartados, discrepancias: [] },
      avisos: ['un aviso'], motivoAborto: null, ahora: new Date('2026-08-31T10:00:00Z')
    });
    for (const seccion of ['## Copia de seguridad (PASO 0)', '## Conteos por tabla',
      '## Sumas de amount_cents por cuenta y mes', '## Grupos de transferencia',
      '## Distribución de estados', '## Rango de fechas',
      '## Verificación cruzada de dedup_hash', '## Avisos']) {
      expect(texto).toContain(seccion);
    }
    expect(texto).toContain('/home/abf/copias-home-finance/finanzas-2026-08-31T10-00-00-000Z.db');
    expect(texto).toContain('a'.repeat(64));
    expect(texto).not.toContain('## Aborto');
    expect(texto).toContain('Resultado: OK');
  });
  it('sin comparación (aborto temprano) el informe dice FALLO y explica el motivo', () => {
    const texto = renderInforme({
      modo: 'real', hogar: 'h', rutaSqlite: 'x', copia: null, comparacion: null,
      hashes: { comprobados: 5, descartados: 0, discrepancias: [{ id: 2, esperado: 'a', recalculado: 'b' }] },
      avisos: [], motivoAborto: 'El hogar «h» ya tiene 42 filas de finanzas; aborto.',
      ahora: new Date('2026-08-31T10:00:00Z')
    });
    expect(texto).toContain('## Aborto');
    expect(texto).toContain('El hogar «h» ya tiene 42 filas de finanzas; aborto.');
    expect(texto).toContain('## Copia de seguridad (PASO 0)');
    expect(texto).toContain('(no se hizo copia en esta ejecución)');
    expect(texto).toContain('Resultado: FALLO');
  });
});
```

- [ ] **Step 2: Verlos fallar** — mismo comando de test de la Task 3. Esperado: FAIL, `does not provide an export named 'resumenOrigen'`.

- [ ] **Step 3: Implementación** — añadir a `migrar-home-finance.mjs`:

```js
/** Tablas destino cuyo conteo verifica el informe (0036, sin la de grants). */
export const TABLAS_DESTINO = [
  'finance_accounts', 'finance_categories', 'finance_rules', 'finance_import_batches',
  'finance_transactions', 'finance_provider_aliases', 'finance_events',
  'finance_transaction_events', 'finance_event_rules'
];

export function resumenOrigen(origen) {
  const cuentasPorId = new Map(origen.accounts.map((c) => [c.id, c]));
  const sumasCuentaMes = new Map();
  const grupos = new Map();
  const estados = new Map();
  let fechaMin = null;
  let fechaMax = null;
  for (const tx of origen.transactions) {
    const clave = `${cuentasPorId.get(tx.account_id).bank_ref}|${tx.op_date.slice(0, 7)}`;
    sumasCuentaMes.set(clave, (sumasCuentaMes.get(clave) ?? 0n) + tx.amount_cents);
    estados.set(tx.status, (estados.get(tx.status) ?? 0) + 1);
    if (tx.transfer_group_id) {
      const g = grupos.get(tx.transfer_group_id) ?? { patas: 0, suma: 0n };
      g.patas += 1;
      g.suma += tx.amount_cents;
      grupos.set(tx.transfer_group_id, g);
    }
    if (fechaMin === null || tx.op_date < fechaMin) fechaMin = tx.op_date;
    if (fechaMax === null || tx.op_date > fechaMax) fechaMax = tx.op_date;
  }
  return {
    conteos: {
      finance_accounts: origen.accounts.length,
      finance_categories: origen.categories.length,
      finance_rules: origen.rules.filter((r) => r.active).length,
      finance_import_batches: origen.importBatches.length,
      finance_transactions: origen.transactions.length,
      finance_provider_aliases: origen.providerAliases.length,
      finance_events: origen.events.length,
      finance_transaction_events: origen.transactionEvents.length,
      finance_event_rules: origen.eventRules.length
    },
    sumasCuentaMes, grupos, estados, fechaMin, fechaMax
  };
}

/** Todo lo que el destino NO conserva, dicho en voz alta. Ningún aviso bloquea:
 *  el informe tiene que poder decir «Resultado: OK» y aun así declarar qué se
 *  pierde, en vez de callarse pérdidas que el usuario vería luego en la UI. */
export function avisosOrigen(origen) {
  const avisos = [];
  const inactivas = origen.rules.filter((r) => !r.active).length;
  if (inactivas > 0) avisos.push(`${inactivas} regla(s) inactiva(s) del origen no se migran (el esquema destino no conserva reglas apagadas).`);
  const conCodigo = origen.rules.filter((r) => r.active && r.code_common !== null && r.match_type !== 'codigo_norma43').length;
  if (conCodigo > 0) avisos.push(`${conCodigo} regla(s) activa(s) con code_common fuera de codigo_norma43 pierden ese filtro (columna sin equivalente en destino).`);
  // Estas dos son incondicionales: el destino no tiene columna equivalente, así
  // que la pérdida ocurre SIEMPRE (categories.sort_order y rules.learned_from_id
  // existen en models.py:27 y :80 y leerOrigen ni los trae).
  avisos.push('El orden manual del árbol de categorías (categories.sort_order) no se conserva: el destino ordena por nombre.');
  avisos.push('La procedencia de las reglas aprendidas (rules.learned_from_id) no se conserva: el destino solo guarda origin.');
  // Invariante «cada grupo netea 0» (spec §9.3): se INFORMA, no se exige. El
  // origen admite patas huérfanas (transfers.py::orphan_legs) y migrarlas es lo fiel.
  const gruposRotos = [...resumenOrigen(origen).grupos.entries()]
    .filter(([, g]) => g.suma !== 0n)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  if (gruposRotos.length > 0) {
    const lista = gruposRotos.map(([id, g]) => `${id} (patas=${g.patas}, suma=${g.suma})`).join('; ');
    avisos.push(`${gruposRotos.length} grupo(s) de transferencia del origen no netean 0 (patas huérfanas, spec §9.3; se migran tal cual): ${lista}.`);
  }
  return avisos;
}

/** Vocabularios del origen y del destino, en un solo sitio: los usan
 *  `validarOrigen` (tarea 4) y el mapeo de bancos de `migrar()` (tarea 5). */
export const BANCOS_CUENTA_ORIGEN = {
  caixabank: 'caixabank', deutsche_bank: 'deutsche_bank', openbank: 'openbank', amex: 'amex',
  // Cuentas virtuales del origen: en 0036 `finance_accounts.bank` es NULL
  // (resolución canónica 6 del doc de interfaces).
  efectivo: null, inversion: null, manual: null
};
export const BANCOS_LOTE_DESTINO = ['caixabank', 'deutsche_bank', 'openbank', 'amex', 'manual'];
export const ESTADOS_DESTINO = ['pendiente', 'sugerida_regla', 'sugerida_agente', 'confirmada'];
export const CLASES_CUENTA_DESTINO = ['comun', 'personal', 'inversion'];
export const CLASES_CATEGORIA_DESTINO = ['gasto', 'ingreso', 'transferencia'];
export const TIPOS_REGLA_DESTINO = ['proveedor_exacto', 'concepto_contiene', 'codigo_norma43'];
export const ORIGENES_REGLA_DESTINO = ['manual', 'agente'];

/** Invariantes que 0036 impone y el origen NO garantiza, comprobados ANTES de
 *  abrir la transacción: mejor una lista legible en el informe que un error
 *  crudo de `pg` a mitad de escritura. Orden de las comprobaciones fijo. */
export function validarOrigen(origen) {
  const problemas = [];
  const raices = origen.categories.filter((c) => c.parent_id === null && c.kind === 'transferencia');
  if (raices.length !== 1) {
    problemas.push(`${raices.length} categoría(s) raíz de tipo «transferencia» en el origen; el destino admite exactamente una (índice único parcial de 0036).`);
  }
  const porId = new Map(origen.categories.map((c) => [c.id, c]));
  const nietas = origen.categories.filter((c) => c.parent_id !== null && (porId.get(c.parent_id)?.parent_id ?? null) !== null);
  if (nietas.length > 0) {
    problemas.push(`${nietas.length} categoría(s) de tercer nivel (ids: ${nietas.map((c) => c.id).join(', ')}); el destino solo admite árbol de 2 niveles (trigger de 0036).`);
  }
  const largos = origen.transactions.filter((t) => t.concept.length > 500);
  if (largos.length > 0) {
    problemas.push(`${largos.length} transacción(es) con concept de más de 500 caracteres (ids: ${largos.map((t) => t.id).join(', ')}); el destino lo limita con CHECK.`);
  }
  for (const t of origen.transactions) {
    if (!ESTADOS_DESTINO.includes(t.status)) {
      problemas.push(`Transacción ${t.id} con status «${t.status}» fuera del vocabulario del destino (${ESTADOS_DESTINO.join(', ')}).`);
    }
  }
  for (const c of origen.accounts) {
    if (!CLASES_CUENTA_DESTINO.includes(c.kind)) {
      problemas.push(`Cuenta ${c.id} («${c.name}») con kind «${c.kind}» fuera del vocabulario del destino (${CLASES_CUENTA_DESTINO.join(', ')}).`);
    }
  }
  for (const c of origen.accounts) {
    if (!(c.bank in BANCOS_CUENTA_ORIGEN)) {
      problemas.push(`Cuenta ${c.id} («${c.name}») con bank «${c.bank}» fuera del vocabulario del origen (${Object.keys(BANCOS_CUENTA_ORIGEN).join(', ')}).`);
    }
  }
  for (const b of origen.importBatches) {
    if (!BANCOS_LOTE_DESTINO.includes(b.bank)) {
      problemas.push(`Lote ${b.id} («${b.filename}») con bank «${b.bank}» fuera del vocabulario del destino (${BANCOS_LOTE_DESTINO.join(', ')}).`);
    }
  }
  for (const c of origen.categories) {
    if (!CLASES_CATEGORIA_DESTINO.includes(c.kind)) {
      problemas.push(`Categoría ${c.id} («${c.name}») con kind «${c.kind}» fuera del vocabulario del destino (${CLASES_CATEGORIA_DESTINO.join(', ')}).`);
    }
  }
  for (const r of origen.rules.filter((x) => x.active)) {
    if (!TIPOS_REGLA_DESTINO.includes(r.match_type)) {
      problemas.push(`Regla ${r.id} con match_type «${r.match_type}» fuera del vocabulario del destino (${TIPOS_REGLA_DESTINO.join(', ')}).`);
    }
    if (!ORIGENES_REGLA_DESTINO.includes(r.origin)) {
      problemas.push(`Regla ${r.id} con origin «${r.origin}» fuera del vocabulario del destino (${ORIGENES_REGLA_DESTINO.join(', ')}).`);
    }
  }
  return problemas;
}

export function compararResumenes(a, b) {
  const lineas = [];
  const anotar = (seccion, etiqueta, ok, detalle) => lineas.push({ seccion, etiqueta, ok, detalle });
  for (const tabla of Object.keys(a.conteos)) {
    const real = b.conteos[tabla] ?? 0;
    anotar('conteos', tabla, real === a.conteos[tabla], `origen=${a.conteos[tabla]} destino=${real}`);
  }
  for (const clave of [...new Set([...a.sumasCuentaMes.keys(), ...b.sumasCuentaMes.keys()])].sort()) {
    const x = a.sumasCuentaMes.get(clave) ?? 0n;
    const y = b.sumasCuentaMes.get(clave) ?? 0n;
    anotar('sumas', clave, x === y, `origen=${x} destino=${y}`);
  }
  anotar('grupos', 'total de grupos', a.grupos.size === b.grupos.size, `origen=${a.grupos.size} destino=${b.grupos.size}`);
  for (const grupo of [...new Set([...a.grupos.keys(), ...b.grupos.keys()])].sort()) {
    const x = a.grupos.get(grupo) ?? { patas: 0, suma: 0n };
    const y = b.grupos.get(grupo) ?? { patas: 0, suma: 0n };
    // SOLO origen↔destino. «Cada grupo netea 0» NO se exige aquí: el origen
    // tiene patas huérfanas legítimas (transfers.py::orphan_legs) y exigirlo
    // haría fallar una migración fiel. Ese invariante va a avisosOrigen.
    anotar('grupos', `grupo ${grupo} (patas y suma)`,
      x.patas === y.patas && x.suma === y.suma,
      `origen patas=${x.patas} suma=${x.suma}; destino patas=${y.patas} suma=${y.suma}`);
  }
  for (const estado of [...new Set([...a.estados.keys(), ...b.estados.keys()])].sort()) {
    const x = a.estados.get(estado) ?? 0;
    const y = b.estados.get(estado) ?? 0;
    anotar('estados', estado, x === y, `origen=${x} destino=${y}`);
  }
  anotar('fechas', 'op_date min/max', a.fechaMin === b.fechaMin && a.fechaMax === b.fechaMax,
    `origen=${a.fechaMin}…${a.fechaMax} destino=${b.fechaMin}…${b.fechaMax}`);
  return { ok: lineas.every((l) => l.ok), lineas };
}

export function verificarHashes(origen, computeDedupHash, { muestra = 500 } = {}) {
  const cuentasPorId = new Map(origen.accounts.map((c) => [c.id, c]));
  const esSha256 = /^[0-9a-f]{64}$/;
  const discrepancias = [];
  let comprobados = 0;
  let descartados = 0;
  for (const tx of origen.transactions) {
    if (comprobados >= muestra) break;
    const cuenta = cuentasPorId.get(tx.account_id);
    // Amex lleva dedup_ref (columna Referencia) que el origen no persiste en
    // la tabla; los prefijos manual-/cashpair-/invmirror- no son sha256.
    if (cuenta.bank === 'amex' || !esSha256.test(tx.dedup_hash)) {
      descartados += 1;
      continue;
    }
    const recalculado = computeDedupHash({
      bankRef: cuenta.bank_ref, opDate: tx.op_date, amountCents: tx.amount_cents,
      concept: tx.concept, balanceCents: tx.balance_cents, dedupRef: null
    });
    comprobados += 1;
    if (recalculado !== tx.dedup_hash) discrepancias.push({ id: tx.id, esperado: tx.dedup_hash, recalculado });
  }
  return { comprobados, descartados, discrepancias };
}

export function renderInforme({ modo, hogar, rutaSqlite, copia, comparacion, hashes, avisos,
  motivoAborto = null, ahora = new Date() }) {
  const ok = motivoAborto === null && hashes.discrepancias.length === 0
    && comparacion !== null && comparacion.ok;
  const marca = (bien) => (bien ? '✓' : '✗');
  const l = ['# Informe de verificación — migración home-finance → casa-clara', '',
    `- Fecha: ${ahora.toISOString()}`, `- Modo: ${modo}`, `- Origen: ${rutaSqlite}`,
    `- Hogar destino: ${hogar}`, ''];
  if (motivoAborto !== null) {
    l.push('## Aborto', '', `La ejecución se interrumpió: ${motivoAborto}`, '');
  }
  // La copia del PASO 0 es la garantía frente al riesgo «única copia de la base
  // origen» (spec §13): su ruta y su sha256 viven en el informe, que se guarda,
  // no solo en la consola, que se pierde al cerrar la terminal.
  l.push('## Copia de seguridad (PASO 0)', '');
  l.push(copia === null
    ? `- (no se hizo copia en esta ejecución${modo === 'verify-only' ? ': --verify-only no escribe' : ''})`
    : `- fichero: ${copia.destino}\n- sha256: ${copia.sha256}`);
  l.push('');
  for (const [titulo, clave] of [
    ['Conteos por tabla', 'conteos'],
    ['Sumas de amount_cents por cuenta y mes', 'sumas'],
    ['Grupos de transferencia', 'grupos'],
    ['Distribución de estados', 'estados'],
    ['Rango de fechas', 'fechas']
  ]) {
    l.push(`## ${titulo}`, '');
    if (comparacion === null) {
      l.push('(sin datos: la migración abortó antes de escribir en la base destino)', '');
      continue;
    }
    for (const linea of comparacion.lineas.filter((x) => x.seccion === clave)) {
      l.push(`- ${marca(linea.ok)} ${linea.etiqueta}: ${linea.detalle}`);
    }
    l.push('');
  }
  l.push('## Verificación cruzada de dedup_hash', '',
    `- comprobados: ${hashes.comprobados}`,
    `- descartados (prefijos manual-/cashpair-/invmirror- y cuentas amex): ${hashes.descartados}`);
  if (hashes.discrepancias.length === 0) l.push('- ✓ sin discrepancias');
  else for (const d of hashes.discrepancias) l.push(`- ✗ transacción origen ${d.id}: almacenado ${d.esperado} ≠ recalculado ${d.recalculado}`);
  l.push('', '## Avisos', '', ...(avisos.length ? avisos.map((a) => `- ${a}`) : ['- (ninguno)']));
  l.push('', `Resultado: ${ok ? 'OK' : 'FALLO'}`, '');
  return l.join('\n');
}
```

- [ ] **Step 4: Verde** — mismo comando. Esperado: PASS, 16 tests (6 de la Task 3 + 3 de resúmenes/comparación + 2 de `verificarHashes` + 2 de `validarOrigen` + 3 de avisos/informe).

- [ ] **Step 5: Commit**

```bash
git add packages/db/scripts/migrar-home-finance.mjs packages/db/scripts/migrar-home-finance.test.mjs
git commit -m "feat(db): ETL home-finance — resúmenes, validación del origen, verificación cruzada e informe"
```

---

### Task 5: ETL — escritura en Postgres con mapeo entero→uuid

**Files:**
- Modify: `packages/db/scripts/migrar-home-finance.mjs`
- Test: `packages/db/scripts/migrar-home-finance.pg.test.mjs` (crear)

**Interfaces:**
- Consumes: esquema `0036_finance.sql` (fase 1: tablas `app.finance_*`, PK `(household_id, id)`, `currency_code CHECK='EUR'`, `raw jsonb NOT NULL DEFAULT '{}'`, `finance_accounts.bank` NULL o uno de los cuatro bancos reales y `finance_import_batches.bank` con `'manual'` admitido — resoluciones canónicas 6 y 8); `applyMigrations(client, opts)` de `packages/db/scripts/migrate.mjs`; Tasks 2–4. **Antes de escribir el test, abre `packages/db/migrations/0036_finance.sql` en el worktree y comprueba esos tres CHECK**: si la fase 1 los dejó de otra forma, es defecto suyo y hay que reportarlo, no parchear el ETL.
- Produces: `migrar(client, householdId, origen): Promise<void>` (dentro de una transacción abierta por quien llama); `resumenDestino(client, householdId)` (misma forma que `resumenOrigen`).

**Reglas de mapeo (spec §5 y §9):** enteros→uuid con `randomUUID()` y mapas de correspondencia; `owner`→`owner_label`; JSON→`jsonb` verbatim; fechas TEXT→`date`; `dedup_hash`, `transfer_group_id`, estados y prefijos preservados byte a byte; `provider_norm` = `normText(provider)` (o NULL si vacío); solo reglas `active`; céntimos como `String(bigint)` en los parámetros; `currency_code='EUR'` explícito; padres de categoría antes que hijas; **`bank` de cuenta traducido** con `BANCOS_CUENTA_ORIGEN` (Task 4): `efectivo`/`inversion`/`manual` → `NULL`, valor no contemplado → error claro (resolución canónica 6); **`bank` de lote** pasa tal cual (el destino admite además `'manual'`); `raw` ya llega coalescido a `'{}'` desde `leerOrigen` (resolución canónica 8).

- [ ] **Step 0: Postgres local** — arrancar el clúster compartido y exportar la variable (si ya corre, `docker start` no hace nada y solo se exporta):

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
docker start casaclara-it-pg 2>/dev/null || true
until docker exec casaclara-it-pg pg_isready -U ci_admin; do sleep 1; done
export TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_etl"
```

- [ ] **Step 1: Test que falla** — crear `packages/db/scripts/migrar-home-finance.pg.test.mjs`:

```js
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeDedupHash } from '../../server/src/finance/dedup-hash.ts';
import { applyMigrations } from './migrate.mjs';
import { construirSqliteSintetica, GRUPO_TRASPASO, TOTALES } from './home-finance-sintetica.mjs';
import { compararResumenes, leerOrigen, migrar, resumenDestino, resumenOrigen } from './migrar-home-finance.mjs';

const adminUrl = process.env.TEST_DATABASE_URL;
const HOGAR = '7f000000-0000-4000-8000-000000000001';

export async function reiniciarBase(client) {
  await client.query('drop schema if exists app cascade');
  await client.query('drop schema if exists app_private cascade');
  await client.query('drop table if exists public.schema_migrations');
  await applyMigrations(client);
}

describe.runIf(Boolean(adminUrl))('migrar() contra Postgres real', () => {
  let client; let dir; let origen;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await reiniciarBase(client);
    await client.query('set row_security = off'); // propietario local, como las fixtures
    await client.query(`insert into app.households (id, slug, display_name)
      values ($1, 'hogar-etl', 'Hogar del ETL')`, [HOGAR]);
    dir = await mkdtemp(path.join(os.tmpdir(), 'etl-pg-'));
    const ruta = path.join(dir, 'finanzas-sintetica.db');
    construirSqliteSintetica(ruta, { computeDedupHash });
    origen = leerOrigen(ruta);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('inserta el origen completo y los resúmenes origen=destino casan', async () => {
    await client.query('begin');
    try {
      await migrar(client, HOGAR, origen);
      const destino = await resumenDestino(client, HOGAR);
      const comparacion = compararResumenes(resumenOrigen(origen), destino);
      expect(comparacion.lineas.filter((l) => !l.ok)).toEqual([]);
      expect(destino.conteos.finance_transactions).toBe(TOTALES.transactions);
      expect(destino.conteos.finance_rules).toBe(TOTALES.rulesActivas);

      const { rows: [nomina] } = await client.query(
        `select recurrence, recurrence_manual, provider_norm, currency_code
           from app.finance_transactions where household_id = $1 and concept = 'NOMINA EMPRESA EJEMPLO SL'`, [HOGAR]);
      expect(nomina).toEqual({ recurrence: 'recurrente', recurrence_manual: true,
        provider_norm: 'EMPRESA EJEMPLO', currency_code: 'EUR' });

      const { rows: [farmacia] } = await client.query(
        `select provider, provider_norm, dedup_hash from app.finance_transactions
          where household_id = $1 and concept = 'GASTO EN EFECTIVO FARMACIA'`, [HOGAR]);
      expect(farmacia).toEqual({ provider: 'Farmacia Ñuñez', provider_norm: 'FARMACIA NUNEZ',
        dedup_hash: 'manual-a1b2c3d4e5f60718' });

      const { rows: patas } = await client.query(
        `select amount_cents::text as importe from app.finance_transactions
          where household_id = $1 and transfer_group_id = $2 order by amount_cents`, [HOGAR, GRUPO_TRASPASO]);
      expect(patas.map((p) => p.importe)).toEqual(['-50000', '50000']);

      const { rows: [hija] } = await client.query(
        `select h.name from app.finance_categories h
           join app.finance_categories p on p.household_id = h.household_id and p.id = h.parent_id
          where h.household_id = $1 and p.name = 'Alimentación'`, [HOGAR]);
      expect(hija.name).toBe('Supermercado');

      const { rows: [crudo] } = await client.query(
        `select raw->>'Concepto' as concepto from app.finance_transactions
          where household_id = $1 and concept like 'COMPRA SUPERMERCADOS%'`, [HOGAR]);
      expect(crudo.concepto).toBe('COMPRA SUPERMERCADOS ACME S.L.');

      // raw nullable en el origen → '{}' en destino (la columna es NOT NULL).
      const { rows: [sinRaw] } = await client.query(
        `select raw::text as raw from app.finance_transactions
          where household_id = $1 and concept = 'NOMINA EMPRESA EJEMPLO SL'`, [HOGAR]);
      expect(sinRaw.raw).toBe('{}');

      // Vocabulario de bancos: cuentas virtuales → NULL, lote manual intacto.
      const { rows: sinBanco } = await client.query(
        `select bank_ref from app.finance_accounts
          where household_id = $1 and bank is null order by bank_ref`, [HOGAR]);
      expect(sinBanco.map((f) => f.bank_ref)).toEqual(['EFECTIVO', 'INV-SINTETICO']);
      const { rows: [loteManual] } = await client.query(
        `select bank from app.finance_import_batches
          where household_id = $1 and filename = 'manual'`, [HOGAR]);
      expect(loteManual.bank).toBe('manual');
    } finally {
      await client.query('rollback');
    }
  }, 120_000);
});
```

- [ ] **Step 2: Verlo fallar**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @housekeeper/db exec vitest run scripts/migrar-home-finance.pg.test.mjs
```

Esperado: FAIL, `does not provide an export named 'migrar'`.

- [ ] **Step 3: Implementación** — esta tarea estrena `randomUUID`, así que lo PRIMERO es ampliar el import de `node:crypto` en la cabecera de `migrar-home-finance.mjs` (sustituir la línea entera, no añadir otra):

```js
import { createHash, randomUUID } from 'node:crypto';
```

Y después añadir al final del fichero, antes de cualquier bloque de ejecución directa:

```js
const esUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `finance_accounts.bank`: los cuatro bancos reales pasan; las cuentas
 *  virtuales del origen (efectivo/inversion/manual) van a NULL; cualquier otro
 *  valor es un dato que nadie previó y la migración se para AQUÍ, con nombre y
 *  apellidos, en vez de reventar con un CHECK de Postgres a mitad de escritura. */
export function bancoDeCuenta(cuenta) {
  if (!(cuenta.bank in BANCOS_CUENTA_ORIGEN)) {
    throw new Error(`La cuenta ${cuenta.id} («${cuenta.name}») tiene bank «${cuenta.bank}», que no está contemplado (${Object.keys(BANCOS_CUENTA_ORIGEN).join(', ')}). Amplía BANCOS_CUENTA_ORIGEN o corrige el origen antes de migrar.`);
  }
  return BANCOS_CUENTA_ORIGEN[cuenta.bank];
}

/** `finance_import_batches.bank`: el destino admite los cuatro bancos y
 *  además 'manual' (resolución canónica 6), así que se pasa tal cual. */
export function bancoDeLote(lote) {
  if (!BANCOS_LOTE_DESTINO.includes(lote.bank)) {
    throw new Error(`El lote ${lote.id} («${lote.filename}») tiene bank «${lote.bank}», que el destino no admite (${BANCOS_LOTE_DESTINO.join(', ')}).`);
  }
  return lote.bank;
}

/** Inserta el origen completo bajo el hogar dado. SIEMPRE dentro de una
 *  transacción abierta por quien llama (una sola transacción, spec §9.2). */
export async function migrar(client, householdId, origen) {
  const mapas = { cuentas: new Map(), categorias: new Map(), lotes: new Map(), transacciones: new Map(), eventos: new Map() };
  for (const c of origen.accounts) {
    const id = randomUUID();
    mapas.cuentas.set(c.id, id);
    await client.query(
      `INSERT INTO app.finance_accounts (household_id, id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
      [householdId, id, c.name, bancoDeCuenta(c), c.kind, c.owner, c.bank_ref, c.owner_aliases, c.transfer_refs]);
  }
  const padres = origen.categories.filter((c) => c.parent_id === null);
  const hijas = origen.categories.filter((c) => c.parent_id !== null);
  for (const c of [...padres, ...hijas]) {
    const id = randomUUID();
    mapas.categorias.set(c.id, id);
    await client.query(
      `INSERT INTO app.finance_categories (household_id, id, parent_id, name, kind)
       VALUES ($1, $2, $3, $4, $5)`,
      [householdId, id, c.parent_id === null ? null : mapas.categorias.get(c.parent_id), c.name, c.kind]);
  }
  for (const r of origen.rules) {
    if (!r.active) continue; // el destino no conserva reglas apagadas (aviso en el informe)
    await client.query(
      `INSERT INTO app.finance_rules (household_id, id, rule_type, pattern, category_id, priority, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [householdId, randomUUID(), r.match_type, r.pattern, mapas.categorias.get(r.category_id), r.priority, r.origin]);
  }
  for (const b of origen.importBatches) {
    const id = randomUUID();
    mapas.lotes.set(b.id, id);
    await client.query(
      `INSERT INTO app.finance_import_batches (household_id, id, filename, bank, imported_at, new_count, dup_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [householdId, id, b.filename, bancoDeLote(b), b.imported_at, b.new_count, b.dup_count]);
  }
  for (const t of origen.transactions) {
    if (t.transfer_group_id !== null && !esUuid.test(t.transfer_group_id)) {
      throw new Error(`La transacción ${t.id} tiene transfer_group_id no-UUID: ${t.transfer_group_id}`);
    }
    const id = randomUUID();
    mapas.transacciones.set(t.id, id);
    await client.query(
      `INSERT INTO app.finance_transactions (household_id, id, account_id, batch_id, op_date, value_date,
         concept, provider, provider_norm, amount_cents, balance_cents, code_common, code_own,
         category_id, status, transfer_group_id, dedup_hash, recurrence, recurrence_manual,
         bank_category, raw, currency_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, 'EUR')`,
      [householdId, id, mapas.cuentas.get(t.account_id), mapas.lotes.get(t.batch_id),
        t.op_date, t.value_date, t.concept, t.provider, t.provider ? normText(t.provider) : null,
        String(t.amount_cents), t.balance_cents === null ? null : String(t.balance_cents),
        t.code_common, t.code_own, t.category_id === null ? null : mapas.categorias.get(t.category_id),
        t.status, t.transfer_group_id, t.dedup_hash, t.recurrence, t.recurrence_manual,
        // `leerOrigen` ya coalesce raw a '{}'; el ?? es la red por si migrar()
        // recibe un origen construido a mano (la columna es NOT NULL en 0036).
        t.bank_category, t.raw ?? '{}']);
  }
  for (const a of origen.providerAliases) {
    await client.query(
      `INSERT INTO app.finance_provider_aliases (household_id, id, provider_norm, display)
       VALUES ($1, $2, $3, $4)`,
      [householdId, randomUUID(), a.provider_norm, a.alias]);
  }
  for (const e of origen.events) {
    const id = randomUUID();
    mapas.eventos.set(e.id, id);
    await client.query(
      `INSERT INTO app.finance_events (household_id, id, name) VALUES ($1, $2, $3)`,
      [householdId, id, e.name]);
  }
  for (const v of origen.transactionEvents) {
    await client.query(
      `INSERT INTO app.finance_transaction_events (household_id, id, transaction_id, event_id)
       VALUES ($1, $2, $3, $4)`,
      [householdId, randomUUID(), mapas.transacciones.get(v.transaction_id), mapas.eventos.get(v.event_id)]);
  }
  for (const v of origen.eventRules) {
    await client.query(
      `INSERT INTO app.finance_event_rules (household_id, id, provider_norm, concept_norm, category_id, event_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [householdId, randomUUID(), v.provider_norm, v.concept_norm,
        v.category_id === null ? null : mapas.categorias.get(v.category_id), mapas.eventos.get(v.event_id)]);
  }
}

export async function resumenDestino(client, householdId) {
  const conteos = {};
  for (const tabla of TABLAS_DESTINO) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM app.${tabla} WHERE household_id = $1`, [householdId]);
    conteos[tabla] = rows[0].n;
  }
  const sumas = await client.query(
    `SELECT a.bank_ref, to_char(t.op_date, 'YYYY-MM') AS mes, sum(t.amount_cents)::text AS suma
       FROM app.finance_transactions t
       JOIN app.finance_accounts a ON a.household_id = t.household_id AND a.id = t.account_id
      WHERE t.household_id = $1 GROUP BY 1, 2`, [householdId]);
  const gruposQ = await client.query(
    `SELECT transfer_group_id::text AS grupo, count(*)::int AS patas, sum(amount_cents)::text AS suma
       FROM app.finance_transactions
      WHERE household_id = $1 AND transfer_group_id IS NOT NULL GROUP BY 1`, [householdId]);
  const estadosQ = await client.query(
    `SELECT status::text AS estado, count(*)::int AS n
       FROM app.finance_transactions WHERE household_id = $1 GROUP BY 1`, [householdId]);
  const fechas = await client.query(
    `SELECT min(op_date)::text AS min, max(op_date)::text AS max
       FROM app.finance_transactions WHERE household_id = $1`, [householdId]);
  return {
    conteos,
    sumasCuentaMes: new Map(sumas.rows.map((f) => [`${f.bank_ref}|${f.mes}`, BigInt(f.suma)])),
    grupos: new Map(gruposQ.rows.map((f) => [f.grupo, { patas: f.patas, suma: BigInt(f.suma) }])),
    estados: new Map(estadosQ.rows.map((f) => [f.estado, f.n])),
    fechaMin: fechas.rows[0].min,
    fechaMax: fechas.rows[0].max
  };
}
```

- [ ] **Step 4: Verde** — mismo comando del Step 2. Esperado: PASS, 1 test (no saltado: comprueba que la variable `TEST_DATABASE_URL` está exportada).

- [ ] **Step 5: Commit**

```bash
git add packages/db/scripts/migrar-home-finance.mjs packages/db/scripts/migrar-home-finance.pg.test.mjs
git commit -m "feat(db): ETL home-finance — escritura en Postgres con mapeo entero→uuid"
```

---

### Task 6: ETL — CLI completa: dry-run, verify-only y abortos de guarda

**Files:**
- Modify: `packages/db/scripts/migrar-home-finance.mjs` (añadir `main` y bloque de ejecución directa al FINAL del fichero)
- Modify: `packages/db/scripts/migrar-home-finance.pg.test.mjs` (añadir describe)
- Modify: `packages/db/package.json` (script `migrar:home-finance`)

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: CLI `node scripts/migrar-home-finance.mjs --sqlite … --database-url … --household <slug> [--backup-dir …] [--dry-run] [--verify-only] [--force-empty-check]`. `--sqlite` y `--database-url` son OBLIGATORIOS y el guion NO lee `DATABASE_URL` del entorno (resolución canónica 12). Códigos de salida: 0 verificación OK; 1 fallo de verificación o aborto de guarda (hogar inexistente, hogar ya poblado, origen inválido, hashes discrepantes); 2 error de uso (argumentos que faltan, sobran o se excluyen, y `--backup-dir` dentro de un repo git: ahí no se puede escribir el informe). Además: `emitirInforme(opciones, contexto): Promise<string>`. Alias pnpm: `pnpm --filter @housekeeper/db migrar:home-finance -- <flags>`.

**Semántica (spec §9):** toda ejecución que escribe empieza por la copia de seguridad datada (PASO 0); una sola transacción; el origen se valida con `validarOrigen` ANTES de tocar nada; si el hogar ya tiene datos de finanzas aborta salvo `--force-empty-check`; si la verificación cruzada de hashes falla NO se escribe nada; `--dry-run` = migrar + verificar + ROLLBACK; `--verify-only` = comparar origen contra lo ya migrado sin escribir.

**El informe se emite SIEMPRE, y «siempre» incluye los abortos.** Es la exigencia que da forma a `main()`: el camino feliz y el de fallo terminan los dos en `emitirInforme`, invocado desde un `finally`, con `motivoAborto` relleno cuando algo se rompió. Un `throw` que salte por encima de la emisión deja sin evidencia forense justo la ejecución que más la necesita: por eso ninguna guarda lanza hacia fuera de `main()` salvo las de uso (que ocurren antes de saber siquiera dónde escribir).

- [ ] **Step 1: Tests que fallan** — añadir al final de `migrar-home-finance.pg.test.mjs` (a los imports: `spawnSync` de `node:child_process`; `mkdir`, `readdir`, `readFile` de `node:fs/promises`; `fileURLToPath` de `node:url`; y `SUMAS_CUENTA_MES` de `./home-finance-sintetica.mjs`):

```js
describe.runIf(Boolean(adminUrl))('CLI migrar-home-finance', () => {
  let client; let dir; let backupDir; let rutaSqlite;
  const HOGAR_CLI = '7f000000-0000-4000-8000-000000000002';
  const guion = fileURLToPath(new URL('./migrar-home-finance.mjs', import.meta.url));
  const ejecutar = (extra, hogar = 'hogar-cli') => spawnSync(process.execPath,
    [guion, '--sqlite', rutaSqlite, '--database-url', adminUrl,
      '--household', hogar, '--backup-dir', backupDir, ...extra],
    { encoding: 'utf8' });

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await reiniciarBase(client);
    await client.query('set row_security = off');
    await client.query(`insert into app.households (id, slug, display_name) values
      ($1, 'hogar-cli', 'Hogar CLI'), ($2, 'hogar-corrupto', 'Hogar corrupto')`,
      [HOGAR_CLI, '7f000000-0000-4000-8000-000000000003']);
    dir = await mkdtemp(path.join(os.tmpdir(), 'etl-cli-'));
    backupDir = path.join(dir, 'copias');
    await mkdir(backupDir, { recursive: true });
    rutaSqlite = path.join(dir, 'finanzas-sintetica.db');
    construirSqliteSintetica(rutaSqlite, { computeDedupHash });
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const contarTx = async (hogar) => (await client.query(
    `select count(*)::int as n from app.finance_transactions t
      join app.households h on h.id = t.household_id where h.slug = $1`, [hogar])).rows[0].n;

  it('sin argumentos obligatorios sale con código 2', () => {
    const r = spawnSync(process.execPath, [guion], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Uso:');
  });

  it('--dry-run verifica, hace copia y revierte', async () => {
    const r = ejecutar(['--dry-run']);
    expect(r.stderr).toBe(r.status === 0 ? r.stderr : ''); // en fallo, muestra stderr en el diff
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DRY-RUN');
    expect(r.stdout).toContain('Resultado: OK');
    expect(await contarTx('hogar-cli')).toBe(0);
    const ficheros = await readdir(backupDir);
    expect(ficheros.some((f) => /^finanzas-.*\.db$/.test(f))).toBe(true);
  });

  it('la ejecución real migra, guarda informe y los números casan', async () => {
    const r = ejecutar([]);
    expect(r.status).toBe(0);
    expect(await contarTx('hogar-cli')).toBe(TOTALES.transactions);
    expect(r.stdout).toContain(`comprobados: ${TOTALES.hashesComprobables}`);
    const { rows: sumas } = await client.query(
      `select to_char(t.op_date, 'YYYY-MM') as mes, sum(t.amount_cents)::text as suma
         from app.finance_transactions t
         join app.finance_accounts a on a.household_id = t.household_id and a.id = t.account_id
         join app.households h on h.id = t.household_id
        where h.slug = 'hogar-cli' and a.bank_ref = '00490001512345678901'
        group by 1 order by 1`);
    // Las sumas esperadas salen de la constante de la muestra, no de literales.
    expect(sumas).toEqual(Object.entries(SUMAS_CUENTA_MES['00490001512345678901'])
      .map(([mes, suma]) => ({ mes, suma: String(suma) })));
    const informes = (await readdir(backupDir)).filter((f) => /^informe-migracion-.*\.md$/.test(f)).sort();
    expect(informes.length).toBeGreaterThan(0);
    const texto = await readFile(path.join(backupDir, informes.at(-1)), 'utf8');
    expect(texto).toContain('Resultado: OK');
    expect(texto).toContain('## Copia de seguridad (PASO 0)');
  });

  it('reejecutar aborta porque el hogar ya tiene datos', async () => {
    const r = ejecutar([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ya tiene');
    expect(await contarTx('hogar-cli')).toBe(TOTALES.transactions);
  });

  it('el aborto también deja informe, con el motivo dentro', async () => {
    const antes = (await readdir(backupDir)).filter((f) => /^informe-migracion-.*\.md$/.test(f));
    const r = ejecutar([]);
    expect(r.status).toBe(1);
    const despues = (await readdir(backupDir)).filter((f) => /^informe-migracion-.*\.md$/.test(f)).sort();
    expect(despues.length).toBe(antes.length + 1); // el informe existe justo cuando hace falta
    const texto = await readFile(path.join(backupDir, despues.at(-1)), 'utf8');
    expect(texto).toContain('## Aborto');
    expect(texto).toContain('ya tiene');
    expect(texto).toContain('Resultado: FALLO');
  });

  it('--verify-only da OK sobre lo migrado y FALLO sobre un hogar vacío', () => {
    const bien = ejecutar(['--verify-only']);
    expect(bien.status).toBe(0);
    expect(bien.stdout).toContain('Resultado: OK');
    const mal = ejecutar(['--verify-only'], 'hogar-corrupto');
    expect(mal.status).toBe(1);
    expect(mal.stdout).toContain('Resultado: FALLO');
  });

  it('un dedup_hash corrupto aborta antes de escribir', async () => {
    const rutaCorrupta = path.join(dir, 'finanzas-corrupta.db');
    construirSqliteSintetica(rutaCorrupta, { computeDedupHash, corromperHashDeTx: 2 });
    const r = spawnSync(process.execPath,
      [guion, '--sqlite', rutaCorrupta, '--database-url', adminUrl,
        '--household', 'hogar-corrupto', '--backup-dir', backupDir],
      { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Resultado: FALLO');
    expect(await contarTx('hogar-corrupto')).toBe(0);
  });
});
```

- [ ] **Step 2: Verlos fallar**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_etl"
pnpm --filter @housekeeper/db exec vitest run scripts/migrar-home-finance.pg.test.mjs
```

Esperado: FAIL — el subproceso importa el guion, que no tiene bloque de ejecución directa, sale con status 0 sin hacer nada y las aserciones de status/salida fallan.

- [ ] **Step 3: Implementación** — esta tarea estrena `process`, `writeFile`, `fileURLToPath`, `pg` y el cargador de TS, así que lo PRIMERO es dejar la cabecera de imports de `migrar-home-finance.mjs` exactamente así (se sustituyen las líneas de `node:fs/promises`, y se añaden las cuatro que faltan en su orden):

```js
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import pg from 'pg';

import { importarModuloTs, rutaDedupHash } from './cargar-ts.mjs';
```

Y después añadir al FINAL de `migrar-home-finance.mjs`:

```js
/** Imprime y guarda el informe. Se llama desde el `finally` de main(): pase lo
 *  que pase, la ejecución deja artefacto en --backup-dir. */
export async function emitirInforme(opciones, contexto) {
  const informe = renderInforme(contexto);
  console.log(`\n${informe}`);
  await mkdir(opciones.backupDir, { recursive: true });
  const rutaInforme = path.join(opciones.backupDir,
    `informe-migracion-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  await writeFile(rutaInforme, informe, 'utf8');
  console.log(`Informe guardado en ${rutaInforme}`);
  return rutaInforme;
}

async function main() {
  const opciones = parseArgs(process.argv.slice(2));
  const modo = opciones.verifyOnly ? 'verify-only' : opciones.dryRun ? 'dry-run' : 'real';
  // Única guarda que sale por arriba (código 2): si el directorio está dentro de
  // un repo, no hay dónde escribir el informe, así que no se puede prometer.
  if (await estaDentroDeUnRepo(opciones.backupDir)) {
    throw new ErrorDeUso(`El directorio ${opciones.backupDir} está dentro de un repositorio git; la copia y el informe deben vivir fuera de ambos repos.`);
  }
  const contexto = {
    modo, hogar: opciones.household, rutaSqlite: opciones.sqlite,
    copia: null, comparacion: null,
    hashes: { comprobados: 0, descartados: 0, discrepancias: [] },
    avisos: [], motivoAborto: null
  };
  let client = null;
  try {
    const origen = leerOrigen(opciones.sqlite);
    const problemas = validarOrigen(origen);
    if (problemas.length > 0) {
      throw new Error(`El origen incumple invariantes del esquema destino:\n- ${problemas.join('\n- ')}`);
    }
    const { computeDedupHash } = await importarModuloTs(rutaDedupHash);
    contexto.hashes = verificarHashes(origen, computeDedupHash);
    contexto.avisos = avisosOrigen(origen);
    const resOrigen = resumenOrigen(origen);

    if (!opciones.verifyOnly) {
      contexto.copia = await hacerCopiaSeguridad(opciones.sqlite, opciones.backupDir);
      console.log(`Paso 0 — copia de seguridad: ${contexto.copia.destino} (sha256 ${contexto.copia.sha256})`);
    }

    client = new pg.Client({ connectionString: opciones.databaseUrl });
    await client.connect();
    // Propietario por conexión directa, como las migraciones: en local es
    // superusuario; en Supabase el runner deja FORCE relajado (0018), así que
    // row_security=off da acceso de propietario en ambos casos.
    await client.query('SET row_security = off');
    const hogares = await client.query('SELECT id FROM app.households WHERE slug = $1', [opciones.household]);
    if (hogares.rows.length !== 1) {
      throw new Error(`No existe ningún hogar con slug «${opciones.household}» en la base destino.`);
    }
    const householdId = hogares.rows[0].id;

    if (opciones.verifyOnly) {
      contexto.comparacion = compararResumenes(resOrigen, await resumenDestino(client, householdId));
    } else {
      const { rows } = await client.query(
        `SELECT ((SELECT count(*) FROM app.finance_accounts WHERE household_id = $1)
               + (SELECT count(*) FROM app.finance_categories WHERE household_id = $1)
               + (SELECT count(*) FROM app.finance_transactions WHERE household_id = $1))::int AS filas`,
        [householdId]);
      if (rows[0].filas > 0 && !opciones.forceEmptyCheck) {
        throw new Error(`El hogar «${opciones.household}» ya tiene ${rows[0].filas} filas de finanzas; aborto. Usa --verify-only para comparar sin escribir, o --force-empty-check si sabes lo que haces.`);
      }
      if (contexto.hashes.discrepancias.length > 0) {
        console.error('Verificación cruzada de dedup_hash fallida: no se escribe nada en la base destino.');
      } else {
        await client.query('BEGIN');
        await migrar(client, householdId, origen);
        contexto.comparacion = compararResumenes(resOrigen, await resumenDestino(client, householdId));
        if (opciones.dryRun || !contexto.comparacion.ok) {
          await client.query('ROLLBACK');
          console.log(opciones.dryRun
            ? 'DRY-RUN: transacción revertida; la base destino queda intacta.'
            : 'Verificación fallida: transacción revertida; la base destino queda intacta.');
        } else {
          await client.query('COMMIT');
          console.log('Transacción confirmada: datos migrados.');
        }
      }
    }
  } catch (error) {
    // Nada de re-lanzar: el motivo entra en el informe y el código de salida.
    contexto.motivoAborto = error.message ?? String(error);
    console.error(contexto.motivoAborto);
    if (client) {
      try {
        await client.query('ROLLBACK'); // si no había transacción abierta, es inocuo
      } catch {
        // da igual: lo importante es no dejar la transacción a medias
      }
    }
  } finally {
    if (client) await client.end();
    await emitirInforme(opciones, contexto);
  }
  process.exitCode = contexto.motivoAborto === null
    && contexto.hashes.discrepancias.length === 0
    && contexto.comparacion !== null && contexto.comparacion.ok ? 0 : 1;
}

const esEjecucionDirecta =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esEjecucionDirecta) {
  try {
    await main();
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = error instanceof ErrorDeUso ? 2 : 1;
  }
}
```

Y en `packages/db/package.json`, dentro de `"scripts"` (el fichero está en orden alfabético estricto y `migrar` < `migrate` en la sexta letra, `r` < `t`: va entre `"manual:import"` y `"migrate"`):

```json
"migrar:home-finance": "node scripts/migrar-home-finance.mjs",
```

- [ ] **Step 4: Verde** — mismo comando del Step 2. Esperado: PASS, 8 tests (1 de la Task 5 + 7 de la CLI). Después, toda la suite de scripts:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @housekeeper/db test:import
```

Esperado: PASS (suites nuevas + wiki + migrate-with-history, en secuencia).

- [ ] **Step 5: Commit**

```bash
git add packages/db/scripts/migrar-home-finance.mjs packages/db/scripts/migrar-home-finance.pg.test.mjs packages/db/package.json
git commit -m "feat(db): ETL home-finance — CLI con dry-run, verify-only y abortos de guarda"
```

---

### Task 7: Runbook del ensayo y de producción, ensayo ejecutado y gates

**Files:**
- Create: `docs/runbooks/migracion-home-finance.md`

**Interfaces:**
- Consumes: la CLI de Task 6; `node scripts/home-finance-sintetica.mjs` (Task 2); `.claude/skills/operar-la-casa/referencia-instalacion.md` y `docs/despliegue/alta-de-hogar.md` (existen en el repo); `docs/runbooks/backup-restore.md` como patrón de estilo.
- Produces: runbook completo con ensayo local paso a paso y procedimiento de producción marcado «solo con confirmación explícita».

- [ ] **Step 1: Escribir el runbook** — crear `docs/runbooks/migracion-home-finance.md` (estilo de `docs/runbooks/backup-restore.md`: español, comandos exactos, advertencias en negrita):

````markdown
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
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
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

1. Base de ensayo LIMPIA (recreada de cero en el clúster compartido; no toques `casaclara_dev`):

```bash
docker exec casaclara-it-pg dropdb -U ci_admin --if-exists casaclara_ensayo
docker exec casaclara-it-pg createdb -U ci_admin casaclara_ensayo
export DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_ensayo"
```

2. Esquema completo (0001–0036; los roles de grupo los crea la 0001):

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

4. ETL en seco, luego real, luego verificación:

```bash
pnpm --filter @housekeeper/db migrar:home-finance -- \
  --sqlite ~/copias-home-finance/finanzas-sintetica.db \
  --database-url "$DATABASE_URL" --household hogar-ensayo --dry-run
pnpm --filter @housekeeper/db migrar:home-finance -- \
  --sqlite ~/copias-home-finance/finanzas-sintetica.db \
  --database-url "$DATABASE_URL" --household hogar-ensayo
pnpm --filter @housekeeper/db migrar:home-finance -- \
  --sqlite ~/copias-home-finance/finanzas-sintetica.db \
  --database-url "$DATABASE_URL" --household hogar-ensayo --verify-only
```

Las tres ejecuciones deben terminar en `Resultado: OK` (códigos de salida 0).
El informe queda en `~/copias-home-finance/informe-migracion-<fecha>.md`.
Conserva el del ensayo real: es el contraste del smoke.

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
migración concreta.** Es un paso de la fase 7; el ensayo local completo (con
datos reales) tiene que haber terminado en `Resultado: OK` antes.

1. Paso 0 de nuevo (copia datada del día).
2. `pnpm db:migrate` contra Supabase con la conexión DIRECTA 5432 del
   propietario (ver `docs/despliegue/acceso-produccion.md`).
3. ETL con `--dry-run` contra producción; revisar el informe completo.
4. ETL real; el informe debe decir `Resultado: OK`; después `--verify-only`.
5. Conceder Finanzas a la cuenta de Alberto (Ajustes → Finanzas) y comprobar
   visualmente las 7 pantallas contra el informe y contra
   `backend/data/informe-semestre1-2026.md`.
6. `pnpm backup:full` de casa-clara con los datos ya migrados.
7. La retirada del sistema antiguo (parar `cf-finanzas`, quemar credenciales,
   nota en el README del repo viejo) es de la fase 7 y tiene su propio plan.

Si cualquier paso imprime `Resultado: FALLO`, se aborta: el guion ya ha
revertido (o ni siquiera ha escrito). No se «arregla a mano» en producción:
se diagnostica en local con `--verify-only` y la copia del Paso 0.
````

- [ ] **Step 2: Ensayar el runbook con la base sintética** — ejecutar literalmente el Paso «Ensayo local» 1→4 y 6 con `~/copias-home-finance/finanzas-sintetica.db` generada por el comando del runbook (el smoke 5 no aplica: las pantallas llegan en fases 4–6). Esperado: `--dry-run`, real y `--verify-only` terminan con `Resultado: OK` y código 0; el `dropdb` del paso 6 deja el clúster como estaba y `casaclara-it-pg` sigue en pie. Si algo difiere del runbook escrito, corrige el runbook (no el recuerdo).

- [ ] **Step 3: Gates de la rama**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_etl"
pnpm lint
pnpm typecheck
pnpm --filter @housekeeper/db test:import
# test:db recrea el esquema: se le pasa SU base, no la del ETL (run-sql-tests.mjs
# prefiere TEST_DATABASE_URL sobre DATABASE_URL, así que hay que sobreescribirla).
TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_ci_integration" pnpm test:db
```

Esperado: todo en verde. Los otros tres gates de las Global Constraints **no aplican a esta fase y no hay que ejecutarlos**, por estas razones concretas:
- `pnpm check` es `svelte-check` de `apps/web`: esta fase no toca ningún `.svelte` ni nada de esa app.
- `pnpm test` es `pnpm -r --if-present test` y `packages/db` no expone script `test` (sus suites corren por `test:import`, que sí se ejecuta arriba); ningún otro paquete cambia.
- `pnpm test:rls` recorre `tests/020_rls_matrix.sql`: esta fase no añade políticas, roles ni fixtures SQL. `test:db` sí se corre, como red de seguridad de que nada de lo añadido rompe el runner SQL.

No hay contenedor que borrar: `casaclara-it-pg` es el clúster compartido de la máquina y se queda levantado. Si quieres dejar limpias las bases del ensayo: `docker exec casaclara-it-pg dropdb -U ci_admin --if-exists casaclara_ensayo`.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/migracion-home-finance.md
git commit -m "docs(runbooks): migración home-finance — ensayo local y procedimiento de producción"
```
