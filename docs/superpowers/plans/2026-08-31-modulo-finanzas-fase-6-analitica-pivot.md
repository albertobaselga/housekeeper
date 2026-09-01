# Analítica y Pivot — Plan de implementación (Fase 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completar la página Analítica de `/h/[householdId]/finanzas/analitica` (KPIs ampliados, medias mensuales, partidas excluibles, gráfica apilada SVG, resumen mensual transpuesto) y el pivot completo con drag-and-drop nativo y barra de acciones accesible, con sus tests unitarios y e2e.

**Architecture:** El estado cliente del pivot (dims, orden, selección, chips, dnd) vive en módulos puros de `apps/web/src/lib/finance/` testeados con vitest; los componentes Svelte 5 (`PivotTable`, `PivotActionBar`, `NatureStackChart`) son finos y consumen `buildPivotTree` del dominio (fase 2). El primer render lo carga `+page.server.ts` bajo RLS (rama `demoOrUnavailable()` con maqueta sintética), y las escrituras van como comandos idempotentes por `POST /api/v1/sync` vía `queueCommand`.

**Tech Stack:** SvelteKit 2 + Svelte 5 (runas), TypeScript, vitest, Playwright (fixture e2e), SVG artesanal con tokens de `app.css`, `bigint` para céntimos, comandos por outbox (`$lib/offline/queue-command`).

**Spec:** /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/specs/2026-08-31-modulo-finanzas-design.md · Interfaces: /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/plans/2026-08-31-modulo-finanzas-interfaces.md

## Global Constraints

- Trabajar SOLO dentro del worktree `/home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas` (rama `worktree-modulo-finanzas`); `/home/abf/github/home-finance` es solo-lectura (fuente a portar).
- Node 24 obligatorio: prefijo `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"` antes de cualquier `pnpm`/`node`.
- Dinero: céntimos como `bigint` (TS) / `bigint` (SQL), NUNCA `Number`/float; solo EUR.
- Idioma: UI, copy, docs y commits en español (`tipo(ámbito): qué cambia`); identificadores en inglés.
- Solo datos sintéticos en el repo (importes, titulares, extractos de prueba inventados).
- Migraciones append-only `00NN_*.sql`, un solo bloque `BEGIN;…COMMIT;`; jamás editar una aplicada.
- Toda spec nueva (unit/e2e/a11y/dbe2e/SQL) cableada a un job de `.github/workflows/ci.yml` (lo exige `scripts/ci/assert-suite-coverage.py`).
- CSS solo con tokens de `apps/web/src/app.css` (vigila `apps/web/scripts/lint-css-tokens.mjs`); pesos 400/500/700; terracota solo para «ahora».
- Única dependencia nueva permitida: `xlsx` (SheetJS), SOLO en `packages/server` (jamás en cliente).
- La matriz de capacidades NO se reexporta desde la raíz de `@casa-clara/contracts` (vigila `apps/web/scripts/verify-today-bundle.mjs`).
- Escrituras de negocio SOLO como comandos por `POST /api/v1/sync`; REST solo para lecturas y para la importación multipart.
- TDD: test que falla → implementación mínima → verde → commit. Commits frecuentes.
- Suites de BD en secuencia (bases/roles de nombre fijo); Postgres local 18.4 en Docker para db-tests/dbe2e; PRODUCCIÓN (Supabase) prohibida en fases 1–6; en fase 7 solo con confirmación explícita de Alberto.
- Gates de la rama: `pnpm lint`, `pnpm typecheck`, `pnpm check`, `pnpm test`, `pnpm test:db`, `pnpm test:rls` deben quedar en verde al cerrar cada tarea que los afecte.

**Notas comunes a TODAS las tareas de este plan:**

- Los tests unitarios nuevos van en `apps/web/tests/*.test.ts` y los e2e en `apps/web/e2e/*.e2e.ts`: ambos globs ya están cableados en `.github/workflows/ci.yml` (`--specs 'apps/web::tests/*.test.ts'` y `--specs 'apps/web/e2e::*.e2e.ts'`), así que NO hay que tocar el workflow — `assert-suite-coverage.py` los recogerá solo.
- Este plan consume artefactos de fases anteriores fijados en el doc de interfaces: `buildPivotTree` y los tipos `PivotDimension`/`PivotSourceRow`/`PivotOptions`/`PivotTree` (fase 2, `packages/domain/src/finance/pivot.ts`), `$lib/finance/{filters,api,format}.ts` y los componentes `FinanceFilterBar.svelte`/`FinanceDetailPanel.svelte` (fase 4), los endpoints GET de `/api/v1/finance/*` (fase 4) y los comandos `finance.*` (fase 5). Donde una tarea asuma un detalle NO fijado por el doc de interfaces (nombre de campo de un payload, forma exacta de un tipo del dominio), la tarea lo dice y su PRIMER paso es leer el fichero real y alinear los nombres: **los nombres del repo mandan sobre los asumidos por este plan**.
- Convención de este plan para céntimos en cliente: propiedades `*Cents` de tipo `bigint`; `formatCents` (reexportado por `$lib/finance/format.ts`, fase 4) para pintar. `Number(...)` sobre céntimos SOLO para geometría SVG y porcentajes, nunca para almacenar ni sumar dinero.

---

### Task 1: `chart-data.ts` — meses completos, datos de la gráfica por naturaleza y filas del resumen

**Files:**
- Create: `apps/web/src/lib/finance/chart-data.ts`
- Test: `apps/web/tests/finance-chart-data.test.ts`

**Interfaces:**
- Consumes: nada del dominio (módulo puro y estructural).
- Produces:
  - `monthsInRange(from: string, to: string): number`
  - `monthLabel(month: string): string`
  - `perMonth(cents: bigint, months: number): bigint`
  - `pctOf(num: bigint, den: bigint): number`
  - `interface AnalyticsRowLike { kind: 'gasto'|'ingreso'|'transferencia'|'inversion'; monthly: Record<string, { totalCents: bigint; recCents: bigint; extCents: bigint }> }`
  - `interface NatureChartPoint { month; gastosRecCents; gastosExtCents; gastosSinCents; ingresosRecCents; ingresosExtCents; ingresosSinCents; inversionCents; ahorroNetoCents; ahorroBrutoCents }` (todos `bigint`, gastos en valor absoluto)
  - `buildNatureChartData(months: string[], rows: AnalyticsRowLike[]): NatureChartPoint[]`
  - `interface SummaryRowDef { label: string; cls: ''|'pos'|'neg'; strong?: boolean; sep?: boolean; value(p: NatureChartPoint): bigint }` y `SUMMARY_ROWS: SummaryRowDef[]`

Este módulo porta la intención de `/home/abf/github/home-finance/frontend/src/features/analytics/chartData.ts` y del `monthsInRange`/`SUMMARY_ROWS` de `/home/abf/github/home-finance/frontend/src/features/analytics/Analitica.tsx`, con céntimos `bigint`.

- [ ] **Step 1: escribe el test que falla.** Crea `apps/web/tests/finance-chart-data.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  buildNatureChartData,
  monthLabel,
  monthsInRange,
  pctOf,
  perMonth,
  SUMMARY_ROWS,
  type AnalyticsRowLike
} from '../src/lib/finance/chart-data';

describe('monthsInRange (solo meses COMPLETOS dentro del rango)', () => {
  it('cuenta meses enteros de un rango exacto', () => {
    expect(monthsInRange('2026-01-01', '2026-03-31')).toBe(3);
  });
  it('descarta el mes final incompleto («año hasta hoy»)', () => {
    expect(monthsInRange('2026-01-01', '2026-07-10')).toBe(6);
  });
  it('descarta el mes inicial incompleto', () => {
    expect(monthsInRange('2026-01-15', '2026-03-31')).toBe(2);
  });
  it('nunca devuelve 0 (rango dentro de un solo mes → 1)', () => {
    expect(monthsInRange('2026-02-10', '2026-02-20')).toBe(1);
  });
});

describe('buildNatureChartData', () => {
  const rows: AnalyticsRowLike[] = [
    { kind: 'gasto', monthly: { '2026-01': { totalCents: -150000n, recCents: -100000n, extCents: -30000n } } },
    { kind: 'ingreso', monthly: { '2026-01': { totalCents: 300000n, recCents: 280000n, extCents: 0n } } },
    { kind: 'inversion', monthly: { '2026-01': { totalCents: 50000n, recCents: 0n, extCents: 0n } } },
    { kind: 'transferencia', monthly: { '2026-01': { totalCents: -450000n, recCents: 0n, extCents: 0n } } }
  ];

  it('separa naturalezas, omite transferencias y aparta la inversión', () => {
    const [p] = buildNatureChartData(['2026-01'], rows);
    expect(p.gastosRecCents).toBe(100000n); // valor absoluto
    expect(p.gastosExtCents).toBe(30000n);
    expect(p.gastosSinCents).toBe(20000n); // total − rec − ext
    expect(p.ingresosRecCents).toBe(280000n);
    expect(p.ingresosSinCents).toBe(20000n);
    expect(p.inversionCents).toBe(50000n);
  });

  it('ahorro neto = ingresos − gastos totales; bruto = ingresos − gastos recurrentes; sin inversión', () => {
    const [p] = buildNatureChartData(['2026-01'], rows);
    expect(p.ahorroNetoCents).toBe(150000n); // 300000 − 150000, la inversión no entra
    expect(p.ahorroBrutoCents).toBe(200000n); // 300000 − 100000
  });

  it('un mes sin filas produce ceros', () => {
    const [p] = buildNatureChartData(['2026-02'], rows);
    expect(p.ahorroNetoCents).toBe(0n);
    expect(p.inversionCents).toBe(0n);
  });
});

describe('SUMMARY_ROWS (resumen mensual transpuesto)', () => {
  it('tiene las 13 filas fijas en el orden del original', () => {
    expect(SUMMARY_ROWS.map((r) => r.label)).toEqual([
      'Ingresos recurrentes', 'Ingresos extraordinarios', 'Ingresos sin clasificar', 'Total ingresos',
      'Gastos recurrentes', 'Gastos extraordinarios', 'Gastos sin clasificar', 'Total gastos',
      'Inversión', 'Ahorro bruto', 'Ahorro neto', 'Free cash flow', 'Ops cash flow'
    ]);
  });
  it('free cash flow = ahorro neto − inversión; ops = ahorro neto', () => {
    const p = buildNatureChartData(['2026-01'], [
      { kind: 'ingreso', monthly: { '2026-01': { totalCents: 300000n, recCents: 300000n, extCents: 0n } } },
      { kind: 'inversion', monthly: { '2026-01': { totalCents: 50000n, recCents: 0n, extCents: 0n } } }
    ])[0];
    const row = (label: string) => SUMMARY_ROWS.find((r) => r.label === label)!;
    expect(row('Free cash flow').value(p)).toBe(250000n);
    expect(row('Ops cash flow').value(p)).toBe(300000n);
    expect(row('Total gastos').value(p)).toBe(0n);
  });
});

describe('utilidades de media y porcentaje', () => {
  it('perMonth divide céntimos bigint por meses (truncando)', () => {
    expect(perMonth(-62500n, 3)).toBe(-20833n);
  });
  it('pctOf es un porcentaje redondeado sobre valores absolutos, 0 con denominador 0', () => {
    expect(pctOf(-36000n, -62500n)).toBe(58);
    expect(pctOf(100n, 0n)).toBe(0);
  });
  it('monthLabel es «mes año» en español', () => {
    expect(monthLabel('2026-01')).toBe('ene 2026');
  });
});
```

- [ ] **Step 2: ejecuta y ve el rojo.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finance-chart-data.test.ts
```

Salida esperada: `Error: Failed to load ... /src/lib/finance/chart-data` (el módulo no existe).

- [ ] **Step 3: implementación mínima.** Crea `apps/web/src/lib/finance/chart-data.ts`:

```ts
/**
 * Datos de la gráfica por naturaleza y del resumen mensual de Analítica.
 * Port fiel de chartData.ts + monthsInRange/SUMMARY_ROWS del original
 * (home-finance/frontend/src/features/analytics), con céntimos bigint.
 * Puro: sin fetch, sin DOM, sin reloj.
 */

export interface AnalyticsRowLike {
  kind: 'gasto' | 'ingreso' | 'transferencia' | 'inversion';
  monthly: Record<string, { totalCents: bigint; recCents: bigint; extCents: bigint }>;
}

export interface NatureChartPoint {
  month: string;
  gastosRecCents: bigint;
  gastosExtCents: bigint;
  gastosSinCents: bigint;
  ingresosRecCents: bigint;
  ingresosExtCents: bigint;
  ingresosSinCents: bigint;
  inversionCents: bigint;
  ahorroNetoCents: bigint;
  ahorroBrutoCents: bigint;
}

/**
 * Nº de meses COMPLETOS dentro de [from, to], para mensualizar sin diluir con
 * un mes en curso a medias. Un mes cuenta solo si el rango cubre su primer y
 * último día; si no hay ninguno completo se devuelve 1 (no dividir por cero).
 */
export function monthsInRange(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (!fy || !fm || !ty || !tm) return 1;
  let startIdx = fy * 12 + (fm - 1);
  if (fd !== 1) startIdx += 1;
  let endIdx = ty * 12 + (tm - 1);
  const lastDay = new Date(ty, tm, 0).getDate();
  if (td !== lastDay) endIdx -= 1;
  return Math.max(1, endIdx - startIdx + 1);
}

const MONTH_NAMES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «2026-01» → «ene 2026». */
export function monthLabel(month: string): string {
  const [year, m] = month.split('-');
  return `${MONTH_NAMES[Number(m) - 1] ?? month} ${year}`;
}

/** Media mensual en céntimos (división entera de bigint). No es geometría: sigue siendo dinero. */
export function perMonth(cents: bigint, months: number): bigint {
  return months === 0 ? 0n : cents / BigInt(months);
}

/** Porcentaje redondeado |num|/|den|·100. Es un ratio, no dinero: Number es legítimo aquí. */
export function pctOf(num: bigint, den: bigint): number {
  if (den === 0n) return 0;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  return Math.round(Number(abs(num) * 100n) / Number(abs(den)));
}

/**
 * Transferencias se omiten (netas 0, ruido); la inversión alimenta su serie y
 * NO cuenta como ingreso ni entra en el ahorro neto. Ahorro neto = suma del
 * mes (ingresos + gastos, gastos negativos); bruto = ingresos + gastos
 * recurrentes (negativos). Los gastos salen en valor absoluto para apilar.
 */
export function buildNatureChartData(months: string[], rows: AnalyticsRowLike[]): NatureChartPoint[] {
  const abs = (v: bigint) => (v < 0n ? -v : v);
  return months.map((month) => {
    let gRec = 0n, gExt = 0n, gSin = 0n, iRec = 0n, iExt = 0n, iSin = 0n, inv = 0n, totalMonth = 0n;
    for (const row of rows) {
      const e = row.monthly[month];
      if (!e) continue;
      if (row.kind === 'transferencia') continue;
      if (row.kind === 'inversion') { inv += e.totalCents; continue; }
      const unclassified = e.totalCents - e.recCents - e.extCents;
      totalMonth += e.totalCents;
      if (row.kind === 'gasto') { gRec += e.recCents; gExt += e.extCents; gSin += unclassified; }
      else { iRec += e.recCents; iExt += e.extCents; iSin += unclassified; }
    }
    const iTotal = iRec + iExt + iSin;
    return {
      month,
      gastosRecCents: abs(gRec), gastosExtCents: abs(gExt), gastosSinCents: abs(gSin),
      ingresosRecCents: iRec, ingresosExtCents: iExt, ingresosSinCents: iSin,
      inversionCents: inv,
      ahorroNetoCents: totalMonth,
      ahorroBrutoCents: iTotal + gRec
    };
  });
}

export interface SummaryRowDef {
  label: string;
  cls: '' | 'pos' | 'neg';
  strong?: boolean;
  sep?: boolean;
  value(p: NatureChartPoint): bigint;
}

const totalIngresos = (p: NatureChartPoint) => p.ingresosRecCents + p.ingresosExtCents + p.ingresosSinCents;
const totalGastos = (p: NatureChartPoint) => p.gastosRecCents + p.gastosExtCents + p.gastosSinCents;

/** Filas fijas del resumen mensual transpuesto, en el orden del original. */
export const SUMMARY_ROWS: SummaryRowDef[] = [
  { label: 'Ingresos recurrentes', cls: 'pos', value: (p) => p.ingresosRecCents },
  { label: 'Ingresos extraordinarios', cls: 'pos', value: (p) => p.ingresosExtCents },
  { label: 'Ingresos sin clasificar', cls: 'pos', value: (p) => p.ingresosSinCents },
  { label: 'Total ingresos', cls: 'pos', strong: true, value: totalIngresos },
  { label: 'Gastos recurrentes', cls: 'neg', sep: true, value: (p) => p.gastosRecCents },
  { label: 'Gastos extraordinarios', cls: 'neg', value: (p) => p.gastosExtCents },
  { label: 'Gastos sin clasificar', cls: 'neg', value: (p) => p.gastosSinCents },
  { label: 'Total gastos', cls: 'neg', strong: true, value: totalGastos },
  { label: 'Inversión', cls: 'pos', sep: true, value: (p) => p.inversionCents },
  { label: 'Ahorro bruto', cls: '', strong: true, sep: true, value: (p) => p.ahorroBrutoCents },
  { label: 'Ahorro neto', cls: '', strong: true, value: (p) => p.ahorroNetoCents },
  { label: 'Free cash flow', cls: '', value: (p) => p.ahorroNetoCents - p.inversionCents },
  { label: 'Ops cash flow', cls: '', value: (p) => p.ahorroNetoCents }
];
```

- [ ] **Step 4: verde.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finance-chart-data.test.ts
```

Salida esperada: `Test Files  1 passed`.

- [ ] **Step 5: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/src/lib/finance/chart-data.ts apps/web/tests/finance-chart-data.test.ts
git commit -m "feat(finanzas): datos puros de la gráfica por naturaleza y resumen mensual de Analítica"
```

---

### Task 2: `pivot-state.ts` — dimensiones reordenables y orden de columnas

**Files:**
- Create: `apps/web/src/lib/finance/pivot-state.ts`
- Test: `apps/web/tests/finance-pivot-dims.test.ts`

**Interfaces:**
- Consumes: `type PivotDimension = 'cat'|'sub'|'nat'|'prov'|'concept'|'movement'` de `@casa-clara/domain` (canónico, fase 2). **Step 0 obligatorio:** abre `packages/domain/src/finance/pivot.ts` y `packages/domain/package.json` y confirma el subpath de import (`@casa-clara/domain` o el subpath que exporte finance); usa ese import en todo el fichero.
- Produces (todo puro, sin runas):
  - `ALL_DIMS`, `DEFAULT_DIMS: readonly PivotDimension[]`, `DIM_LABELS: Record<PivotDimension, string>`
  - `parseDims(raw: string | null): PivotDimension[]` · `dimsToParam(dims): string`
  - `moveDim(dims, index, dir: -1|1)` · `removeDim(dims, dim)` · `addDim(dims, dim)`
  - `type PivotSortKey = 'label'|'total'|'avg'|'ticket'|{ month: string }` · `type SortDir = 'asc'|'desc'`
  - `interface SortableNodeLike { label: string; totalCents: bigint; avgCents: bigint; ticketCents: bigint; monthly: Record<string, bigint> }`
  - `sameSortKey(a, b): boolean` · `sortTree<T extends SortableNodeLike & { children: T[] }>(nodes, key, dir): T[]`

Porta la intención de `parseDims`/`sortSections` de `/home/abf/github/home-finance/frontend/src/features/analytics/pivotTree.ts` (las claves de URL `dims`, `q`, `dupev` son contrato del doc de interfaces). El árbol lo construye el dominio; aquí solo se reordena, de forma estructural, sin tocar subtotales.

- [ ] **Step 1: test que falla.** Crea `apps/web/tests/finance-pivot-dims.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  addDim, DEFAULT_DIMS, dimsToParam, moveDim, parseDims, removeDim, sameSortKey, sortTree,
  type SortableNodeLike
} from '../src/lib/finance/pivot-state';

type Node = SortableNodeLike & { children: Node[] };
const node = (label: string, totalCents: bigint, children: Node[] = [], monthly: Record<string, bigint> = {}): Node =>
  ({ label, totalCents, avgCents: totalCents, ticketCents: totalCents, monthly, children });

describe('parseDims / dimsToParam (persistencia en ?dims=)', () => {
  it('sin parámetro devuelve las dims por defecto', () => {
    expect(parseDims(null)).toEqual([...DEFAULT_DIMS]);
  });
  it('filtra valores desconocidos y deduplica', () => {
    expect(parseDims('cat,zzz,cat,prov')).toEqual(['cat', 'prov']);
  });
  it('todo inválido → por defecto', () => {
    expect(parseDims('zzz')).toEqual([...DEFAULT_DIMS]);
  });
  it('las dims por defecto serializan a cadena vacía (URL limpia)', () => {
    expect(dimsToParam(['cat', 'sub'])).toBe('');
    expect(dimsToParam(['sub', 'cat'])).toBe('sub,cat');
  });
});

describe('moveDim / removeDim / addDim', () => {
  it('intercambia posiciones adyacentes y respeta los bordes', () => {
    expect(moveDim(['cat', 'sub'], 0, 1)).toEqual(['sub', 'cat']);
    expect(moveDim(['cat', 'sub'], 0, -1)).toEqual(['cat', 'sub']);
  });
  it('nunca deja la lista vacía y no duplica al añadir', () => {
    expect(removeDim(['cat'], 'cat')).toEqual(['cat']);
    expect(removeDim(['cat', 'sub'], 'cat')).toEqual(['sub']);
    expect(addDim(['cat'], 'cat')).toEqual(['cat']);
    expect(addDim(['cat'], 'nat')).toEqual(['cat', 'nat']);
  });
});

describe('sortTree (recursivo, sin mutar la entrada)', () => {
  const roots = [
    node('Zeta', -600n, [node('a', -100n), node('b', -500n)]),
    node('Alfa', -350n, [node('x', -50n, [], { '2026-02': -50n }), node('y', -300n)])
  ];
  it('ordena por label alfabético asc/desc', () => {
    expect(sortTree(roots, 'label', 'asc').map((n) => n.label)).toEqual(['Alfa', 'Zeta']);
    expect(sortTree(roots, 'label', 'desc').map((n) => n.label)).toEqual(['Zeta', 'Alfa']);
  });
  it('por total ascendente el gasto más negativo va primero, también en los hijos', () => {
    const sorted = sortTree(roots, 'total', 'asc');
    expect(sorted.map((n) => n.label)).toEqual(['Zeta', 'Alfa']);
    expect(sorted[0].children.map((c) => c.label)).toEqual(['b', 'a']);
    expect(sorted[1].children.map((c) => c.label)).toEqual(['y', 'x']);
  });
  it('ordena por una clave de mes (ausente = 0n)', () => {
    const sorted = sortTree(roots[1].children, { month: '2026-02' }, 'asc');
    expect(sorted.map((n) => n.label)).toEqual(['x', 'y']);
  });
  it('no muta la entrada', () => {
    const before = roots.map((n) => n.label);
    sortTree(roots, 'total', 'asc');
    expect(roots.map((n) => n.label)).toEqual(before);
  });
});

describe('sameSortKey', () => {
  it('compara claves simples y de mes', () => {
    expect(sameSortKey('total', 'total')).toBe(true);
    expect(sameSortKey({ month: '2026-01' }, { month: '2026-01' })).toBe(true);
    expect(sameSortKey({ month: '2026-01' }, 'total')).toBe(false);
  });
});
```

- [ ] **Step 2: rojo.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finance-pivot-dims.test.ts
```

Salida esperada: fallo de carga del módulo `pivot-state`.

- [ ] **Step 3: implementación mínima.** Crea `apps/web/src/lib/finance/pivot-state.ts` (primer bloque del fichero; las tareas 3–5 AÑADEN secciones):

```ts
import type { PivotDimension } from '@casa-clara/domain'; // Step 0: confirma este subpath

/**
 * Estado cliente del pivot de Analítica: dims, orden, selección, chips y dnd.
 * Puro (sin runas, sin fetch, sin reloj): los componentes guardan el $state y
 * delegan aquí toda la lógica, que es lo que cubren los tests unitarios.
 * Porta la intención de pivotTree/useSelection/search/dnd del original.
 */

// ── Dimensiones (persistidas en ?dims=, contrato del doc de interfaces) ──────

export const ALL_DIMS: readonly PivotDimension[] = ['cat', 'sub', 'nat', 'prov', 'concept', 'movement'];
export const DEFAULT_DIMS: readonly PivotDimension[] = ['cat', 'sub'];
export const DIM_LABELS: Record<PivotDimension, string> = {
  cat: 'Categoría',
  sub: 'Subcategoría',
  nat: 'Naturaleza',
  prov: 'Proveedor',
  concept: 'Concepto',
  movement: 'Movimiento'
};

export function parseDims(raw: string | null): PivotDimension[] {
  if (!raw) return [...DEFAULT_DIMS];
  const parsed = raw.split(',').filter((d): d is PivotDimension => (ALL_DIMS as readonly string[]).includes(d));
  const deduped = [...new Set(parsed)];
  return deduped.length ? deduped : [...DEFAULT_DIMS];
}

export function dimsToParam(dims: readonly PivotDimension[]): string {
  const isDefault = dims.length === DEFAULT_DIMS.length && dims.every((d, i) => d === DEFAULT_DIMS[i]);
  return isDefault ? '' : dims.join(',');
}

export function moveDim(dims: readonly PivotDimension[], index: number, dir: -1 | 1): PivotDimension[] {
  const next = [...dims];
  const j = index + dir;
  if (index < 0 || index >= next.length || j < 0 || j >= next.length) return next;
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

export function removeDim(dims: readonly PivotDimension[], dim: PivotDimension): PivotDimension[] {
  return dims.length <= 1 ? [...dims] : dims.filter((d) => d !== dim);
}

export function addDim(dims: readonly PivotDimension[], dim: PivotDimension): PivotDimension[] {
  return dims.includes(dim) ? [...dims] : [...dims, dim];
}

// ── Orden de columnas (Acumulado/Promedio/Ticket/mes, recursivo) ─────────────

export type PivotSortKey = 'label' | 'total' | 'avg' | 'ticket' | { month: string };
export type SortDir = 'asc' | 'desc';

export interface SortableNodeLike {
  label: string;
  totalCents: bigint;
  avgCents: bigint;
  ticketCents: bigint;
  monthly: Record<string, bigint>;
}

export function sameSortKey(a: PivotSortKey, b: PivotSortKey): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.month === b.month;
}

function sortValue(key: PivotSortKey, item: SortableNodeLike): bigint | string {
  if (key === 'label') return item.label;
  if (key === 'total') return item.totalCents;
  if (key === 'avg') return item.avgCents;
  if (key === 'ticket') return item.ticketCents;
  return item.monthly[key.month] ?? 0n;
}

function compareSortValues(a: bigint | string, b: bigint | string, dir: SortDir): number {
  const cmp =
    typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b, 'es') : a < b ? -1 : a > b ? 1 : 0;
  return dir === 'asc' ? cmp : -cmp;
}

/** Reordena hermanos en cada nivel sin mutar la entrada. Los subtotales no pasan por aquí. */
export function sortTree<T extends SortableNodeLike & { children: T[] }>(
  nodes: readonly T[],
  key: PivotSortKey,
  dir: SortDir
): T[] {
  return nodes
    .map((n) => ({ ...n, children: sortTree(n.children, key, dir) }))
    .sort((a, b) => compareSortValues(sortValue(key, a), sortValue(key, b), dir));
}
```

Nota DRY: si `packages/domain/src/finance/pivot.ts` (fase 2) ya exporta una ordenación recursiva equivalente, impórtala y borra `sortTree` local (deja los tests apuntando a la del dominio a través de este módulo).

- [ ] **Step 4: verde.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finance-pivot-dims.test.ts
```

- [ ] **Step 5: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/src/lib/finance/pivot-state.ts apps/web/tests/finance-pivot-dims.test.ts
git commit -m "feat(finanzas): dims reordenables y orden recursivo del pivot (estado cliente puro)"
```

---

### Task 3: `pivot-state.ts` — selección (checkbox, Shift, resolución por ids)

**Files:**
- Modify: `apps/web/src/lib/finance/pivot-state.ts` (añadir sección; las de la tarea 2 ya existen)
- Test: `apps/web/tests/finance-pivot-selection.test.ts`

**Interfaces:**
- Consumes: `PivotDimension` del dominio; `SortableNodeLike` (tarea 2).
- Produces:
  - `interface PivotMovLike { id: string; date: string; cents: bigint }`
  - `interface PivotNodeLike extends SortableNodeLike { key: string; depth: number; count: number; catId: string | null; nat: 'recurrente'|'extraordinario'|null; provider: string | null; concept: string | null; movs: PivotMovLike[]; children: PivotNodeLike[] }`
  - `interface SelectableItem { key; parentKey; provider: string; concept: string | null; count: number; categoryId?: string; label?: string; txId?: string }`
  - `parentKeyOf`, `toSelectable`, `isCategoryAggregateNode`, `toCategorySelectable`, `isMovementLeaf`, `toMovementSelectable`, `toAnySelectable`, `selectableListAny`, `collectLeafItems`, `rangeBetween`, `toggleInMap`, `collectNodeMovIds(roots: readonly PivotNodeLike[]): Map<string, string[]>`, `resolveSelectionIds(items, nodeMovIds): string[]`

Porta la intención de `/home/abf/github/home-finance/frontend/src/features/analytics/useSelection.ts` (ids `string` en vez de `number`; tipado estructural para no acoplarse al nombre del tipo de nodo del dominio). `collectNodeMovIds` porta el del `pivotTree.ts` original, genérico sobre raíces.

- [ ] **Step 1: test que falla.** Crea `apps/web/tests/finance-pivot-selection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  collectLeafItems, collectNodeMovIds, isCategoryAggregateNode, isMovementLeaf, parentKeyOf,
  rangeBetween, resolveSelectionIds, selectableListAny, toAnySelectable, toCategorySelectable,
  toggleInMap, toMovementSelectable, toSelectable,
  type PivotNodeLike, type SelectableItem
} from '../src/lib/finance/pivot-state';

function node(partial: Partial<PivotNodeLike>): PivotNodeLike {
  return {
    key: 'k', label: 'l', depth: 0, count: 1, totalCents: 0n, avgCents: 0n, ticketCents: 0n,
    monthly: {}, catId: null, nat: null, provider: null, concept: null, movs: [], children: [],
    ...partial
  };
}

describe('parentKeyOf', () => {
  it('recorta el último segmento; raíz = ""', () => {
    expect(parentKeyOf('/prov:A/concept:B')).toBe('/prov:A');
    expect(parentKeyOf('/prov:A')).toBe('');
  });
});

describe('toSelectable / toCategorySelectable / toMovementSelectable / toAnySelectable', () => {
  it('sin proveedor único no hay ítem proveedor/concepto', () => {
    expect(toSelectable(node({ provider: null }))).toBeNull();
  });
  it('un nodo cat/sub con catId único es seleccionable como categoría entera', () => {
    const n = node({ key: '/cat:Ocio', catId: 'c1', label: 'Ocio', count: 9 });
    expect(isCategoryAggregateNode(n, ['cat', 'sub'])).toBe(true);
    expect(toCategorySelectable(n, ['cat', 'sub'])).toEqual({
      key: '/cat:Ocio', parentKey: '', provider: '', concept: null, count: 9, categoryId: 'c1', label: 'Ocio'
    });
    expect(isCategoryAggregateNode(node({ key: '/cat:Sin categorizar', catId: null }), ['cat', 'sub'])).toBe(false);
    expect(isCategoryAggregateNode(node({ key: '/nat:x', catId: 'c1' }), ['nat', 'cat'])).toBe(false);
  });
  it('una hoja de la dimensión movimiento se selecciona por txId', () => {
    const n = node({ key: '/cat:Ocio/movement:t1', depth: 1, label: '2026-01-02 · −12,00 €',
      movs: [{ id: 't1', date: '2026-01-02', cents: -1200n }] });
    expect(isMovementLeaf(n, ['cat', 'movement'])).toBe(true);
    expect(toMovementSelectable(n, ['cat', 'movement'])?.txId).toBe('t1');
    expect(isMovementLeaf(n, ['cat', 'prov'])).toBe(false);
  });
  it('toAnySelectable prefiere proveedor, luego categoría, luego movimiento', () => {
    expect(toAnySelectable(node({ key: '/prov:A', provider: 'A' }), ['prov'])?.provider).toBe('A');
    expect(toAnySelectable(node({ key: '/cat:O', catId: 'c1', label: 'O' }), ['cat'])?.categoryId).toBe('c1');
    const leaf = node({ key: '/cat:O/movement:t9', depth: 1, movs: [{ id: 't9', date: 'x', cents: -1n }] });
    expect(toAnySelectable(leaf, ['cat', 'movement'])?.txId).toBe('t9');
    expect(toAnySelectable(node({ key: '/nat:mix' }), ['nat'])).toBeNull();
  });
});

describe('selectableListAny / collectLeafItems', () => {
  it('lista hermanos seleccionables preservando el orden', () => {
    const nodes = [
      node({ key: '/cat:O', catId: 'c1', label: 'O' }),
      node({ key: '/cat:Sin categorizar' })
    ];
    expect(selectableListAny(nodes, ['cat']).map((s) => s.key)).toEqual(['/cat:O']);
  });
  it('recolecta hojas con proveedor y cuenta las omitidas', () => {
    const cat = node({
      key: '/cat:O',
      children: [
        node({ key: '/cat:O/prov:A', provider: 'A', count: 2 }),
        node({ key: '/cat:O/nat:mix' })
      ]
    });
    const r = collectLeafItems(cat);
    expect(r.items.map((i) => i.provider)).toEqual(['A']);
    expect(r.omitted).toBe(1);
  });
});

describe('rangeBetween / toggleInMap (Shift+clic)', () => {
  const siblings: SelectableItem[] = ['A', 'B', 'C', 'D'].map((p) => ({
    key: `/prov:${p}`, parentKey: '', provider: p, concept: null, count: 1
  }));
  it('rango inclusivo en ambos sentidos; null si cruzan grupos', () => {
    expect(rangeBetween(siblings, '/prov:A', '/prov:C')?.map((s) => s.provider)).toEqual(['A', 'B', 'C']);
    expect(rangeBetween(siblings, '/prov:C', '/prov:A')?.map((s) => s.provider)).toEqual(['A', 'B', 'C']);
    expect(rangeBetween(siblings, '/prov:A', '/prov:Z')).toBeNull();
  });
  it('toggleInMap añade/quita sin mutar', () => {
    const map = new Map<string, SelectableItem>();
    const next = toggleInMap(map, siblings[0]);
    expect(next.has('/prov:A')).toBe(true);
    expect(map.size).toBe(0);
    expect(toggleInMap(next, siblings[0]).has('/prov:A')).toBe(false);
  });
});

describe('collectNodeMovIds / resolveSelectionIds', () => {
  const roots: PivotNodeLike[] = [
    node({
      key: '/cat:O', movs: [{ id: 't1', date: 'x', cents: -1n }, { id: 't2', date: 'y', cents: -2n }],
      children: [node({ key: '/cat:O/prov:A', provider: 'A', movs: [{ id: 't1', date: 'x', cents: -1n }] })]
    })
  ];
  it('mapea cada nodo (agregado y hoja) a los ids de sus movimientos', () => {
    const map = collectNodeMovIds(roots);
    expect(map.get('/cat:O')).toEqual(['t1', 't2']);
    expect(map.get('/cat:O/prov:A')).toEqual(['t1']);
  });
  it('resuelve una selección mixta deduplicando ids', () => {
    const map = collectNodeMovIds(roots);
    const items: SelectableItem[] = [
      { key: '/cat:O', parentKey: '', provider: '', concept: null, count: 2, categoryId: 'c1' },
      { key: '/cat:O/movement:t2', parentKey: '/cat:O', provider: '', concept: null, count: 1, txId: 't2' }
    ];
    expect(resolveSelectionIds(items, map).sort()).toEqual(['t1', 't2']);
    expect(resolveSelectionIds([{ key: 'missing', parentKey: '', provider: '', concept: null, count: 1 }], new Map())).toEqual([]);
  });
});
```

- [ ] **Step 2: rojo.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finance-pivot-selection.test.ts
```

Salida esperada: errores de export inexistente (`toSelectable` etc. no exportados aún).

- [ ] **Step 3: implementación mínima.** AÑADE al final de `apps/web/src/lib/finance/pivot-state.ts`:

```ts
// ── Selección (checkbox, Shift+clic, resolución a tx_id) ─────────────────────
// Tipado ESTRUCTURAL sobre la forma del nodo del pivot del dominio (fase 2):
// si el dominio nombra distinto alguna propiedad (p. ej. total en vez de
// totalCents), ajusta PivotNodeLike aquí — los nombres del dominio mandan.

export interface PivotMovLike {
  id: string;
  date: string;
  cents: bigint;
}

export interface PivotNodeLike extends SortableNodeLike {
  key: string;
  depth: number;
  count: number;
  catId: string | null;
  nat: 'recurrente' | 'extraordinario' | null;
  provider: string | null;
  concept: string | null;
  movs: PivotMovLike[];
  children: PivotNodeLike[];
}

export interface SelectableItem {
  key: string;
  parentKey: string;
  provider: string;
  concept: string | null;
  count: number;
  /** Nodo categoría/subcategoría agregado: el gesto vincula la categoría entera. */
  categoryId?: string;
  label?: string;
  /** Hoja de la dimensión Movimiento: la identidad es el id exacto. */
  txId?: string;
}

export function parentKeyOf(key: string): string {
  const idx = key.lastIndexOf('/');
  return idx <= 0 ? '' : key.slice(0, idx);
}

export function toSelectable(node: PivotNodeLike): SelectableItem | null {
  if (node.provider === null) return null;
  return { key: node.key, parentKey: parentKeyOf(node.key), provider: node.provider, concept: node.concept, count: node.count };
}

export function isCategoryAggregateNode(node: PivotNodeLike, dims: readonly PivotDimension[]): boolean {
  const dim = dims[node.depth];
  return (dim === 'cat' || dim === 'sub') && node.catId !== null;
}

export function toCategorySelectable(node: PivotNodeLike, dims: readonly PivotDimension[]): SelectableItem | null {
  if (!isCategoryAggregateNode(node, dims)) return null;
  return {
    key: node.key, parentKey: parentKeyOf(node.key), provider: '', concept: null,
    count: node.count, categoryId: node.catId!, label: node.label
  };
}

export function isMovementLeaf(node: PivotNodeLike, dims: readonly PivotDimension[]): boolean {
  return dims[node.depth] === 'movement' && node.movs.length === 1;
}

export function toMovementSelectable(node: PivotNodeLike, dims: readonly PivotDimension[]): SelectableItem | null {
  if (!isMovementLeaf(node, dims)) return null;
  return {
    key: node.key, parentKey: parentKeyOf(node.key), provider: '', concept: null,
    count: 1, txId: node.movs[0].id, label: node.label
  };
}

export function toAnySelectable(node: PivotNodeLike, dims: readonly PivotDimension[]): SelectableItem | null {
  return toSelectable(node) ?? toCategorySelectable(node, dims) ?? toMovementSelectable(node, dims);
}

export function selectableListAny(nodes: readonly PivotNodeLike[], dims: readonly PivotDimension[]): SelectableItem[] {
  return nodes.map((n) => toAnySelectable(n, dims)).filter((s): s is SelectableItem => s !== null);
}

/** Hojas proveedor/concepto del subárbol; `omitted` = hojas sin proveedor único. */
export function collectLeafItems(node: PivotNodeLike): { items: SelectableItem[]; omitted: number } {
  if (node.children.length === 0) {
    const item = toSelectable(node);
    return item ? { items: [item], omitted: 0 } : { items: [], omitted: 1 };
  }
  const items: SelectableItem[] = [];
  let omitted = 0;
  for (const child of node.children) {
    const r = collectLeafItems(child);
    items.push(...r.items);
    omitted += r.omitted;
  }
  return { items, omitted };
}

export function rangeBetween(
  siblings: readonly SelectableItem[],
  fromKey: string,
  toKey: string
): SelectableItem[] | null {
  const i = siblings.findIndex((s) => s.key === fromKey);
  const j = siblings.findIndex((s) => s.key === toKey);
  if (i === -1 || j === -1) return null;
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  return siblings.slice(lo, hi + 1);
}

export function toggleInMap(map: ReadonlyMap<string, SelectableItem>, item: SelectableItem): Map<string, SelectableItem> {
  const next = new Map(map);
  if (next.has(item.key)) next.delete(item.key);
  else next.set(item.key, item);
  return next;
}

/** Mapa key→ids de TODO el bosque (recursivo). Resuelve selecciones a tx_id exactos. */
export function collectNodeMovIds(roots: readonly PivotNodeLike[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const walk = (n: PivotNodeLike) => {
    map.set(n.key, n.movs.map((m) => m.id));
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return map;
}

export function resolveSelectionIds(
  items: readonly SelectableItem[],
  nodeMovIds: ReadonlyMap<string, string[]>
): string[] {
  return [...new Set(items.flatMap((i) => (i.txId != null ? [i.txId] : (nodeMovIds.get(i.key) ?? []))))];
}
```

- [ ] **Step 4: verde.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finance-pivot-selection.test.ts tests/finance-pivot-dims.test.ts
```

- [ ] **Step 5: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/src/lib/finance/pivot-state.ts apps/web/tests/finance-pivot-selection.test.ts
git commit -m "feat(finanzas): selección del pivot con rango Shift y resolución por ids"
```

---

### Task 4: `pivot-state.ts` — buscador con chips tipados

**Files:**
- Modify: `apps/web/src/lib/finance/pivot-state.ts` (añadir sección)
- Test: `apps/web/tests/finance-pivot-search.test.ts`

**Interfaces:**
- Consumes: `formatCents` de `$lib/finance/format` (fase 4, canónico).
- Produces:
  - `type SearchChip = { type: 'prov'|'concept'|'event'|'cat'|'free'; value: string; prov?: string }`
  - `interface SearchableRowLike { cat: string; sub: string | null; catId: string | null; prov: string; concept: string; event: string | null }`
  - `normalizeText(s: string): string`
  - `suggestChips(rows: (SearchableRowLike & { totalCents: bigint; count: number })[], catPathOf: (catId: string) => string, query: string): SuggestGroup[]` con `interface SuggestGroup { group: string; items: { chip: SearchChip; label: string; detail: string }[] }`
  - `rowMatchesChips(row: SearchableRowLike, chips: SearchChip[], catPathOf): boolean`
  - `serializeChips(chips): string` · `parseChips(q: string | null): SearchChip[]` (clave de URL `q`, contrato del doc de interfaces)

Porta la intención de `/home/abf/github/home-finance/frontend/src/features/analytics/search.ts` (AND entre chips; `concept` con proveedor serializa `concept:PROV~~VALUE`; entradas malformadas se ignoran; el árbol de categorías entra como función `catPathOf` para no acoplarse a un tipo).

- [ ] **Step 1: test que falla.** Crea `apps/web/tests/finance-pivot-search.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  normalizeText, parseChips, rowMatchesChips, serializeChips, suggestChips,
  type SearchChip
} from '../src/lib/finance/pivot-state';

const catPathOf = (id: string) => (id === 'c1' ? 'Ocio > Bares' : 'Otra');

const row = (partial: Partial<Parameters<typeof rowMatchesChips>[0]> & { totalCents?: bigint; count?: number } = {}) => ({
  cat: 'Ocio', sub: 'Bares', catId: 'c1', prov: 'Bar Manolo', concept: 'CAÑAS', event: null,
  totalCents: -1000n, count: 2, ...partial
});

describe('normalizeText', () => {
  it('quita tildes, baja a minúsculas y recorta', () => {
    expect(normalizeText('  Camión ')).toBe('camion');
  });
});

describe('suggestChips', () => {
  it('requiere 2 caracteres y agrupa por tipo con detalle', () => {
    expect(suggestChips([row()], catPathOf, 'b')).toEqual([]);
    const groups = suggestChips([row()], catPathOf, 'manolo');
    expect(groups.map((g) => g.group)).toEqual(['Proveedores']);
    expect(groups[0].items[0].chip).toEqual({ type: 'prov', value: 'Bar Manolo' });
    expect(groups[0].items[0].detail).toContain('2 movs');
  });
  it('sugiere categorías por su ruta completa', () => {
    const groups = suggestChips([row()], catPathOf, 'bares');
    const cats = groups.find((g) => g.group === 'Categorías')!;
    expect(cats.items[0].chip).toEqual({ type: 'cat', value: 'c1' });
    expect(cats.items[0].label).toBe('Ocio > Bares');
  });
});

describe('rowMatchesChips (AND entre chips)', () => {
  it('prov exacto, cat por id, free por cualquier campo', () => {
    expect(rowMatchesChips(row(), [{ type: 'prov', value: 'bar manolo' }], catPathOf)).toBe(true);
    expect(rowMatchesChips(row(), [{ type: 'cat', value: 'c1' }], catPathOf)).toBe(true);
    expect(rowMatchesChips(row(), [{ type: 'free', value: 'cañas' }], catPathOf)).toBe(true);
    expect(rowMatchesChips(row(), [{ type: 'prov', value: 'otro' }], catPathOf)).toBe(false);
    expect(
      rowMatchesChips(row(), [{ type: 'prov', value: 'bar manolo' }, { type: 'free', value: 'zzz' }], catPathOf)
    ).toBe(false);
  });
  it('concept con proveedor exige ambos', () => {
    const chip: SearchChip = { type: 'concept', value: 'CAÑAS', prov: 'Bar Manolo' };
    expect(rowMatchesChips(row(), [chip], catPathOf)).toBe(true);
    expect(rowMatchesChips(row({ prov: 'Otro' }), [chip], catPathOf)).toBe(false);
  });
});

describe('serializeChips / parseChips (?q=)', () => {
  it('ida y vuelta con URL-encoding y separador de proveedor', () => {
    const chips: SearchChip[] = [
      { type: 'prov', value: 'Bar Manolo' },
      { type: 'concept', value: 'CAÑAS Y TAPAS', prov: 'Bar Manolo' },
      { type: 'free', value: 'a|b' }
    ];
    expect(parseChips(serializeChips(chips))).toEqual(chips);
  });
  it('ignora entradas malformadas o de tipo desconocido', () => {
    expect(parseChips('zzz:1|sintipo|prov:Bar%20Manolo')).toEqual([{ type: 'prov', value: 'Bar Manolo' }]);
    expect(parseChips(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: rojo.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finance-pivot-search.test.ts
```

- [ ] **Step 3: implementación mínima.** AÑADE al final de `apps/web/src/lib/finance/pivot-state.ts`:

```ts
// ── Buscador con chips tipados (?q=, contrato del doc de interfaces) ─────────

import { formatCents } from './format';

export type SearchChip = { type: 'prov' | 'concept' | 'event' | 'cat' | 'free'; value: string; prov?: string };

const CHIP_TYPES: readonly SearchChip['type'][] = ['prov', 'concept', 'event', 'cat', 'free'];

export interface SearchableRowLike {
  cat: string;
  sub: string | null;
  catId: string | null;
  prov: string;
  concept: string;
  event: string | null;
}

export interface SuggestGroup {
  group: string;
  items: { chip: SearchChip; label: string; detail: string }[];
}

/** Sin tildes/diacríticos, minúsculas, sin espacios en los extremos. */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function suggestChips(
  rows: readonly (SearchableRowLike & { totalCents: bigint; count: number })[],
  catPathOf: (catId: string) => string,
  query: string
): SuggestGroup[] {
  const q = normalizeText(query);
  if (q.length < 2) return [];
  const abs = (v: bigint) => (v < 0n ? -v : v);

  const provMap = new Map<string, { totalCents: bigint; count: number }>();
  const conceptMap = new Map<string, { concept: string; prov: string; count: number }>();
  const eventMap = new Map<string, { netCents: bigint }>();
  const catMap = new Map<string, { totalCents: bigint; count: number }>();

  for (const r of rows) {
    if (normalizeText(r.prov).includes(q)) {
      const e = provMap.get(r.prov) ?? { totalCents: 0n, count: 0 };
      e.totalCents += r.totalCents;
      e.count += r.count;
      provMap.set(r.prov, e);
    }
    if (normalizeText(r.concept).includes(q)) {
      const key = `${r.concept} ${r.prov}`;
      const e = conceptMap.get(key) ?? { concept: r.concept, prov: r.prov, count: 0 };
      e.count += r.count;
      conceptMap.set(key, e);
    }
    if (r.event && normalizeText(r.event).includes(q)) {
      const e = eventMap.get(r.event) ?? { netCents: 0n };
      e.netCents += r.totalCents;
      eventMap.set(r.event, e);
    }
    if (r.catId !== null && normalizeText(catPathOf(r.catId)).includes(q)) {
      const e = catMap.get(r.catId) ?? { totalCents: 0n, count: 0 };
      e.totalCents += r.totalCents;
      e.count += r.count;
      catMap.set(r.catId, e);
    }
  }

  const groups: SuggestGroup[] = [
    {
      group: 'Proveedores',
      items: [...provMap.entries()]
        .sort((a, b) => (abs(b[1].totalCents) > abs(a[1].totalCents) ? 1 : -1))
        .map(([prov, e]) => ({
          chip: { type: 'prov', value: prov },
          label: prov,
          detail: `${formatCents(e.totalCents)} · ${e.count} movs`
        }))
    },
    {
      group: 'Conceptos',
      items: [...conceptMap.values()]
        .sort((a, b) => b.count - a.count)
        .map((e) => ({
          chip: { type: 'concept', value: e.concept, prov: e.prov },
          label: e.concept,
          detail: `${e.prov} · ${e.count} movs`
        }))
    },
    {
      group: 'Eventos',
      items: [...eventMap.entries()]
        .sort((a, b) => (abs(b[1].netCents) > abs(a[1].netCents) ? 1 : -1))
        .map(([event, e]) => ({
          chip: { type: 'event', value: event },
          label: event,
          detail: `neto ${formatCents(e.netCents)}`
        }))
    },
    {
      group: 'Categorías',
      items: [...catMap.entries()]
        .sort((a, b) => (abs(b[1].totalCents) > abs(a[1].totalCents) ? 1 : -1))
        .map(([catId, e]) => ({
          chip: { type: 'cat', value: catId },
          label: catPathOf(catId),
          detail: `${formatCents(e.totalCents)} · ${e.count} movs`
        }))
    }
  ];
  return groups.filter((g) => g.items.length > 0);
}

function matchesChip(row: SearchableRowLike, chip: SearchChip, catPathOf: (catId: string) => string): boolean {
  const q = normalizeText(chip.value);
  switch (chip.type) {
    case 'prov':
      return normalizeText(row.prov) === q;
    case 'concept':
      return normalizeText(row.concept) === q && (!chip.prov || normalizeText(row.prov) === normalizeText(chip.prov));
    case 'event':
      return row.event != null && normalizeText(row.event) === q;
    case 'cat':
      return row.catId !== null && row.catId === chip.value;
    case 'free': {
      const fields = [row.prov, row.concept, row.event, row.cat, row.sub, row.catId !== null ? catPathOf(row.catId) : null];
      return fields.some((f) => f != null && normalizeText(f).includes(q));
    }
  }
}

/** AND entre chips: la fila debe casar con todos los chips activos. */
export function rowMatchesChips(
  row: SearchableRowLike,
  chips: readonly SearchChip[],
  catPathOf: (catId: string) => string
): boolean {
  return chips.every((chip) => matchesChip(row, chip, catPathOf));
}

export function serializeChips(chips: readonly SearchChip[]): string {
  return chips
    .map((c) =>
      c.type === 'concept' && c.prov
        ? `concept:${encodeURIComponent(c.prov)}~~${encodeURIComponent(c.value)}`
        : `${c.type}:${encodeURIComponent(c.value)}`
    )
    .join('|');
}

export function parseChips(q: string | null): SearchChip[] {
  if (!q) return [];
  const chips: SearchChip[] = [];
  for (const part of q.split('|')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const type = part.slice(0, idx);
    const rawValue = part.slice(idx + 1);
    if (!(CHIP_TYPES as readonly string[]).includes(type)) continue;
    try {
      if (type === 'concept' && rawValue.includes('~~')) {
        const sep = rawValue.indexOf('~~');
        chips.push({
          type: 'concept',
          value: decodeURIComponent(rawValue.slice(sep + 2)),
          prov: decodeURIComponent(rawValue.slice(0, sep))
        });
      } else {
        chips.push({ type: type as SearchChip['type'], value: decodeURIComponent(rawValue) });
      }
    } catch {
      continue;
    }
  }
  return chips;
}
```

Nota: el `import { formatCents } from './format';` debe quedar ARRIBA del fichero junto al import de `PivotDimension` (los imports van al principio; muévelo al añadir la sección).

- [ ] **Step 4: verde.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finance-pivot-search.test.ts
```

- [ ] **Step 5: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/src/lib/finance/pivot-state.ts apps/web/tests/finance-pivot-search.test.ts
git commit -m "feat(finanzas): buscador del pivot con chips tipados persistidos en la URL"
```

---

### Task 5: `pivot-state.ts` — dnd (payload, ghost, resúmenes) y codecs `exev`/`dupev`

**Files:**
- Modify: `apps/web/src/lib/finance/pivot-state.ts` (añadir sección)
- Test: `apps/web/tests/finance-pivot-dnd.test.ts`

**Interfaces:**
- Consumes: `SelectableItem` (tarea 3).
- Produces:
  - `interface DragPayload { items: SelectableItem[]; concepts: number; movs: number; omitted: number }`
  - `buildDragPayload(items, omitted = 0): DragPayload` · `dragGhostLabel(payload): string`
  - `createDragGhostElement(label: string): HTMLDivElement` (clase global `pivot-drag-ghost`, se autodescarta en el siguiente tick)
  - `summarizeEventDrop(movs: number, eventName: string, omitted = 0): string`
  - `summarizeCategoryDrop(movs: number, categoryPath: string, omitted = 0): string` (con el mensaje honesto «Nada que mover…» si `movs === 0`)
  - `parseIdList(raw: string | null): string[]` · `serializeIdList(ids: readonly string[]): string` (claves de URL `exev` y `dupev`, CSV, contrato del doc de interfaces)

Porta la intención de `/home/abf/github/home-finance/frontend/src/features/analytics/dnd.ts` (parte pura; las llamadas a la API del original se sustituyen en la tarea 6 por comandos de sync) y de `excludedEvents.ts` (ids `string`).

- [ ] **Step 1: test que falla.** Crea `apps/web/tests/finance-pivot-dnd.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  buildDragPayload, dragGhostLabel, parseIdList, serializeIdList,
  summarizeCategoryDrop, summarizeEventDrop,
  type SelectableItem
} from '../src/lib/finance/pivot-state';

const item = (partial: Partial<SelectableItem>): SelectableItem =>
  ({ key: 'k', parentKey: '', provider: 'Prov', concept: null, count: 1, ...partial });

describe('buildDragPayload', () => {
  it('cuenta conceptos, suma movs y arrastra los omitidos', () => {
    const p = buildDragPayload([item({ count: 3 }), item({ key: 'k2', count: 4 })], 2);
    expect(p.concepts).toBe(2);
    expect(p.movs).toBe(7);
    expect(p.omitted).toBe(2);
  });
});

describe('dragGhostLabel', () => {
  it('«nombre (n movs)» para uno; el concepto manda sobre el proveedor', () => {
    expect(dragGhostLabel(buildDragPayload([item({ concept: 'compra online', count: 5 })]))).toBe('compra online (5 movs)');
    expect(dragGhostLabel(buildDragPayload([item({ provider: 'Mercadona', count: 2 })]))).toBe('Mercadona (2 movs)');
  });
  it('usa la etiqueta de categoría para un nodo agregado', () => {
    const p = buildDragPayload([item({ provider: '', categoryId: 'c1', label: 'Ocio', count: 9 })]);
    expect(dragGhostLabel(p)).toBe('Ocio (9 movs)');
  });
  it('«k conceptos (n movs)» para varios', () => {
    const p = buildDragPayload([item({ key: 'a', count: 3 }), item({ key: 'b', count: 4 })]);
    expect(dragGhostLabel(p)).toBe('2 conceptos (7 movs)');
  });
});

describe('resúmenes de drop (toast honesto)', () => {
  it('evento: singular/plural y nota de omitidos', () => {
    expect(summarizeEventDrop(1, 'Boda')).toBe('1 movimiento → Boda · regla creada');
    expect(summarizeEventDrop(4, 'Boda', 2)).toBe('4 movimientos → Boda · regla creada · 2 sin proveedor omitidos');
  });
  it('categoría: mensaje honesto cuando no se movió nada', () => {
    expect(summarizeCategoryDrop(0, 'Ocio')).toBe('Nada que mover (las categorías no pueden soltarse sobre otra categoría)');
    expect(summarizeCategoryDrop(0, 'Ocio', 3)).toContain('3 omitidos');
    expect(summarizeCategoryDrop(0, 'Ocio')).not.toContain('regla creada');
    expect(summarizeCategoryDrop(2, 'Ocio', 1)).toBe('2 movimientos → Ocio · regla creada · 1 omitido');
  });
});

describe('parseIdList / serializeIdList (?exev= y ?dupev=)', () => {
  it('CSV deduplicado, ignora vacíos', () => {
    expect(parseIdList('a,b,a,,c')).toEqual(['a', 'b', 'c']);
    expect(parseIdList(null)).toEqual([]);
    expect(serializeIdList(['a', 'b'])).toBe('a,b');
  });
});
```

- [ ] **Step 2: rojo.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finance-pivot-dnd.test.ts
```

- [ ] **Step 3: implementación mínima.** AÑADE al final de `apps/web/src/lib/finance/pivot-state.ts`:

```ts
// ── Drag and drop: payload, ghost y resúmenes; codecs exev/dupev ─────────────

export interface DragPayload {
  items: SelectableItem[];
  concepts: number;
  movs: number;
  /** Hojas descartadas por no tener proveedor único (arrastre en bloque). */
  omitted: number;
}

export function buildDragPayload(items: SelectableItem[], omitted = 0): DragPayload {
  return { items, concepts: items.length, movs: items.reduce((s, i) => s + i.count, 0), omitted };
}

export function dragGhostLabel(payload: DragPayload): string {
  if (payload.items.length === 1) {
    const it = payload.items[0];
    return `${it.label ?? it.concept ?? it.provider} (${it.count} movs)`;
  }
  return `${payload.concepts} conceptos (${payload.movs} movs)`;
}

/**
 * Elemento offscreen para setDragImage; se elimina en el siguiente tick (el
 * navegador ya habrá tomado la instantánea). El estilo vive en la clase GLOBAL
 * `pivot-drag-ghost` (PivotTable.svelte) para pasar el linter de tokens.
 */
export function createDragGhostElement(label: string): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = label;
  el.className = 'pivot-drag-ghost';
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 0);
  return el;
}

const plural = (n: number, s: string, p: string) => (n === 1 ? s : p);

export function summarizeEventDrop(movs: number, eventName: string, omitted = 0): string {
  const base = `${movs} ${plural(movs, 'movimiento', 'movimientos')} → ${eventName} · regla creada`;
  return omitted > 0 ? `${base} · ${omitted} sin proveedor ${plural(omitted, 'omitido', 'omitidos')}` : base;
}

export function summarizeCategoryDrop(movs: number, categoryPath: string, omitted = 0): string {
  const suffix = omitted > 0 ? ` · ${omitted} ${plural(omitted, 'omitido', 'omitidos')}` : '';
  if (movs === 0) return `Nada que mover (las categorías no pueden soltarse sobre otra categoría)${suffix}`;
  return `${movs} ${plural(movs, 'movimiento', 'movimientos')} → ${categoryPath} · regla creada${suffix}`;
}

// exev (partidas excluidas de KPIs/gráfica) y dupev (eventos duplicados en
// GASTOS/INGRESOS): CSV de ids en la URL, merge no destructivo como dims/q.
export function parseIdList(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').filter((s) => s.length > 0))];
}

export function serializeIdList(ids: readonly string[]): string {
  return ids.join(',');
}
```

- [ ] **Step 4: verde y suite completa del módulo.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finance-pivot-dnd.test.ts tests/finance-pivot-dims.test.ts tests/finance-pivot-selection.test.ts tests/finance-pivot-search.test.ts
```

- [ ] **Step 5: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/src/lib/finance/pivot-state.ts apps/web/tests/finance-pivot-dnd.test.ts
git commit -m "feat(finanzas): payload y resúmenes del dnd del pivot; codecs exev/dupev"
```

---

### Task 6: `pivot-actions.ts` — comandos de sync del pivot y plan de deshacer

**Files:**
- Create: `apps/web/src/lib/finance/pivot-actions.ts`
- Test: `apps/web/tests/finance-pivot-actions.test.ts`

**Interfaces:**
- Consumes: `createCommandEnvelope` de `$lib/offline/schema`; `queueCommand`, `QueueCommandResult` de `$lib/offline/queue-command` (existen hoy en el repo); `SelectableItem` de `./pivot-state`; kinds canónicos del doc de interfaces: `finance.category.assignConcept`, `finance.event.assignConcept`, `finance.event.create`, `finance.transactions.bulk`, `finance.transactions.assignConceptRecurrence`, `finance.transaction.invest`.
- Produces:
  - `sendFinanceCommand(householdId: string, payload: Record<string, unknown>): Promise<QueueCommandResult>`
  - Constructores puros de payloads: `assignConceptToCategory`, `assignConceptToEvent`, `undoEventAssign`, `assignConceptRecurrence`, `bulkByIds`, `investTransaction`, `createEventPayload`, `conceptTargetOf`
  - `buildTxCategoryIndex(rows): Map<string, string | null>` y `planCategoryUndo(items, nodeMovIds, txCat): CategoryUndo`

**⚠ Step 1 obligatorio (alineación con fases 1 y 5):** antes de escribir código, abre (a) `packages/contracts/src/index.ts` y localiza el valor que la fase 1 añadió a `AggregateType` para finanzas, (b) los esquemas de payloads `finance.*` en `packages/contracts` (la fase 1/5 los dejó donde están los de `expense.*`), y (c) `apps/web/src/routes/h/[householdId]/finanzas/revision/+page.svelte` (fase 5) para ver cómo esa página construye y encola sus envelopes. El código de esta tarea asume `aggregateType: 'finance'` y payloads `{ kind: '<nombre canónico>', …campos camelCase }`; si el repo real difiere en el aggregateType o en el nombre de algún CAMPO, usa los del repo (los `kind` son canónicos y no se tocan).

- [ ] **Step 2: test que falla.** Crea `apps/web/tests/finance-pivot-actions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  assignConceptRecurrence, assignConceptToCategory, assignConceptToEvent, buildTxCategoryIndex,
  bulkByIds, conceptTargetOf, createEventPayload, investTransaction, planCategoryUndo, undoEventAssign
} from '../src/lib/finance/pivot-actions';
import type { SelectableItem } from '../src/lib/finance/pivot-state';

const item = (partial: Partial<SelectableItem>): SelectableItem =>
  ({ key: 'k', parentKey: '', provider: 'Prov', concept: null, count: 1, ...partial });

describe('constructores de payloads (kinds canónicos del doc de interfaces)', () => {
  it('conceptTargetOf: categoría entera en una sola llamada, o proveedor/concepto', () => {
    expect(conceptTargetOf(item({ provider: '', categoryId: 'c1' }))).toEqual({ categoryId: 'c1' });
    expect(conceptTargetOf(item({ provider: 'Mercadona', concept: 'Compra' })))
      .toEqual({ provider: 'Mercadona', concept: 'Compra' });
    expect(conceptTargetOf(item({ provider: 'Mercadona' }))).toEqual({ provider: 'Mercadona' });
  });
  it('asignar a evento existente, a evento nuevo y deshacer (eventId null)', () => {
    expect(assignConceptToEvent({ categoryId: 'c1' }, { eventId: 'e1' }))
      .toEqual({ kind: 'finance.event.assignConcept', categoryId: 'c1', eventId: 'e1' });
    expect(assignConceptToEvent({ provider: 'P' }, { newEventName: 'Boda' }))
      .toEqual({ kind: 'finance.event.assignConcept', provider: 'P', newEventName: 'Boda' });
    expect(undoEventAssign({ provider: 'P' }))
      .toEqual({ kind: 'finance.event.assignConcept', provider: 'P', eventId: null });
  });
  it('recategorizar concepto y naturaleza por concepto', () => {
    expect(assignConceptToCategory('Mercadona', 'Compra', 'c2'))
      .toEqual({ kind: 'finance.category.assignConcept', provider: 'Mercadona', concept: 'Compra', categoryId: 'c2' });
    expect(assignConceptRecurrence({ categoryId: 'c1' }, 'recurrente'))
      .toEqual({ kind: 'finance.transactions.assignConceptRecurrence', categoryId: 'c1', recurrence: 'recurrente' });
  });
  it('acciones por ids exactos: bulk, invertir, crear evento', () => {
    expect(bulkByIds(['t1', 't2'], { categoryId: 'c1' }))
      .toEqual({ kind: 'finance.transactions.bulk', txIds: ['t1', 't2'], categoryId: 'c1' });
    expect(bulkByIds(['t1'], { addEventId: 'e1' }))
      .toEqual({ kind: 'finance.transactions.bulk', txIds: ['t1'], addEventId: 'e1' });
    expect(investTransaction('t1', 'a1'))
      .toEqual({ kind: 'finance.transaction.invest', txId: 't1', accountId: 'a1' });
    expect(createEventPayload('Boda')).toEqual({ kind: 'finance.event.create', name: 'Boda' });
  });
});

describe('plan de deshacer una recategorización', () => {
  const rows = [
    { catId: 'c1', movs: [{ id: 't1' }, { id: 't2' }] },
    { catId: 'c2', movs: [{ id: 't3' }] },
    { catId: null, movs: [{ id: 't4' }] }
  ];
  const txCat = buildTxCategoryIndex(rows);

  it('indexa tx → categoría previa', () => {
    expect(txCat.get('t1')).toBe('c1');
    expect(txCat.get('t4')).toBeNull();
  });

  it('categoría previa única → volver a asignar el concepto (revierte también la regla)', () => {
    const nodeMovIds = new Map([['/cat:X/prov:P', ['t1', 't2']]]);
    const plan = planCategoryUndo([item({ key: '/cat:X/prov:P', provider: 'P', count: 2 })], nodeMovIds, txCat);
    expect(plan.reassignments).toEqual([{ provider: 'P', concept: null, categoryId: 'c1' }]);
    expect(plan.bulkRestores).toEqual([]);
    expect(plan.skipped).toBe(0);
  });

  it('previas mixtas → restauración por ids agrupada; las previas null se saltan y se cuentan', () => {
    const nodeMovIds = new Map([['/cat:X/prov:P', ['t1', 't3', 't4']]]);
    const plan = planCategoryUndo([item({ key: '/cat:X/prov:P', provider: 'P', count: 3 })], nodeMovIds, txCat);
    expect(plan.reassignments).toEqual([]);
    expect(plan.bulkRestores).toEqual([
      { txIds: ['t1'], categoryId: 'c1' },
      { txIds: ['t3'], categoryId: 'c2' }
    ]);
    expect(plan.skipped).toBe(1);
  });

  it('los ítems categoría/subcategoría no entran en el plan (el drop tampoco los procesa)', () => {
    const plan = planCategoryUndo([item({ provider: '', categoryId: 'c9' })], new Map(), txCat);
    expect(plan.reassignments).toEqual([]);
    expect(plan.bulkRestores).toEqual([]);
  });
});
```

- [ ] **Step 3: rojo.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finance-pivot-actions.test.ts
```

- [ ] **Step 4: implementación mínima.** Crea `apps/web/src/lib/finance/pivot-actions.ts`:

```ts
import type { AggregateType } from '@casa-clara/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';
import { queueCommand, type QueueCommandResult } from '$lib/offline/queue-command';

import type { SelectableItem } from './pivot-state';

/**
 * Comandos de sync que dispara el pivot (dnd y barra de acciones) y el plan de
 * «Deshacer». Los `kind` son los canónicos del doc de interfaces; el sobre y
 * los nombres de campo replican los de la fase 5 (ver Revisión) — si el repo
 * usa otro aggregateType o algún campo distinto, alinéalo AQUÍ, en un solo sitio.
 */
const FINANCE_AGGREGATE = 'finance' as AggregateType; // Step 1: confirmado contra contracts

export async function sendFinanceCommand(
  householdId: string,
  payload: Record<string, unknown>
): Promise<QueueCommandResult> {
  return queueCommand(createCommandEnvelope({ householdId, aggregateType: FINANCE_AGGREGATE, payload }));
}

// ── Objetivo «concepto»: categoría entera o proveedor(+concepto) ─────────────

export interface ConceptTarget {
  categoryId?: string;
  provider?: string;
  concept?: string;
}

export function conceptTargetOf(item: SelectableItem): ConceptTarget {
  if (item.categoryId != null) return { categoryId: item.categoryId };
  return { provider: item.provider, ...(item.concept != null ? { concept: item.concept } : {}) };
}

// ── Constructores puros de payloads (un objeto = un comando) ─────────────────

export function assignConceptToEvent(
  target: ConceptTarget,
  destination: { eventId: string } | { newEventName: string }
): Record<string, unknown> {
  return { kind: 'finance.event.assignConcept', ...target, ...destination };
}

/** Deshacer una asignación a evento: eventId null borra asignaciones y reglas creadas. */
export function undoEventAssign(target: ConceptTarget): Record<string, unknown> {
  return { kind: 'finance.event.assignConcept', ...target, eventId: null };
}

export function assignConceptToCategory(
  provider: string,
  concept: string | null,
  categoryId: string
): Record<string, unknown> {
  return {
    kind: 'finance.category.assignConcept',
    provider,
    ...(concept != null ? { concept } : {}),
    categoryId
  };
}

export function assignConceptRecurrence(
  target: ConceptTarget,
  recurrence: 'recurrente' | 'extraordinario'
): Record<string, unknown> {
  return { kind: 'finance.transactions.assignConceptRecurrence', ...target, recurrence };
}

export function bulkByIds(
  txIds: readonly string[],
  set: { categoryId?: string; addEventId?: string; recurrence?: 'recurrente' | 'extraordinario' }
): Record<string, unknown> {
  return { kind: 'finance.transactions.bulk', txIds: [...txIds], ...set };
}

export function investTransaction(txId: string, accountId: string): Record<string, unknown> {
  return { kind: 'finance.transaction.invest', txId, accountId };
}

export function createEventPayload(name: string): Record<string, unknown> {
  return { kind: 'finance.event.create', name };
}

// ── Deshacer una recategorización ────────────────────────────────────────────
// El ACK de sync no devuelve «categorías previas», así que el plan se captura
// EN EL CLIENTE antes de soltar: las filas del pivot ya saben la categoría de
// cada movimiento. Previa única → re-asignar el concepto (revierte también la
// regla); previas mixtas → restauración por ids (la regla creada queda: el
// toast lo avisa y se borra en Ajustes).

export function buildTxCategoryIndex(
  rows: readonly { catId: string | null; movs: readonly { id: string }[] }[]
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const row of rows) for (const mov of row.movs) map.set(mov.id, row.catId);
  return map;
}

export interface CategoryUndo {
  reassignments: { provider: string; concept: string | null; categoryId: string }[];
  bulkRestores: { txIds: string[]; categoryId: string }[];
  /** Movimientos cuya categoría previa se desconoce (null): no se restauran. */
  skipped: number;
}

export function planCategoryUndo(
  items: readonly SelectableItem[],
  nodeMovIds: ReadonlyMap<string, string[]>,
  txCat: ReadonlyMap<string, string | null>
): CategoryUndo {
  const plan: CategoryUndo = { reassignments: [], bulkRestores: [], skipped: 0 };
  for (const item of items) {
    if (item.categoryId != null) continue; // el drop no procesa categorías: nada que deshacer
    const ids = item.txId != null ? [item.txId] : (nodeMovIds.get(item.key) ?? []);
    const prevs = new Set(ids.map((id) => txCat.get(id) ?? null));
    const [only] = [...prevs];
    if (prevs.size === 1 && only != null && item.provider) {
      plan.reassignments.push({ provider: item.provider, concept: item.concept, categoryId: only });
      continue;
    }
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const prev = txCat.get(id) ?? null;
      if (prev === null) {
        plan.skipped += 1;
        continue;
      }
      groups.set(prev, [...(groups.get(prev) ?? []), id]);
    }
    for (const [categoryId, txIds] of groups) plan.bulkRestores.push({ txIds, categoryId });
  }
  return plan;
}
```

- [ ] **Step 5: verde.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finance-pivot-actions.test.ts
```

- [ ] **Step 6: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/src/lib/finance/pivot-actions.ts apps/web/tests/finance-pivot-actions.test.ts
git commit -m "feat(finanzas): comandos de sync del pivot y plan de deshacer en cliente"
```

---

### Task 7: `NatureStackChart.svelte` — gráfica apilada por naturaleza con líneas de ahorro (SVG artesanal)

**Files:**
- Create: `apps/web/src/lib/components/finance/NatureStackChart.svelte`

**Interfaces:**
- Consumes: `NatureChartPoint`, `monthLabel` de `$lib/finance/chart-data`; `formatCents` de `$lib/finance/format`; tokens de `apps/web/src/app.css`.
- Produces: componente con props `{ points: NatureChartPoint[] }`.

Patrón a imitar: los otros charts SVG de finanzas de la fase 4 (`apps/web/src/lib/components/finance/CashflowChart.svelte` — ábrelo y calca su manera de escalar, sus roles ARIA y su manejo de `prefers-reduced-motion` si lo tiene). Sin librerías; `Number(...)` sobre céntimos SOLO para coordenadas.

- [ ] **Step 1: comprueba el rojo de tipos.** Crea un fichero vacío `apps/web/src/lib/components/finance/NatureStackChart.svelte` con `<script lang="ts">let { points } = $props();</script>` y ejecuta:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm check
```

Salida esperada: error de svelte-check por `points` sin tipo (rojo de tipos: aquí no hay test unitario de componente en este repo; la verificación funcional llega con la e2e de la tarea 14).

- [ ] **Step 2: implementación.** Sustituye el contenido por:

```svelte
<script lang="ts">
  import { monthLabel, type NatureChartPoint } from '$lib/finance/chart-data';
  import { formatCents } from '$lib/finance/format';

  let { points }: { points: NatureChartPoint[] } = $props();

  // Geometría (viewBox fijo; el ancho real lo da el contenedor).
  const W = 720;
  const H = 300;
  const PAD = { top: 12, right: 12, bottom: 28, left: 64 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const n = (v: bigint) => Number(v) / 100; // euros SOLO para coordenadas

  const maxPos = $derived(
    Math.max(
      1,
      ...points.map((p) => n(p.ingresosRecCents + p.ingresosExtCents + p.ingresosSinCents)),
      ...points.map((p) => n(p.gastosRecCents + p.gastosExtCents + p.gastosSinCents)),
      ...points.map((p) => n(p.inversionCents)),
      ...points.map((p) => n(p.ahorroBrutoCents))
    )
  );
  const minNeg = $derived(Math.min(0, ...points.map((p) => n(p.ahorroNetoCents))));
  const y = $derived((euros: number) => PAD.top + ((maxPos - euros) / (maxPos - minNeg)) * innerH);
  const slotW = $derived(points.length ? innerW / points.length : innerW);
  const barW = $derived(Math.min(18, slotW / 4));
  const xSlot = (i: number) => PAD.left + i * slotW;

  interface Segment { x: number; yTop: number; h: number; fill: string; name: string; cents: bigint }
  function stack(x: number, parts: { cents: bigint; fill: string; name: string }[]): Segment[] {
    let acc = 0;
    const out: Segment[] = [];
    for (const part of parts) {
      const h = (n(part.cents) / (maxPos - minNeg)) * innerH;
      out.push({ x, yTop: y(acc + n(part.cents)), h, fill: part.fill, name: part.name, cents: part.cents });
      acc += n(part.cents);
    }
    return out;
  }

  const bars = $derived(
    points.map((p, i) => ({
      point: p,
      gastos: stack(xSlot(i) + slotW / 2 - barW * 1.6, [
        { cents: p.gastosRecCents, fill: 'var(--danger)', name: 'Gastos ♻' },
        { cents: p.gastosExtCents, fill: 'var(--danger-soft)', name: 'Gastos ✦' },
        { cents: p.gastosSinCents, fill: 'var(--line-strong)', name: 'Gastos sin clasificar' }
      ]),
      ingresos: stack(xSlot(i) + slotW / 2 - barW * 0.5, [
        { cents: p.ingresosRecCents, fill: 'var(--success)', name: 'Ingresos ♻' },
        { cents: p.ingresosExtCents, fill: 'var(--success-soft)', name: 'Ingresos ✦' },
        { cents: p.ingresosSinCents, fill: 'var(--line-strong)', name: 'Ingresos sin clasificar' }
      ]),
      inversion: stack(xSlot(i) + slotW / 2 + barW * 0.6, [
        { cents: p.inversionCents, fill: 'var(--accent)', name: 'Inversión' }
      ])
    }))
  );

  const lineOf = (value: (p: NatureChartPoint) => bigint) =>
    points.map((p, i) => `${xSlot(i) + slotW / 2},${y(n(value(p)))}`).join(' ');
  const netoLine = $derived(lineOf((p) => p.ahorroNetoCents));
  const brutoLine = $derived(lineOf((p) => p.ahorroBrutoCents));
</script>

<figure class="nature-chart">
  <svg viewBox="0 0 {W} {H}" role="img" aria-label="Evolución mensual por naturaleza con ahorro neto y bruto">
    <line x1={PAD.left} y1={y(0)} x2={W - PAD.right} y2={y(0)} class="axis" />
    {#each bars as b, i}
      {#each [...b.gastos, ...b.ingresos, ...b.inversion] as seg}
        {#if seg.cents !== 0n}
          <rect x={seg.x} y={seg.yTop} width={barW} height={Math.max(1, seg.h)} fill={seg.fill}>
            <title>{monthLabel(b.point.month)} · {seg.name}: {formatCents(seg.cents)}</title>
          </rect>
        {/if}
      {/each}
      <text x={xSlot(i) + slotW / 2} y={H - 8} text-anchor="middle" class="tick">{monthLabel(b.point.month)}</text>
    {/each}
    {#if points.length > 1}
      <polyline points={netoLine} class="line-neto" />
      <polyline points={brutoLine} class="line-bruto" />
    {/if}
    <text x={PAD.left - 6} y={PAD.top + 8} text-anchor="end" class="tick">{formatCents(BigInt(Math.round(maxPos)) * 100n)}</text>
    <text x={PAD.left - 6} y={y(0) + 4} text-anchor="end" class="tick">0 €</text>
  </svg>
  <figcaption class="nature-legend">
    <span><i class="dot gasto"></i> Gastos ♻/✦/—</span>
    <span><i class="dot ingreso"></i> Ingresos ♻/✦/—</span>
    <span><i class="dot inversion"></i> Inversión</span>
    <span><i class="dash neto"></i> Ahorro neto</span>
    <span><i class="dash bruto"></i> Ahorro bruto</span>
  </figcaption>
</figure>

<style>
  .nature-chart { margin: 0; }
  .nature-chart svg { width: 100%; height: auto; }
  .axis { stroke: var(--line-strong); }
  .tick { font-size: var(--text-micro); fill: var(--ink-faint); font-variant-numeric: tabular-nums; }
  .line-neto { fill: none; stroke: var(--ink); stroke-width: 2; }
  .line-bruto { fill: none; stroke: var(--accent); stroke-width: 2; stroke-dasharray: 5 4; }
  .nature-legend { display: flex; flex-wrap: wrap; gap: var(--space-3); font-size: var(--text-meta); color: var(--ink-soft); margin-top: var(--space-2); }
  .dot, .dash { display: inline-block; width: var(--space-3); height: var(--space-2); border-radius: var(--r-sm); }
  .dot.gasto { background: var(--danger); }
  .dot.ingreso { background: var(--success); }
  .dot.inversion { background: var(--accent); }
  .dash { height: 0; border-top: 2px dashed var(--accent); border-radius: 0; }
  .dash.neto { border-top: 2px solid var(--ink); }
</style>
```

- [ ] **Step 3: verde de tipos y linter de tokens.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm check
```

Salida esperada: `svelte-check found 0 errors` y el linter de tokens sin quejas.

- [ ] **Step 4: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/src/lib/components/finance/NatureStackChart.svelte
git commit -m "feat(finanzas): gráfica apilada por naturaleza con líneas de ahorro en SVG propio"
```

---

### Task 8: Analítica — carga bajo RLS + maqueta sintética + KPIs, medias y partidas

**Files:**
- Create: `apps/web/src/lib/finance/analitica-data.ts` (tipos compartidos cliente/servidor)
- Create: `apps/web/src/lib/server/finanzas-analitica-demo.server.ts`
- Modify: `apps/web/src/routes/h/[householdId]/finanzas/analitica/+page.server.ts` (esqueleto de fase 1)
- Modify: `apps/web/src/routes/h/[householdId]/finanzas/analitica/+page.svelte` (esqueleto de fase 1)
- Test: `apps/web/tests/finanzas-analitica-demo.test.ts`

**Interfaces:**
- Consumes: `demoOrUnavailable`, `unreadable` de `$lib/server/data-source.server`; funciones de lectura de `packages/server/src/finance/queries.ts` (fase 4) — **las MISMAS que usan los endpoints** `apps/web/src/routes/api/v1/finance/{summary,analytics,pivot,events-summary}/+server.ts`; helpers de filtros de `$lib/finance/filters.ts` (fase 4); `FinanceFilterBar.svelte` (fase 4); `monthsInRange`, `perMonth`, `pctOf`, `buildNatureChartData` (tarea 1); `parseIdList`/`serializeIdList` (tarea 5); `formatCents`.
- Produces: `interface AnaliticaData` (abajo) devuelta por el `load` como `{ analitica: AnaliticaData }`; página con testids `kpi-analitica`, `partidas-tabla`.

**⚠ Step 1 obligatorio (alineación con fase 4):** abre `apps/web/src/routes/h/[householdId]/finanzas/+page.server.ts` (Dashboard, fase 4) y los cuatro endpoints GET citados. Copia del Dashboard: (a) cómo lee los filtros de URL con `$lib/finance/filters.ts` y sus valores por defecto, (b) cómo llama a queries bajo la sesión/membresía, (c) cómo construye su rama `demoOrUnavailable()` y qué módulo de maqueta reutiliza (si la fase 4 dejó un módulo de maqueta de finanzas, REUTILIZA sus cuentas/categorías y añade allí lo que falte en vez de duplicar). Los nombres exactos de las funciones de `queries.ts` los da ese código; el `load` de abajo marca con `// fase 4` cada punto a alinear.

- [ ] **Step 2: test que falla (coherencia de la maqueta).** Crea `apps/web/tests/finanzas-analitica-demo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { buildAnaliticaDemo } from '../src/lib/server/finanzas-analitica-demo.server';

describe('maqueta sintética de Analítica (modo demo, datos inventados)', () => {
  const demo = buildAnaliticaDemo();

  it('cubre las cinco secciones del pivot y tres meses', () => {
    expect(demo.months).toEqual(['2026-01', '2026-02', '2026-03']);
    const kinds = new Set(demo.pivotRows.map((r) => r.kind));
    expect(kinds).toEqual(new Set(['gasto', 'ingreso', 'transferencia', 'inversion']));
    expect(demo.pivotRows.some((r) => r.eventId !== null)).toBe(true);
  });

  it('las internas de la maqueta suman 0 (invariante del subtotal)', () => {
    const internas = demo.pivotRows.filter((r) => r.kind === 'transferencia');
    expect(internas.reduce((s, r) => s + r.totalCents, 0n)).toBe(0n);
  });

  it('el resumen es coherente con las filas (ahorro = ingresos + gastos)', () => {
    expect(demo.summary.savingsCents).toBe(demo.summary.incomeCents + demo.summary.expenseCents);
  });

  it('cada movimiento tiene id propio (los usa la resolución por ids)', () => {
    const ids = demo.pivotRows.flatMap((r) => r.movs.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hay una categoría destino para el dnd distinta de las de origen y un evento vacío', () => {
    expect(demo.categories.some((c) => c.name === 'Restaurantes')).toBe(true);
    expect(demo.eventsSummary.some((e) => e.name === 'Cumple Leo' && e.txCount === 0)).toBe(true);
  });
});
```

- [ ] **Step 3: rojo.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finanzas-analitica-demo.test.ts
```

- [ ] **Step 4: tipos + maqueta.** Crea `apps/web/src/lib/finance/analitica-data.ts`:

```ts
import type { AnalyticsRowLike } from './chart-data';

/** Contrato del load de Analítica (real y demo). Céntimos SIEMPRE bigint. */

export type PivotRowKind = 'gasto' | 'ingreso' | 'transferencia' | 'inversion';
export type Nature = 'recurrente' | 'extraordinario' | null;

/**
 * Fila fuente del pivot, forma del PivotSourceRow del dominio (fase 2, port
 * camelCase del original). Si el dominio nombra distinto, adapta AQUÍ el mapeo
 * (el cliente solo conoce este tipo).
 */
export interface AnaliticaPivotRow {
  cat: string;
  sub: string | null;
  catId: string | null;
  nat: Nature;
  prov: string;
  concept: string;
  event: string | null;
  eventId: string | null;
  kind: PivotRowKind;
  month: string;
  totalCents: bigint;
  count: number;
  movs: { id: string; date: string; cents: bigint }[];
}

export interface AnaliticaSummary {
  incomeCents: bigint;
  expenseCents: bigint;
  recurringExpenseCents: bigint;
  extraordinaryExpenseCents: bigint;
  unclassifiedExpenseCents: bigint;
  savingsCents: bigint;
  netSavingsRate: number | null;
  grossSavingsRate: number | null;
  investedCents: bigint;
  investmentRate: number | null;
  freeCashFlowCents: bigint;
  opsCashFlowCents: bigint;
  receivedContributionsCents: bigint;
  outgoingTransfersCents: bigint;
  pendingCount: number;
}

export interface AnaliticaEventSummary {
  id: string;
  name: string;
  txCount: number;
  netCents: bigint;
  incomeCents: bigint;
  expenseCents: bigint;
}

export interface AnaliticaCategory {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'gasto' | 'ingreso' | 'transferencia';
}

export interface AnaliticaData {
  from: string;
  to: string;
  months: string[];
  summary: AnaliticaSummary;
  analyticsRows: AnalyticsRowLike[];
  pivotRows: AnaliticaPivotRow[];
  eventsSummary: AnaliticaEventSummary[];
  categories: AnaliticaCategory[];
  invAccounts: { id: string; name: string }[];
}

/** Ruta legible de una categoría («Padre > Hija»). */
export function categoryPathOf(categories: readonly AnaliticaCategory[], id: string): string {
  const cat = categories.find((c) => c.id === id);
  if (!cat) return id;
  if (cat.parentId === null) return cat.name;
  const parent = categories.find((c) => c.id === cat.parentId);
  return parent ? `${parent.name} > ${cat.name}` : cat.name;
}
```

Crea `apps/web/src/lib/server/finanzas-analitica-demo.server.ts` (datos 100 % inventados; si la fase 4 dejó un módulo de maqueta de finanzas, importa de él cuentas/categorías comunes y conserva aquí solo lo propio de Analítica):

```ts
import { demoOnly } from '$lib/server/data-source.server';
import type { AnaliticaData, AnaliticaPivotRow } from '$lib/finance/analitica-data';

const mov = (id: string, date: string, cents: bigint) => ({ id, date, cents });

function rows(): AnaliticaPivotRow[] {
  const base = {
    sub: null, event: null, eventId: null, nat: null as AnaliticaPivotRow['nat']
  };
  return [
    // Gasto recurrente: Mercadona bajo Supermercado, tres meses.
    ...(['2026-01', '2026-02', '2026-03'] as const).map((month, i): AnaliticaPivotRow => ({
      ...base, kind: 'gasto', cat: 'Supermercado', catId: 'demo-cat-super', nat: 'recurrente',
      prov: 'Mercadona', concept: 'COMPRA TARJ. MERCADONA', month, totalCents: -12000n, count: 1,
      movs: [mov(`demo-tx-sup-${i + 1}`, `${month}-05`, -12000n)]
    })),
    // Gasto extraordinario puntual: Cine Ideal bajo Ocio.
    {
      ...base, kind: 'gasto', cat: 'Ocio', catId: 'demo-cat-ocio', nat: 'extraordinario',
      prov: 'Cine Ideal', concept: 'ENTRADAS CINE', month: '2026-02', totalCents: -4500n, count: 1,
      movs: [mov('demo-tx-cine-1', '2026-02-14', -4500n)]
    },
    // Ingreso recurrente: nómina ACME.
    ...(['2026-01', '2026-02', '2026-03'] as const).map((month, i): AnaliticaPivotRow => ({
      ...base, kind: 'ingreso', cat: 'Nómina', catId: 'demo-cat-nomina', nat: 'recurrente',
      prov: 'ACME SL', concept: 'NOMINA ACME', month, totalCents: 300000n, count: 1,
      movs: [mov(`demo-tx-nom-${i + 1}`, `${month}-28`, 300000n)]
    })),
    // Evento: Vueling bajo Viajes, etiquetado «Semana Santa 2026».
    {
      ...base, kind: 'gasto', cat: 'Viajes', catId: 'demo-cat-viajes', nat: 'extraordinario',
      prov: 'Vueling', concept: 'BILLETES VLC', event: 'Semana Santa 2026', eventId: 'demo-ev-ss',
      month: '2026-03', totalCents: -22000n, count: 1,
      movs: [mov('demo-tx-vue-1', '2026-03-20', -22000n)]
    },
    // Internas: dos patas del mismo traspaso, suman 0.
    {
      ...base, kind: 'transferencia', cat: 'Traspaso hogar', catId: null,
      prov: 'Cuenta Común', concept: 'TRASPASO MENSUAL', month: '2026-01', totalCents: -50000n, count: 1,
      movs: [mov('demo-tx-tra-1', '2026-01-02', -50000n)]
    },
    {
      ...base, kind: 'transferencia', cat: 'Traspaso hogar', catId: null,
      prov: 'Cuenta Nómina', concept: 'TRASPASO MENSUAL', month: '2026-01', totalCents: 50000n, count: 1,
      movs: [mov('demo-tx-tra-2', '2026-01-02', 50000n)]
    },
    // Inversión: aportación a Indexa.
    {
      ...base, kind: 'inversion', cat: 'Indexa Capital', catId: null,
      prov: 'Indexa Capital', concept: 'Aportación fondo', month: '2026-02', totalCents: 20000n, count: 1,
      movs: [mov('demo-tx-inv-1', '2026-02-10', 20000n)]
    }
  ];
}

/** Maqueta de Analítica: solo existe sin base de datos (demoOnly la protege). */
export const buildAnaliticaDemo = demoOnly('finanzas-analitica', (): AnaliticaData => {
  const pivotRows = rows();
  return {
    from: '2026-01-01',
    to: '2026-03-31',
    months: ['2026-01', '2026-02', '2026-03'],
    summary: {
      incomeCents: 900000n,
      expenseCents: -62500n,
      recurringExpenseCents: -36000n,
      extraordinaryExpenseCents: -26500n,
      unclassifiedExpenseCents: 0n,
      savingsCents: 837500n,
      netSavingsRate: 93,
      grossSavingsRate: 96,
      investedCents: 20000n,
      investmentRate: 2,
      freeCashFlowCents: 817500n,
      opsCashFlowCents: 837500n,
      receivedContributionsCents: 0n,
      outgoingTransfersCents: 0n,
      pendingCount: 2
    },
    analyticsRows: [
      { kind: 'gasto', monthly: {
        '2026-01': { totalCents: -12000n, recCents: -12000n, extCents: 0n },
        '2026-02': { totalCents: -16500n, recCents: -12000n, extCents: -4500n },
        '2026-03': { totalCents: -34000n, recCents: -12000n, extCents: -22000n }
      } },
      { kind: 'ingreso', monthly: {
        '2026-01': { totalCents: 300000n, recCents: 300000n, extCents: 0n },
        '2026-02': { totalCents: 300000n, recCents: 300000n, extCents: 0n },
        '2026-03': { totalCents: 300000n, recCents: 300000n, extCents: 0n }
      } },
      { kind: 'inversion', monthly: { '2026-02': { totalCents: 20000n, recCents: 0n, extCents: 0n } } },
      { kind: 'transferencia', monthly: { '2026-01': { totalCents: 0n, recCents: 0n, extCents: 0n } } }
    ],
    pivotRows,
    eventsSummary: [
      { id: 'demo-ev-ss', name: 'Semana Santa 2026', txCount: 1, netCents: -22000n, incomeCents: 0n, expenseCents: -22000n },
      { id: 'demo-ev-leo', name: 'Cumple Leo', txCount: 0, netCents: 0n, incomeCents: 0n, expenseCents: 0n }
    ],
    categories: [
      { id: 'demo-cat-super', parentId: null, name: 'Supermercado', kind: 'gasto' },
      { id: 'demo-cat-ocio', parentId: null, name: 'Ocio', kind: 'gasto' },
      { id: 'demo-cat-rest', parentId: null, name: 'Restaurantes', kind: 'gasto' },
      { id: 'demo-cat-viajes', parentId: null, name: 'Viajes', kind: 'gasto' },
      { id: 'demo-cat-nomina', parentId: null, name: 'Nómina', kind: 'ingreso' }
    ],
    invAccounts: [{ id: 'demo-acc-indexa', name: 'Indexa Capital' }]
  };
});
```

- [ ] **Step 5: verde de la maqueta.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm vitest run tests/finanzas-analitica-demo.test.ts
```

- [ ] **Step 6: el load.** Sustituye `apps/web/src/routes/h/[householdId]/finanzas/analitica/+page.server.ts`:

```ts
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { buildAnaliticaDemo } from '$lib/server/finanzas-analitica-demo.server';
import type { AnaliticaData } from '$lib/finance/analitica-data';
import type { PageServerLoad } from './$types';

// fase 4: importa AQUÍ exactamente las funciones de queries que usan los
// endpoints GET summary/analytics/pivot/events-summary y el helper de filtros
// de $lib/finance/filters.ts que usa el Dashboard (mismos nombres, mismos
// valores por defecto de from/to/g/acc/ev/exev).

export const load: PageServerLoad = async ({ locals, params, url }) => {
  if (locals.user) {
    // Rama real, bajo RLS y con la MISMA lectura de filtros que el Dashboard
    // (fase 4). exev se pasa a summary/analytics; el pivot recibe también
    // dims/dupev tal cual llegan en la URL. Mapea el resultado a AnaliticaData
    // (los nombres de campo del dominio mandan; ver analitica-data.ts).
    // Estructura (rellena con las funciones reales de queries.ts):
    //
    //   const filters = parseFinanceFilters(url.searchParams);          // fase 4
    //   const summary = await readFinanceSummary(...);                  // fase 4
    //   const analytics = await readFinanceAnalytics(...);              // fase 4
    //   const pivot = await readFinancePivot(...);                      // fase 4
    //   const events = await readFinanceEventsSummary(...);             // fase 4
    //   const categories = await readFinanceCategories(...);            // fase 4 (la usa Movimientos)
    //   const accounts = await readFinanceAccounts(...);                // fase 4 (Ajustes/FilterBar)
    //   if (summary) {
    //     const analitica: AnaliticaData = { from: filters.from, to: filters.to,
    //       months: pivot.months, summary, analyticsRows: analytics.rows,
    //       pivotRows: pivot.rows, eventsSummary: events,
    //       categories, invAccounts: accounts.filter((a) => a.kind === 'inversion') };
    //     return { analitica };
    //   }
    //   // null ⇒ sin autorización: cae al 503/maqueta de abajo igual que Contactos.
  }
  return demoOrUnavailable(() => ({ analitica: buildAnaliticaDemo() satisfies AnaliticaData }));
};
```

Completa la rama real con los imports y llamadas reales (el bloque comentado es la forma; los nombres, los del repo). Patrón a imitar: `apps/web/src/routes/h/[householdId]/contacts/+page.server.ts` (rama real → maqueta) y el `+page.server.ts` del Dashboard de finanzas.

- [ ] **Step 7: la página (KPIs + medias + partidas).** Sustituye `apps/web/src/routes/h/[householdId]/finanzas/analitica/+page.svelte`:

```svelte
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import FinanceFilterBar from '$lib/components/finance/FinanceFilterBar.svelte';
  import { formatCents } from '$lib/finance/format';
  import { buildNatureChartData, monthsInRange, pctOf, perMonth } from '$lib/finance/chart-data';
  import { parseIdList, serializeIdList } from '$lib/finance/pivot-state';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const a = $derived(data.analitica);

  // Partidas excluidas de KPIs y gráfica: ?exev= (CSV), navegación real porque
  // los KPIs se recalculan en el servidor.
  const excludedEventIds = $derived(parseIdList(page.url.searchParams.get('exev')));
  function toggleExcluded(id: string): void {
    const next = excludedEventIds.includes(id)
      ? excludedEventIds.filter((x) => x !== id)
      : [...excludedEventIds, id];
    const url = new URL(page.url);
    const param = serializeIdList(next);
    if (param) url.searchParams.set('exev', param);
    else url.searchParams.delete('exev');
    void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }

  const months = $derived(monthsInRange(a.from, a.to));
  const chartPoints = $derived(buildNatureChartData(a.months, a.analyticsRows));
  const incomeRec = $derived(chartPoints.reduce((s, p) => s + p.ingresosRecCents, 0n));
  const incomeExt = $derived(chartPoints.reduce((s, p) => s + p.ingresosExtCents, 0n));
  const incomeSin = $derived(chartPoints.reduce((s, p) => s + p.ingresosSinCents, 0n));

  const selP = $derived(a.eventsSummary.filter((e) => !excludedEventIds.includes(e.id)));
  const noselP = $derived(a.eventsSummary.filter((e) => excludedEventIds.includes(e.id)));
  const sum = (list: typeof a.eventsSummary, k: 'netCents' | 'incomeCents' | 'expenseCents') =>
    list.reduce((acc, e) => acc + e[k], 0n);
  const pct = (v: number | null) => (v === null ? '—' : `${v} %`);
</script>

<PageHeader eyebrow="Finanzas" title="Analítica" support={`${a.from} → ${a.to}`} />

<FinanceFilterBar />
<!-- ↑ fase 4: copia la instanciación EXACTA (props incluidas) del Dashboard
     apps/web/src/routes/h/[householdId]/finanzas/+page.svelte -->

<section class="kpi-grid" data-testid="kpi-analitica" aria-label="Indicadores del periodo">
  <article class="kpi"><span>Ingresos</span><strong class="cifra pos">{formatCents(a.summary.incomeCents)}</strong>
    <small>♻ {formatCents(incomeRec)} · ✦ {formatCents(incomeExt)} · — {formatCents(incomeSin)}</small></article>
  <article class="kpi"><span>Gastos</span><strong class="cifra neg">{formatCents(a.summary.expenseCents)}</strong>
    <small>♻ {formatCents(a.summary.recurringExpenseCents)} · {pctOf(a.summary.recurringExpenseCents, a.summary.expenseCents)}% gasto · {pctOf(a.summary.recurringExpenseCents, a.summary.incomeCents)}% ingr<br />
      ✦ {formatCents(a.summary.extraordinaryExpenseCents)} · {pctOf(a.summary.extraordinaryExpenseCents, a.summary.expenseCents)}% gasto · {pctOf(a.summary.extraordinaryExpenseCents, a.summary.incomeCents)}% ingr</small></article>
  <article class="kpi"><span>Tasa ahorro bruta</span><strong class="cifra">{pct(a.summary.grossSavingsRate)}</strong>
    <small>{formatCents(a.summary.incomeCents + a.summary.recurringExpenseCents)} · sin extraordinarios ni inversión</small></article>
  <article class="kpi"><span>Tasa ahorro neta</span><strong class="cifra">{pct(a.summary.netSavingsRate)}</strong>
    <small>{formatCents(a.summary.savingsCents)} · gasto total, sin inversión</small></article>
  <article class="kpi"><span>Inversión</span><strong class="cifra pos">{formatCents(a.summary.investedCents)}</strong>
    <small>{pct(a.summary.investmentRate)} sobre ingreso total</small></article>
  <article class="kpi"><span>Free cash flow</span>
    <strong class="cifra {a.summary.freeCashFlowCents >= 0n ? 'pos' : 'neg'}">{formatCents(a.summary.freeCashFlowCents)}</strong>
    <small>{a.summary.freeCashFlowCents >= 0n ? 'caja generada' : 'caja destruida'} · ingresos − gastos − inversión</small></article>
  <article class="kpi"><span>Ops cash flow</span>
    <strong class="cifra {a.summary.opsCashFlowCents >= 0n ? 'pos' : 'neg'}">{formatCents(a.summary.opsCashFlowCents)}</strong>
    <small>free cash flow + inversión (líquida si se necesita)</small></article>
  {#if a.summary.receivedContributionsCents > 0n}
    <article class="kpi"><span>Aportaciones recibidas</span><strong class="cifra pos">{formatCents(a.summary.receivedContributionsCents)}</strong>
      <small>de otras cuentas propias · cuenta como ingreso</small></article>
  {/if}
  {#if a.summary.outgoingTransfersCents < 0n}
    <article class="kpi"><span>Traspasos / ahorro</span><strong class="cifra">{formatCents(a.summary.outgoingTransfersCents)}</strong>
      <small>movido a otras cuentas propias · no es gasto</small></article>
  {/if}
</section>

<p class="media-rotulo">Media mensual · {months} {months === 1 ? 'mes' : 'meses'} completos</p>
<section class="kpi-grid compact" aria-label="Medias mensuales">
  <article class="kpi"><span>Ingresos/mes</span><strong class="cifra pos">{formatCents(perMonth(a.summary.incomeCents, months))}</strong></article>
  <article class="kpi"><span>Gastos/mes</span><strong class="cifra neg">{formatCents(perMonth(a.summary.expenseCents, months))}</strong></article>
  <article class="kpi"><span>Ahorro/mes</span><strong class="cifra {a.summary.savingsCents >= 0n ? 'pos' : 'neg'}">{formatCents(perMonth(a.summary.savingsCents, months))}</strong></article>
  <article class="kpi"><span>Inversión/mes</span><strong class="cifra pos">{formatCents(perMonth(a.summary.investedCents, months))}</strong></article>
  <article class="kpi"><span>Free CF/mes</span><strong class="cifra">{formatCents(perMonth(a.summary.freeCashFlowCents, months))}</strong></article>
  <article class="kpi"><span>Ops CF/mes</span><strong class="cifra">{formatCents(perMonth(a.summary.opsCashFlowCents, months))}</strong></article>
</section>

<section aria-labelledby="partidas-titulo">
  <h2 id="partidas-titulo">Partidas
    {#if excludedEventIds.length > 0}
      <small>{excludedEventIds.length} {excludedEventIds.length === 1 ? 'partida excluida' : 'partidas excluidas'} de los KPIs</small>
    {/if}
  </h2>
  {#if a.eventsSummary.length === 0}
    <p class="vacio">Todavía no hay partidas: créalas desde la tabla del pivot.</p>
  {:else}
    <div class="tabla-scroll">
      <table class="tabla-finanzas" data-testid="partidas-tabla">
        <thead><tr><th>Partida</th><th class="importe">Total</th><th class="importe">Ingresos</th><th class="importe">Gastos</th></tr></thead>
        <tbody>
          {#each a.eventsSummary as ev (ev.id)}
            <tr class:excluida={excludedEventIds.includes(ev.id)}>
              <td><label><input type="checkbox" checked={!excludedEventIds.includes(ev.id)} onchange={() => toggleExcluded(ev.id)} />
                🎉 {ev.name} <small>({ev.txCount})</small></label></td>
              <td class="importe cifra {ev.netCents >= 0n ? 'pos' : 'neg'}">{formatCents(ev.netCents)}</td>
              <td class="importe cifra pos">{formatCents(ev.incomeCents)}</td>
              <td class="importe cifra neg">{formatCents(ev.expenseCents)}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          {#each [
            { label: 'Seleccionado', list: selP, strong: false },
            { label: 'No seleccionado', list: noselP, strong: false },
            { label: 'Total', list: a.eventsSummary, strong: true }
          ] as foot (foot.label)}
            <tr class="subtotal">
              <td>{#if foot.strong}<strong>{foot.label}</strong>{:else}{foot.label}{/if}</td>
              <td class="importe cifra {sum(foot.list, 'netCents') >= 0n ? 'pos' : 'neg'}">{formatCents(sum(foot.list, 'netCents'))}</td>
              <td class="importe cifra pos">{formatCents(sum(foot.list, 'incomeCents'))}</td>
              <td class="importe cifra neg">{formatCents(sum(foot.list, 'expenseCents'))}</td>
            </tr>
          {/each}
        </tfoot>
      </table>
    </div>
  {/if}
</section>

<style>
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: var(--gap-card); margin-top: var(--space-4); }
  .kpi { border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); padding: var(--pad-card); display: grid; gap: var(--space-1); align-content: start; }
  .kpi > span { color: var(--ink-faint); font-size: var(--text-micro); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .kpi > small { color: var(--ink-soft); font-size: var(--text-meta); }
  .kpi-grid.compact .kpi { padding: var(--space-2); }
  .cifra.pos { color: var(--success); }
  .cifra.neg { color: var(--danger); }
  .media-rotulo { color: var(--ink-faint); font-size: var(--text-micro); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; margin-top: var(--space-5); }
  h2 { font-size: var(--text-title); margin-top: var(--space-6); }
  h2 small { color: var(--ink-soft); font-weight: 400; font-size: var(--text-meta); margin-left: var(--space-2); }
  .vacio { color: var(--ink-soft); }
  .tabla-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); margin-top: var(--space-3); }
  .tabla-finanzas { border-collapse: collapse; width: 100%; font-size: var(--text-meta); }
  .tabla-finanzas th, .tabla-finanzas td { padding: var(--space-2) var(--space-3); border-top: 1px solid var(--line); text-align: left; white-space: nowrap; }
  .tabla-finanzas thead th { border-top: 0; color: var(--ink-faint); font-size: var(--text-micro); text-transform: uppercase; letter-spacing: .04em; }
  .tabla-finanzas .importe { text-align: right; font-variant-numeric: tabular-nums lining-nums; }
  .tabla-finanzas tr.excluida { opacity: .5; }
  .tabla-finanzas .subtotal { background: var(--canvas); font-weight: 500; }
</style>
```

- [ ] **Step 8: verde de tipos.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm check && pnpm vitest run tests/finanzas-analitica-demo.test.ts
```

- [ ] **Step 9: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/src/lib/finance/analitica-data.ts apps/web/src/lib/server/finanzas-analitica-demo.server.ts "apps/web/src/routes/h/[householdId]/finanzas/analitica/+page.server.ts" "apps/web/src/routes/h/[householdId]/finanzas/analitica/+page.svelte" apps/web/tests/finanzas-analitica-demo.test.ts
git commit -m "feat(finanzas): Analítica con KPIs ampliados, medias por meses completos y partidas excluibles"
```

---

### Task 9: Analítica — gráfica apilada y resumen mensual transpuesto

**Files:**
- Modify: `apps/web/src/routes/h/[householdId]/finanzas/analitica/+page.svelte`

**Interfaces:**
- Consumes: `NatureStackChart.svelte` (tarea 7); `SUMMARY_ROWS`, `monthLabel`, `perMonth` de `$lib/finance/chart-data`; `formatCents`.
- Produces: secciones «Evolución» y «Resumen mensual» con testid `resumen-mensual`.

- [ ] **Step 1: añade las secciones.** En `+page.svelte`, tras la sección de Partidas, inserta (y añade los imports `NatureStackChart`, `SUMMARY_ROWS`, `monthLabel` arriba):

```svelte
{#if chartPoints.length === 0 || a.pivotRows.length === 0}
  <p class="vacio">No hay movimientos en este periodo.</p>
{:else}
  <section aria-labelledby="evolucion-titulo">
    <h2 id="evolucion-titulo">Evolución</h2>
    <div class="tarjeta"><NatureStackChart points={chartPoints} /></div>
  </section>

  <section aria-labelledby="resumen-titulo">
    <h2 id="resumen-titulo">Resumen mensual <small>media sobre {months} {months === 1 ? 'mes completo' : 'meses completos'}</small></h2>
    <div class="tabla-scroll">
      <table class="tabla-finanzas" data-testid="resumen-mensual">
        <thead>
          <tr>
            <th>Concepto</th>
            {#each chartPoints as p (p.month)}<th class="importe">{monthLabel(p.month)}</th>{/each}
            <th class="importe">Acumulado</th>
            <th class="importe">Media/mes</th>
          </tr>
        </thead>
        <tbody>
          {#each SUMMARY_ROWS as row (row.label)}
            {@const total = chartPoints.reduce((acc, p) => acc + row.value(p), 0n)}
            <tr class:destacada={row.strong} class:separada={row.sep}>
              <td>{row.label}</td>
              {#each chartPoints as p (p.month)}
                <td class="importe cifra {row.cls}">{formatCents(row.value(p))}</td>
              {/each}
              <td class="importe cifra {row.cls}"><strong>{formatCents(total)}</strong></td>
              <td class="importe cifra {row.cls}"><strong>{formatCents(perMonth(total, months))}</strong></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}
```

Y en el `<style>` de la página añade:

```css
  .tarjeta { border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); padding: var(--pad-card); margin-top: var(--space-3); }
  .tabla-finanzas tr.destacada { background: var(--canvas); font-weight: 700; }
  .tabla-finanzas tr.separada td { border-top: 2px solid var(--line-strong); }
  .cifra.pos { color: var(--success); }
  .cifra.neg { color: var(--danger); }
```

- [ ] **Step 2: verde de tipos y tokens.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm check
```

- [ ] **Step 3: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add "apps/web/src/routes/h/[householdId]/finanzas/analitica/+page.svelte"
git commit -m "feat(finanzas): evolución apilada y resumen mensual transpuesto en Analítica"
```

---

### Task 10: `PivotTable.svelte` — lectura: secciones, bandas, árbol, tinte, orden y dims

**Files:**
- Create: `apps/web/src/lib/components/finance/PivotTable.svelte`
- Modify: `apps/web/src/routes/h/[householdId]/finanzas/analitica/+page.svelte` (integración + filtro de naturaleza)

**Interfaces:**
- Consumes: `buildPivotTree` y `INTERNA_DIMS`/`INVERSION_DIMS` de `@casa-clara/domain` (fase 2); todo `$lib/finance/pivot-state`; `formatCents`; `monthLabel`; tipos de `$lib/finance/analitica-data`.
- Produces: componente `PivotTable` con props `{ rows, months, categories, events, invAccounts, householdId, onOpenIds }` y testids `pivot-table`, `pivot-banda-*`, `pivot-total-neto`.

**⚠ Step 1 obligatorio (alineación con el dominio, fase 2):** abre `packages/domain/src/finance/pivot.ts` y anota: (a) la firma real de `buildPivotTree(rows, dims, opts)` — qué lleva `opts` (este plan asume `{ months: string[]; dupEventIds?: ReadonlySet<string> }`); (b) la forma del árbol devuelto — este plan asume el port fiel del original: `{ gastos, ingresos, internas, inversiones, eventos, subtotales }` con nodos `{ key, label, depth, count, totalCents, avgCents, ticketCents, monthly, catId, nat, provider, concept, movs, children }` y eventos `{ eventId, name, count, netCents, avgCents, ticketCents, monthly, children }`; (c) si exporta `INTERNA_DIMS`/`INVERSION_DIMS`. Cualquier diferencia de nombre se resuelve A FAVOR del dominio en el código de abajo (y en `PivotNodeLike` de pivot-state si afecta a propiedades).

- [ ] **Step 2: implementación.** Crea `apps/web/src/lib/components/finance/PivotTable.svelte`:

```svelte
<script lang="ts">
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { buildPivotTree, INTERNA_DIMS, INVERSION_DIMS, type PivotDimension } from '@casa-clara/domain';
  import { monthLabel } from '$lib/finance/chart-data';
  import { formatCents } from '$lib/finance/format';
  import {
    addDim, ALL_DIMS, DIM_LABELS, dimsToParam, moveDim, parseChips, parseDims, parseIdList,
    removeDim, sameSortKey, serializeIdList, sortTree, rowMatchesChips,
    type PivotNodeLike, type PivotSortKey, type SortDir
  } from '$lib/finance/pivot-state';
  import { categoryPathOf, type AnaliticaCategory, type AnaliticaEventSummary, type AnaliticaPivotRow } from '$lib/finance/analitica-data';

  let {
    rows, months, categories, events, invAccounts, householdId, onOpenIds
  }: {
    rows: AnaliticaPivotRow[];
    months: string[];
    categories: AnaliticaCategory[];
    events: AnaliticaEventSummary[];
    invAccounts: { id: string; name: string }[];
    householdId: string;
    onOpenIds: (ids: string[], label: string, sub: string) => void;
  } = $props();

  const catPathOf = (id: string) => categoryPathOf(categories, id);

  // dims y dupev viven en la URL (merge no destructivo) con routing superficial:
  // no cambian los datos del servidor, solo la agrupación cliente.
  const dims = $derived(parseDims(page.url.searchParams.get('dims')));
  const chips = $derived(parseChips(page.url.searchParams.get('q')));
  const dupEventIds = $derived(parseIdList(page.url.searchParams.get('dupev')));

  function setShallowParam(key: string, value: string): void {
    const url = new URL(page.url);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    replaceState(url, {});
  }
  const setDims = (next: PivotDimension[]) => setShallowParam('dims', dimsToParam(next));
  const toggleDupEvent = (id: string) => {
    const next = dupEventIds.includes(id) ? dupEventIds.filter((x) => x !== id) : [...dupEventIds, id];
    setShallowParam('dupev', serializeIdList(next));
  };

  let expanded = $state<Set<string>>(new Set());
  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  };

  let sort = $state<{ key: PivotSortKey; dir: SortDir }>({ key: 'total', dir: 'asc' });
  const toggleSort = (key: PivotSortKey) => {
    sort = sameSortKey(sort.key, key) ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
  };
  const sortIndicator = (key: PivotSortKey) => (sameSortKey(sort.key, key) ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  const hasSearch = $derived(chips.length > 0);
  const forceExpand = $derived(hasSearch);
  const filteredRows = $derived(rows.filter((r) => rowMatchesChips(r, chips, catPathOf)));

  // Árbol del dominio (fase 2); dupev duplica eventos bajo su categoría sin
  // alterar el TOTAL NETO (invariante del dominio, testeada allí).
  const tree = $derived(buildPivotTree(filteredRows, dims, { months, dupEventIds: new Set(dupEventIds) }));

  // Gastos: ascendente = mayor gasto primero. Ingresos/eventos: dirección
  // contraria salvo por etiqueta, que ordena igual en las tres secciones.
  const oppositeDir = $derived<SortDir>(sort.dir === 'asc' ? 'desc' : 'asc');
  const ingresosDir = $derived(sort.key === 'label' ? sort.dir : oppositeDir);
  const gastoTree = $derived(sortTree(tree.gastos as PivotNodeLike[], sort.key, sort.dir));
  const ingresoTree = $derived(sortTree(tree.ingresos as PivotNodeLike[], sort.key, ingresosDir));
  const internaTree = $derived(tree.internas as PivotNodeLike[]);
  const inversionTree = $derived(tree.inversiones as PivotNodeLike[]);
  const eventTree = $derived(
    [...tree.eventos]
      .map((e) => ({ ...e, children: sortTree(e.children as PivotNodeLike[], sort.key, ingresosDir) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  );
  // Eventos sin movimientos en el periodo: fila vacía, sigue siendo drop target.
  const displayEventos = $derived(
    hasSearch
      ? eventTree
      : [
          ...eventTree,
          ...events
            .filter((e) => !eventTree.some((t) => t.eventId === e.id))
            .map((e) => ({ eventId: e.id, name: e.name, count: 0, netCents: 0n, avgCents: 0n, ticketCents: 0n, monthly: {}, children: [] as PivotNodeLike[] }))
        ].sort((a, b) => a.name.localeCompare(b.name, 'es'))
  );

  const colSpan = $derived(4 + months.length);
  const isEmpty = $derived(hasSearch && gastoTree.length === 0 && ingresoTree.length === 0 && displayEventos.length === 0 && internaTree.length === 0 && inversionTree.length === 0);
  const cellText = (v: bigint | undefined) => (!v ? '·' : formatCents(v));
  const tintFor = (depth: number) =>
    depth === 0 ? '' : `background: color-mix(in srgb, var(--surface) ${100 - Math.min(depth, 4) * 7}%, var(--line-strong));`;
  const openLeaf = (node: PivotNodeLike) =>
    onOpenIds(node.movs.map((m) => m.id), node.label, `${node.movs.length} ${node.movs.length === 1 ? 'movimiento' : 'movimientos'}`);
</script>

{#snippet subtotalRow(label: string, data: { count: number; totalCents: bigint; avgCents: bigint; ticketCents: bigint; monthly: Record<string, bigint> }, tone: '' | 'ok' | 'warn', tooltip: string)}
  <tr class="subtotal" class:aviso={tone === 'warn'} title={tooltip || undefined}>
    <td class="arbol" class:ok={tone === 'ok'}>{label}{tone === 'warn' ? ' ⚠' : ''}{hasSearch ? ' (filtrado)' : ''} <small>({data.count})</small></td>
    <td class="importe cifra">{cellText(data.totalCents)}</td>
    <td class="importe cifra">{cellText(data.avgCents)}</td>
    <td class="importe cifra">{cellText(data.ticketCents)}</td>
    {#each months as m (m)}<td class="importe cifra">{cellText(data.monthly[m])}</td>{/each}
  </tr>
{/snippet}

{#snippet nodeRow(node: PivotNodeLike, kind: 'gasto' | 'ingreso' | 'evento' | 'transferencia' | 'inversion', nodeDims: PivotDimension[])}
  {@const isExpanded = forceExpand || expanded.has(node.key)}
  {@const hasChildren = node.children.length > 0}
  {@const canOpen = !hasChildren && node.movs.length > 0}
  {@const natClass = (kind === 'gasto' || kind === 'ingreso') && nodeDims[node.depth] === 'nat'
    ? node.nat === 'recurrente' ? (kind === 'gasto' ? 'neg' : 'pos') : node.nat === 'extraordinario' ? 'suave' : ''
    : ''}
  <tr style={tintFor(node.depth)} class:clicable={hasChildren} onclick={() => hasChildren && toggle(node.key)}>
    <td class="arbol" style={`padding-left: calc(var(--space-3) + ${node.depth} * var(--space-4));`}>
      <span class="flecha" aria-hidden="true">{hasChildren ? (isExpanded ? '▾' : '▸') : ''}</span>
      {#if canOpen}
        <button type="button" class="abrir" title="abrir ficha"
          onclick={(e) => { e.stopPropagation(); openLeaf(node); }}>{node.label}</button>
      {:else}
        <span class={natClass}>{node.label}</span>
      {/if}
      <small>({node.count})</small>
    </td>
    <td class="importe cifra {natClass}">{cellText(node.totalCents)}</td>
    <td class="importe cifra {natClass}">{cellText(node.avgCents)}</td>
    <td class="importe cifra {natClass}">{cellText(node.ticketCents)}</td>
    {#each months as m (m)}<td class="importe cifra {natClass}">{cellText(node.monthly[m])}</td>{/each}
  </tr>
  {#if isExpanded}
    {#each node.children as child (child.key)}
      {@render nodeRow(child, kind, nodeDims)}
    {/each}
  {/if}
{/snippet}

<div class="pivot-controles">
  <div class="dims" role="group" aria-label="Dimensiones del pivot">
    {#each dims as d, i (d)}
      <span class="chip activa">
        <button type="button" disabled={i === 0} aria-label={`mover ${DIM_LABELS[d]} antes`} onclick={() => setDims(moveDim(dims, i, -1))}>◀</button>
        {DIM_LABELS[d]}
        <button type="button" disabled={i === dims.length - 1} aria-label={`mover ${DIM_LABELS[d]} después`} onclick={() => setDims(moveDim(dims, i, 1))}>▶</button>
        <button type="button" disabled={dims.length <= 1} aria-label={`quitar ${DIM_LABELS[d]}`} onclick={() => setDims(removeDim(dims, d))}>×</button>
      </span>
    {/each}
    {#each ALL_DIMS.filter((d) => !dims.includes(d)) as d (d)}
      <button type="button" class="chip" onclick={() => setDims(addDim(dims, d))}>{DIM_LABELS[d]}</button>
    {/each}
  </div>
</div>

{#if isEmpty}
  <p class="vacio">Sin resultados que coincidan con la búsqueda.</p>
{:else}
  <div class="pivot-scroll">
    <table class="pivot" data-testid="pivot-table">
      <thead>
        <tr>
          <th class="arbol"><button type="button" onclick={() => toggleSort('label')}>{dims.map((d) => DIM_LABELS[d]).join(' / ')}{sortIndicator('label')}</button></th>
          <th class="importe"><button type="button" onclick={() => toggleSort('total')}>Acumulado{sortIndicator('total')}</button></th>
          <th class="importe"><button type="button" onclick={() => toggleSort('avg')}>Promedio{sortIndicator('avg')}</button></th>
          <th class="importe"><button type="button" onclick={() => toggleSort('ticket')}>Ticket{sortIndicator('ticket')}</button></th>
          {#each months as m (m)}
            <th class="importe"><button type="button" onclick={() => toggleSort({ month: m })}>{monthLabel(m)}{sortIndicator({ month: m })}</button></th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#if ingresoTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-ingresos"><td colspan={colSpan}>INGRESOS</td></tr>
          {#each ingresoTree as node (node.key)}{@render nodeRow(node, 'ingreso', dims)}{/each}
          {@render subtotalRow('Subtotal ingresos', tree.subtotales.ingresos, '', '')}
        {/if}
        {#if gastoTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-gastos"><td colspan={colSpan}>GASTOS</td></tr>
          {#each gastoTree as node (node.key)}{@render nodeRow(node, 'gasto', dims)}{/each}
          {@render subtotalRow('Subtotal gastos', tree.subtotales.gastos, '', '')}
        {/if}
        <tr class="banda" data-testid="pivot-banda-eventos"><td colspan={colSpan}>EVENTOS</td></tr>
        {#each displayEventos as event (event.eventId)}
          {@const key = `event/${event.eventId}`}
          {@const evExpanded = forceExpand || expanded.has(key)}
          <tr class="clicable" onclick={() => event.children.length > 0 && toggle(key)}>
            <td class="arbol">
              <span class="flecha" aria-hidden="true">{event.children.length > 0 ? (evExpanded ? '▾' : '▸') : ''}</span>
              <input type="checkbox" checked={dupEventIds.includes(event.eventId)} disabled={event.children.length === 0}
                title="Ver los movimientos de este evento también dentro de sus categorías en GASTOS/INGRESOS"
                onclick={(e) => e.stopPropagation()} onchange={() => toggleDupEvent(event.eventId)} />
              🎉 {event.name} <small>({event.count})</small>
            </td>
            <td class="importe cifra">{cellText(event.netCents)}</td>
            <td class="importe cifra">{cellText(event.avgCents)}</td>
            <td class="importe cifra">{cellText(event.ticketCents)}</td>
            {#each months as m (m)}<td class="importe cifra">{cellText(event.monthly[m])}</td>{/each}
          </tr>
          {#if evExpanded}
            {#each event.children as child (child.key)}{@render nodeRow(child, 'evento', dims)}{/each}
          {/if}
        {/each}
        {#if displayEventos.length > 0}
          {@render subtotalRow('Subtotal eventos', tree.subtotales.eventos, '', '')}
        {/if}
        {#if internaTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-internas"><td colspan={colSpan}>INTERNAS</td></tr>
          {#each internaTree as node (node.key)}{@render nodeRow(node, 'transferencia', INTERNA_DIMS)}{/each}
          {@render subtotalRow('Subtotal internas', tree.subtotales.internas,
            tree.subtotales.internas.totalCents === 0n ? 'ok' : 'warn',
            tree.subtotales.internas.totalCents === 0n ? '' : 'Con todas las cuentas seleccionadas debe sumar 0: un valor distinto indica una pata fuera del filtro de cuentas o un descuadre real.')}
        {/if}
        {#if inversionTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-inversion"><td colspan={colSpan}>INVERSIÓN</td></tr>
          {#each inversionTree as node (node.key)}{@render nodeRow(node, 'inversion', INVERSION_DIMS)}{/each}
          {@render subtotalRow('Subtotal inversión', tree.subtotales.inversiones, '', '')}
        {/if}
        {#if gastoTree.length > 0 || ingresoTree.length > 0 || displayEventos.length > 0}
          <tr data-testid="pivot-total-neto" class="oculta-fila"></tr>
          {@render subtotalRow('TOTAL NETO', tree.subtotales.totalNeto, '', '')}
        {/if}
      </tbody>
    </table>
  </div>
  {#if hasSearch}
    <p class="nota">los KPIs muestran el total del periodo</p>
  {/if}
{/if}

<style>
  .pivot-controles { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: flex-start; margin-bottom: var(--space-2); }
  .dims { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .chip { border: 1px solid var(--line); border-radius: var(--r-full); background: var(--surface); padding: var(--space-1) var(--space-2); font-size: var(--text-meta); }
  .chip.activa { border-color: var(--primary); background: var(--primary-soft); font-weight: 700; }
  .chip button { border: 0; background: transparent; cursor: pointer; padding: 0 var(--space-1); }
  .chip button:disabled { opacity: .35; cursor: default; }
  .pivot-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); }
  table.pivot { border-collapse: collapse; width: 100%; font-size: var(--text-meta); }
  .pivot th, .pivot td { padding: var(--space-1) var(--space-2); border-top: 1px solid var(--line); text-align: left; white-space: nowrap; }
  .pivot thead th { border-top: 0; }
  .pivot thead button { border: 0; background: transparent; cursor: pointer; font: inherit; color: var(--ink-faint); font-size: var(--text-micro); text-transform: uppercase; letter-spacing: .04em; padding: 0; }
  .pivot .importe { text-align: right; font-variant-numeric: tabular-nums lining-nums; }
  .pivot .arbol { position: sticky; left: 0; background: inherit; }
  .pivot tr { background: var(--surface); }
  .pivot tr.clicable { cursor: pointer; }
  .flecha { display: inline-block; width: var(--space-4); color: var(--ink-faint); }
  .abrir { border: 0; background: transparent; cursor: pointer; font: inherit; padding: 0; text-decoration: underline dotted; }
  .banda td { background: var(--canvas-deep); font-weight: 700; font-size: var(--text-micro); letter-spacing: .06em; }
  .subtotal { background: var(--canvas); font-weight: 500; }
  .subtotal .ok { color: var(--success); }
  .subtotal.aviso { background: var(--danger-soft); color: var(--danger); }
  .pos { color: var(--success); }
  .neg { color: var(--danger); }
  .suave { color: var(--ink-soft); }
  .oculta-fila { display: none; }
  .vacio, .nota { color: var(--ink-soft); font-size: var(--text-meta); margin-top: var(--space-2); }
  small { color: var(--ink-faint); }
</style>
```

- [ ] **Step 3: integra en la página.** En `apps/web/src/routes/h/[householdId]/finanzas/analitica/+page.svelte`, dentro del bloque `{:else}` de la tarea 9, tras «Resumen mensual», añade (con los imports de `PivotTable` y `FinanceDetailPanel` arriba, y el filtro de naturaleza):

```svelte
  <section aria-labelledby="pivot-titulo">
    <h2 id="pivot-titulo">Categorías</h2>
    <div class="chips-naturaleza" role="group" aria-label="Filtrar por naturaleza">
      <button type="button" class="chip" class:activa={recurrence === null} onclick={() => (recurrence = null)}>Todos</button>
      <button type="button" class="chip" class:activa={recurrence === 'recurrente'} onclick={() => (recurrence = 'recurrente')}>♻ Recurrente</button>
      <button type="button" class="chip" class:activa={recurrence === 'extraordinario'} onclick={() => (recurrence = 'extraordinario')}>✦ Extraordinario</button>
    </div>
    <PivotTable
      rows={pivotRows}
      months={a.months}
      categories={a.categories}
      events={a.eventsSummary}
      invAccounts={a.invAccounts}
      householdId={page.params.householdId ?? ''}
      onOpenIds={(ids, label, sub) => (panel = { ids, label, sub })}
    />
  </section>

  {#if panel}
    <FinanceDetailPanel />
    <!-- ↑ fase 4: copia la instanciación EXACTA (props: ids/label/sub/onClose o
         las que use Movimientos en apps/web/src/routes/h/[householdId]/finanzas/movimientos/+page.svelte)
         y pásale panel.ids, panel.label, panel.sub y onClose={() => (panel = null)} -->
  {/if}
```

Y en el `<script>` de la página añade:

```ts
  import PivotTable from '$lib/components/finance/PivotTable.svelte';
  import FinanceDetailPanel from '$lib/components/finance/FinanceDetailPanel.svelte';

  let recurrence = $state<'recurrente' | 'extraordinario' | null>(null);
  let panel = $state<{ ids: string[]; label: string; sub: string } | null>(null);
  const pivotRows = $derived(a.pivotRows.filter((r) => !recurrence || r.nat === recurrence));
```

más la clase `.chips-naturaleza { display: flex; gap: var(--space-2); margin: var(--space-2) 0; }` y las reglas `.chip`/`.chip.activa` iguales a las del PivotTable en el `<style>` de la página.

- [ ] **Step 4: verde de tipos y tokens.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm check
```

Salida esperada: 0 errores. Si svelte-check señala nombres del árbol del dominio distintos a los asumidos (Step 1), corrige los accesos según el dominio.

- [ ] **Step 5: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/src/lib/components/finance/PivotTable.svelte "apps/web/src/routes/h/[householdId]/finanzas/analitica/+page.svelte"
git commit -m "feat(finanzas): PivotTable de lectura con bandas, árbol expandible, orden y dims en URL"
```

---

### Task 11: `PivotSearch.svelte` — buscador con chips y atajo «/»

**Files:**
- Create: `apps/web/src/lib/components/finance/PivotSearch.svelte`
- Modify: `apps/web/src/lib/components/finance/PivotTable.svelte` (integración)

**Interfaces:**
- Consumes: `suggestChips`, `parseChips`, `serializeChips`, `type SearchChip`, `type SuggestGroup` de `$lib/finance/pivot-state`.
- Produces: componente con props `{ rows, catPathOf, chips, onChips }`; input con `aria-label="Buscar"` y placeholder que anuncia el atajo `/`.

- [ ] **Step 1: implementación.** Crea `apps/web/src/lib/components/finance/PivotSearch.svelte`:

```svelte
<script lang="ts">
  import { suggestChips, type SearchChip, type SuggestGroup } from '$lib/finance/pivot-state';
  import type { AnaliticaPivotRow } from '$lib/finance/analitica-data';

  const MAX_PER_GROUP = 5;
  const DEBOUNCE_MS = 150;
  const TYPE_LABEL: Record<SearchChip['type'], string> = {
    prov: 'Proveedor', concept: 'Concepto', event: 'Evento', cat: 'Categoría', free: 'Texto'
  };

  let { rows, catPathOf, chips, onChips }: {
    rows: AnaliticaPivotRow[];
    catPathOf: (id: string) => string;
    chips: SearchChip[];
    onChips: (next: SearchChip[]) => void;
  } = $props();

  let input = $state<HTMLInputElement | null>(null);
  let query = $state('');
  let debounced = $state('');
  let open = $state(false);
  let expandedGroups = $state<Set<string>>(new Set());

  $effect(() => {
    const value = query;
    const t = setTimeout(() => (debounced = value), DEBOUNCE_MS);
    return () => clearTimeout(t);
  });

  const groups = $derived<SuggestGroup[]>(debounced.trim().length >= 2 ? suggestChips(rows, catPathOf, debounced) : []);
  const showDropdown = $derived(open && debounced.trim().length >= 2);

  function addChip(chip: SearchChip): void {
    onChips([...chips, chip]);
    query = '';
    debounced = '';
    open = false;
  }
  const removeChip = (idx: number) => onChips(chips.filter((_, i) => i !== idx));

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (query.trim()) addChip({ type: 'free', value: query.trim() });
    } else if (e.key === 'Escape') {
      if (showDropdown) open = false;
      else if (chips.length > 0) removeChip(chips.length - 1);
    }
  }

  // Atajo global «/»: enfoca el buscador salvo que el foco esté en otro campo.
  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.key !== '/') return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    e.preventDefault();
    input?.focus();
    open = true;
  }
  const chipDisplay = (chip: SearchChip) =>
    chip.type === 'cat' ? catPathOf(chip.value) : chip.type === 'concept' && chip.prov ? `${chip.value} (${chip.prov})` : chip.value;
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="buscador">
  <input bind:this={input} type="text" aria-label="Buscar"
    placeholder="Buscar proveedor, concepto, evento o categoría…  /"
    value={query} oninput={(e) => { query = e.currentTarget.value; open = true; }}
    onfocus={() => (open = true)} onkeydown={onKeydown} />

  {#if showDropdown}
    <div class="desplegable" role="listbox" aria-label="Sugerencias">
      {#if groups.length === 0}
        <p class="sin-resultados">Sin resultados para «{debounced}»</p>
      {:else}
        {#each groups as g (g.group)}
          {@const cap = expandedGroups.has(g.group) ? g.items.length : MAX_PER_GROUP}
          <p class="grupo">{g.group}</p>
          {#each g.items.slice(0, cap) as item (item.chip.type + item.chip.value)}
            <button type="button" class="sugerencia" onmousedown={(e) => e.preventDefault()} onclick={() => addChip(item.chip)}>
              <span>{item.label}</span><small>{item.detail}</small>
            </button>
          {/each}
          {#if g.items.length > cap}
            <button type="button" class="mas" onmousedown={(e) => e.preventDefault()}
              onclick={() => (expandedGroups = new Set(expandedGroups).add(g.group))}>{g.items.length - cap} más…</button>
          {/if}
        {/each}
      {/if}
    </div>
  {/if}

  {#if chips.length > 0}
    <div class="chips">
      {#each chips as chip, i (i)}
        <span class="chip activa">🔍 {TYPE_LABEL[chip.type]}: {chipDisplay(chip)}
          <button type="button" aria-label="quitar filtro" onclick={() => removeChip(i)}>×</button></span>
      {/each}
      <button type="button" class="limpiar" onclick={() => onChips([])}>limpiar</button>
    </div>
  {/if}
</div>

<style>
  .buscador { position: relative; flex: 1 1 14rem; max-width: 24rem; }
  input { width: 100%; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); padding: var(--space-2); font-size: max(1em, 1rem); }
  .desplegable { position: absolute; z-index: 30; inset-inline: 0; top: 100%; background: var(--surface-strong); border: 1px solid var(--line-strong); border-radius: var(--r-md); box-shadow: var(--shadow-over); padding: var(--space-2); max-height: 18rem; overflow-y: auto; }
  .grupo { color: var(--ink-faint); font-size: var(--text-micro); text-transform: uppercase; letter-spacing: .04em; margin: var(--space-2) 0 var(--space-1); }
  .sugerencia, .mas { display: flex; justify-content: space-between; gap: var(--space-2); width: 100%; border: 0; background: transparent; cursor: pointer; text-align: left; padding: var(--space-1) var(--space-2); border-radius: var(--r-sm); font-size: var(--text-meta); }
  .sugerencia:hover, .sugerencia:focus-visible, .mas:hover { background: var(--primary-pale); }
  .sugerencia small { color: var(--ink-soft); }
  .sin-resultados { color: var(--ink-soft); font-size: var(--text-meta); padding: var(--space-2); }
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }
  .chip { border: 1px solid var(--primary); border-radius: var(--r-full); background: var(--primary-soft); padding: var(--space-1) var(--space-2); font-size: var(--text-meta); font-weight: 700; }
  .chip button { border: 0; background: transparent; cursor: pointer; padding: 0 var(--space-1); }
  .limpiar { border: 0; background: transparent; cursor: pointer; color: var(--ink-soft); font-size: var(--text-meta); text-decoration: underline; }
</style>
```

- [ ] **Step 2: integra en PivotTable.** En `PivotTable.svelte`: importa `PivotSearch from './PivotSearch.svelte'` y `serializeChips` desde pivot-state; dentro de `.pivot-controles`, ANTES del `<div class="dims">`, añade:

```svelte
  <PivotSearch rows={filteredRows.length ? filteredRows : rows} {catPathOf} {chips}
    onChips={(next) => setShallowParam('q', serializeChips(next))} />
```

En el `{#if isEmpty}` añade el botón de limpiar búsqueda:

```svelte
  <p class="vacio">Sin resultados que coincidan con la búsqueda.
    <button type="button" class="limpiar" onclick={() => setShallowParam('q', '')}>limpiar búsqueda</button></p>
```

(y la clase `.limpiar` igual que en PivotSearch en el `<style>` de PivotTable).

- [ ] **Step 3: verde.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm check
```

- [ ] **Step 4: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/src/lib/components/finance/PivotSearch.svelte apps/web/src/lib/components/finance/PivotTable.svelte
git commit -m "feat(finanzas): buscador del pivot con chips tipados y atajo «/»"
```

---

### Task 12: Selección con Shift + `PivotActionBar.svelte` + toast con Deshacer

**Files:**
- Create: `apps/web/src/lib/components/finance/PivotActionBar.svelte`
- Modify: `apps/web/src/lib/components/finance/PivotTable.svelte`

**Interfaces:**
- Consumes: helpers de selección de `$lib/finance/pivot-state` (tarea 3); `sendFinanceCommand` y constructores de `$lib/finance/pivot-actions` (tarea 6); `invalidateAll` de `$app/navigation`.
- Produces: `PivotActionBar` con props `{ concepts, movs, events, categories, invAccounts, categoryOnlySelection, onMoveToEvent, onNewEvent, onMoveToCategory, onSetRecurrence, onInvest, onOpenPanel, onClear }`; toast `.pivot-toast` con botón «Deshacer» en PivotTable.

- [ ] **Step 1: la barra.** Crea `apps/web/src/lib/components/finance/PivotActionBar.svelte` (menús con `<details>`, nativos y accesibles; alternativa táctil/teclado completa al dnd):

```svelte
<script lang="ts">
  import type { AnaliticaCategory, AnaliticaEventSummary } from '$lib/finance/analitica-data';

  let {
    concepts, movs, events, categories, invAccounts, categoryOnlySelection = false,
    onMoveToEvent, onNewEvent, onMoveToCategory, onSetRecurrence, onInvest, onOpenPanel, onClear
  }: {
    concepts: number;
    movs: number;
    events: AnaliticaEventSummary[];
    categories: AnaliticaCategory[];
    invAccounts: { id: string; name: string }[];
    categoryOnlySelection?: boolean;
    onMoveToEvent: (eventId: string) => void;
    onNewEvent: (name: string) => void;
    onMoveToCategory: (categoryId: string) => void;
    onSetRecurrence: (r: 'recurrente' | 'extraordinario') => void;
    onInvest: (accountId: string) => void;
    onOpenPanel: () => void;
    onClear: () => void;
  } = $props();

  let newEventName = $state('');
  const parents = $derived(categories.filter((c) => c.parentId === null && c.kind !== 'transferencia'));
  function pick(details: HTMLDetailsElement | null, fn: () => void): void {
    if (details) details.open = false;
    fn();
  }
</script>

<div class="barra" role="toolbar" aria-label="Acciones sobre la selección" data-testid="pivot-actionbar">
  <span class="cifra resumen">{concepts} concepto{concepts === 1 ? '' : 's'} · {movs} mov{movs === 1 ? '' : 's'}</span>

  <details>
    <summary>Mover a evento ▾</summary>
    <div class="menu">
      {#each events as e (e.id)}
        <button type="button" onclick={(ev) => pick(ev.currentTarget.closest('details'), () => onMoveToEvent(e.id))}>{e.name}</button>
      {/each}
      {#if events.length === 0}<p class="vacio">Sin eventos aún</p>{/if}
      <form onsubmit={(ev) => { ev.preventDefault(); if (newEventName.trim()) { onNewEvent(newEventName.trim()); newEventName = ''; } }}>
        <input type="text" placeholder="+ Nuevo evento…" bind:value={newEventName} aria-label="Nombre del evento nuevo" />
        <button type="submit">+</button>
      </form>
    </div>
  </details>

  <details>
    <summary title={categoryOnlySelection ? 'Las categorías no pueden soltarse sobre otra categoría' : undefined}>Mover a categoría ▾</summary>
    {#if !categoryOnlySelection}
      <div class="menu alto">
        {#each parents as p (p.id)}
          <button type="button" class="padre" onclick={(ev) => pick(ev.currentTarget.closest('details'), () => onMoveToCategory(p.id))}>{p.name}</button>
          {#each categories.filter((c) => c.parentId === p.id) as c (c.id)}
            <button type="button" class="hija" onclick={(ev) => pick(ev.currentTarget.closest('details'), () => onMoveToCategory(c.id))}>{c.name}</button>
          {/each}
        {/each}
      </div>
    {:else}
      <div class="menu"><p class="vacio">Las categorías no pueden soltarse sobre otra categoría</p></div>
    {/if}
  </details>

  <details>
    <summary>Naturaleza ▾</summary>
    <div class="menu">
      <button type="button" onclick={(ev) => pick(ev.currentTarget.closest('details'), () => onSetRecurrence('recurrente'))}>♻ Recurrente</button>
      <button type="button" onclick={(ev) => pick(ev.currentTarget.closest('details'), () => onSetRecurrence('extraordinario'))}>✦ Extraordinario</button>
    </div>
  </details>

  <details>
    <summary title="Marcar los cargos seleccionados como aportación a inversión (cuentan como ahorro)">▲ Inversión ▾</summary>
    <div class="menu">
      {#if invAccounts.length === 0}<p class="vacio">Crea una cuenta de inversión en Ajustes.</p>{/if}
      {#each invAccounts as acc (acc.id)}
        <button type="button" onclick={(ev) => pick(ev.currentTarget.closest('details'), () => onInvest(acc.id))}>{acc.name}</button>
      {/each}
    </div>
  </details>

  <button type="button" class="plana" onclick={onOpenPanel}>Abrir panel</button>
  <button type="button" class="plana" aria-label="limpiar selección" onclick={onClear}>×</button>
</div>

<style>
  .barra { position: fixed; z-index: 40; inset-inline: 0; bottom: calc(var(--bottom-nav-h) + var(--space-3)); margin-inline: auto; width: fit-content; max-width: calc(100% - var(--space-6)); display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; background: var(--surface-strong); border: 1px solid var(--line-strong); border-radius: var(--r-lg); box-shadow: var(--shadow-over); padding: var(--space-2) var(--space-3); }
  .resumen { font-size: var(--text-meta); font-variant-numeric: tabular-nums; }
  details { position: relative; }
  summary { list-style: none; cursor: pointer; border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--space-1) var(--space-2); font-size: var(--text-meta); background: var(--surface); }
  summary::-webkit-details-marker { display: none; }
  .menu { position: absolute; z-index: 41; bottom: calc(100% + var(--space-1)); left: 0; min-width: 14rem; background: var(--surface-strong); border: 1px solid var(--line-strong); border-radius: var(--r-md); box-shadow: var(--shadow-over); padding: var(--space-2); display: grid; gap: var(--space-1); }
  .menu.alto { max-height: 16rem; overflow-y: auto; }
  .menu button { border: 0; background: transparent; cursor: pointer; text-align: left; padding: var(--space-1) var(--space-2); border-radius: var(--r-sm); font-size: var(--text-meta); }
  .menu button:hover, .menu button:focus-visible { background: var(--primary-pale); }
  .menu .padre { font-weight: 700; }
  .menu .hija { padding-left: var(--space-4); }
  .menu form { display: flex; gap: var(--space-1); margin-top: var(--space-1); }
  .menu input { flex: 1; border: 1px solid var(--line); border-radius: var(--r-sm); padding: var(--space-1); font-size: max(1em, 1rem); }
  .plana { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); cursor: pointer; padding: var(--space-1) var(--space-2); font-size: var(--text-meta); }
  .vacio { color: var(--ink-soft); font-size: var(--text-meta); padding: var(--space-1); }
</style>
```

- [ ] **Step 2: selección y acciones en PivotTable.** En `PivotTable.svelte`:

(a) añade imports:

```ts
  import { invalidateAll } from '$app/navigation';
  import PivotActionBar from './PivotActionBar.svelte';
  import {
    collectNodeMovIds, resolveSelectionIds, rangeBetween, selectableListAny, toAnySelectable,
    toggleInMap, toMovementSelectable, summarizeEventDrop, summarizeCategoryDrop,
    type SelectableItem
  } from '$lib/finance/pivot-state';
  import {
    assignConceptRecurrence, assignConceptToCategory, assignConceptToEvent, buildTxCategoryIndex,
    bulkByIds, conceptTargetOf, createEventPayload, investTransaction, planCategoryUndo,
    sendFinanceCommand, undoEventAssign, type CategoryUndo
  } from '$lib/finance/pivot-actions';
```

(b) añade estado y helpers al final del `<script>`:

```ts
  // ── Selección (Map inmutable + rango con Shift) ────────────────────────────
  let selected = $state<Map<string, SelectableItem>>(new Map());
  let lastKey = $state<string | null>(null);
  const selectionList = $derived([...selected.values()]);
  const selectionMovs = $derived(selectionList.reduce((s, i) => s + i.count, 0));
  const clearSelection = () => { selected = new Map(); lastKey = null; };
  function clickItem(item: SelectableItem, siblings: SelectableItem[], shiftKey: boolean): void {
    if (shiftKey && lastKey) {
      const range = rangeBetween(siblings, lastKey, item.key);
      if (range) {
        const next = new Map(selected);
        for (const it of range) next.set(it.key, it);
        selected = next;
        lastKey = item.key;
        return;
      }
    }
    selected = toggleInMap(selected, item);
    lastKey = item.key;
  }

  const allRoots = $derived([
    ...gastoTree, ...ingresoTree, ...internaTree, ...inversionTree,
    ...displayEventos.flatMap((e) => e.children)
  ] as PivotNodeLike[]);
  const nodeMovIds = $derived(collectNodeMovIds(allRoots));
  const txCatIndex = $derived(buildTxCategoryIndex(rows));

  // ── Toast con Deshacer y envío secuencial de comandos ──────────────────────
  let toast = $state<{ message: string; onUndo?: () => Promise<void> } | null>(null);
  async function sendAll(payloads: Record<string, unknown>[]): Promise<{ ok: boolean; message: string }> {
    for (const payload of payloads) {
      const result = await sendFinanceCommand(householdId, payload);
      if (result.outcome !== 'synced') return { ok: false, message: result.message };
    }
    await invalidateAll();
    return { ok: true, message: '' };
  }
  async function runCategoryUndo(plan: CategoryUndo): Promise<void> {
    const payloads = [
      ...plan.reassignments.map((r) => assignConceptToCategory(r.provider, r.concept, r.categoryId)),
      ...plan.bulkRestores.map((g) => bulkByIds(g.txIds, { categoryId: g.categoryId }))
    ];
    const r = await sendAll(payloads);
    const aviso = plan.bulkRestores.length > 0 ? ' · las reglas creadas se conservan (bórralas en Ajustes)' : '';
    const saltos = plan.skipped > 0 ? ` · ${plan.skipped} sin categoría previa` : '';
    toast = { message: r.ok ? `Deshecho${aviso}${saltos}` : r.message };
  }

  // ── Acciones de la barra (por concepto, o por ids exactos si hay hojas) ────
  async function actionMoveToEvent(eventId: string): Promise<void> {
    const items = selectionList;
    if (items.length === 0) return;
    const name = events.find((e) => e.id === eventId)?.name ?? '';
    const txIds = items.filter((i) => i.txId != null).map((i) => i.txId!);
    const conceptItems = items.filter((i) => i.txId == null);
    const r = await sendAll([
      ...conceptItems.map((i) => assignConceptToEvent(conceptTargetOf(i), { eventId })),
      ...(txIds.length ? [bulkByIds(txIds, { addEventId: eventId })] : [])
    ]);
    toast = r.ok
      ? {
          message: summarizeEventDrop(selectionMovs, name),
          ...(conceptItems.length
            ? { onUndo: async () => { const u = await sendAll(conceptItems.map((i) => undoEventAssign(conceptTargetOf(i)))); toast = { message: u.ok ? 'Deshecho' : u.message }; } }
            : {})
        }
      : { message: r.message };
    clearSelection();
  }
  async function actionNewEvent(name: string): Promise<void> {
    const items = selectionList;
    if (items.length === 0) return;
    const existing = events.find((e) => e.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing) return actionMoveToEvent(existing.id);
    const conceptItems = items.filter((i) => i.txId == null);
    const r = await sendAll(conceptItems.map((i) => assignConceptToEvent(conceptTargetOf(i), { newEventName: name })));
    toast = r.ok ? { message: summarizeEventDrop(selectionMovs, name) } : { message: r.message };
    clearSelection();
  }
  async function actionMoveToCategory(categoryId: string): Promise<void> {
    const items = selectionList;
    if (items.length === 0) return;
    const txIds = resolveSelectionIds(items.filter((i) => i.txId != null), nodeMovIds);
    const conceptItems = items.filter((i) => i.txId == null && i.categoryId == null);
    const omitted = items.filter((i) => i.categoryId != null).length;
    const plan = planCategoryUndo(conceptItems, nodeMovIds, txCatIndex);
    const r = await sendAll([
      ...conceptItems.map((i) => assignConceptToCategory(i.provider, i.concept, categoryId)),
      ...(txIds.length ? [bulkByIds(txIds, { categoryId })] : [])
    ]);
    const movidos = conceptItems.reduce((s, i) => s + i.count, 0) + txIds.length;
    toast = r.ok
      ? { message: summarizeCategoryDrop(movidos, catPathOf(categoryId), omitted), ...(movidos > 0 ? { onUndo: () => runCategoryUndo(plan) } : {}) }
      : { message: r.message };
    clearSelection();
  }
  async function actionSetRecurrence(rec: 'recurrente' | 'extraordinario'): Promise<void> {
    const items = selectionList;
    if (items.length === 0) return;
    const txIds = items.filter((i) => i.txId != null).map((i) => i.txId!);
    const conceptItems = items.filter((i) => i.txId == null);
    const r = await sendAll([
      ...conceptItems.map((i) => assignConceptRecurrence(conceptTargetOf(i), rec)),
      ...(txIds.length ? [bulkByIds(txIds, { recurrence: rec })] : [])
    ]);
    const label = rec === 'recurrente' ? '♻ recurrente' : '✦ extraordinario';
    toast = r.ok ? { message: `${selectionMovs} movimiento${selectionMovs === 1 ? '' : 's'} → ${label}` } : { message: r.message };
    clearSelection();
  }
  async function actionInvest(accountId: string): Promise<void> {
    // Solo cargos negativos sin cruzar (el servidor rechaza el resto): se envía
    // por id exacto resolviendo la selección completa.
    const ids = resolveSelectionIds(selectionList, nodeMovIds);
    if (ids.length === 0) return;
    const name = invAccounts.find((a) => a.id === accountId)?.name ?? '';
    const r = await sendAll(ids.map((id) => investTransaction(id, accountId)));
    toast = r.ok ? { message: `${ids.length} movimiento${ids.length === 1 ? '' : 's'} → inversión ${name}` } : { message: r.message };
    clearSelection();
  }
  function actionOpenPanel(): void {
    const ids = resolveSelectionIds(selectionList, nodeMovIds);
    const n = selectionList.length;
    onOpenIds(ids, `${n} seleccionado${n === 1 ? '' : 's'}`, `${ids.length} movimiento${ids.length === 1 ? '' : 's'}`);
  }
```

(c) sustituye el snippet `nodeRow` COMPLETO por esta versión con checkbox (todo lo demás igual):

```svelte
{#snippet nodeRow(node: PivotNodeLike, kind: 'gasto' | 'ingreso' | 'evento' | 'transferencia' | 'inversion', nodeDims: PivotDimension[], siblings: SelectableItem[])}
  {@const isExpanded = forceExpand || expanded.has(node.key)}
  {@const hasChildren = node.children.length > 0}
  {@const canOpen = !hasChildren && node.movs.length > 0}
  {@const item = kind === 'transferencia' || kind === 'inversion' ? toMovementSelectable(node, nodeDims) : toAnySelectable(node, nodeDims)}
  {@const childSiblings = selectableListAny(node.children, nodeDims)}
  {@const natClass = (kind === 'gasto' || kind === 'ingreso') && nodeDims[node.depth] === 'nat'
    ? node.nat === 'recurrente' ? (kind === 'gasto' ? 'neg' : 'pos') : node.nat === 'extraordinario' ? 'suave' : ''
    : ''}
  <tr style={tintFor(node.depth)} class:clicable={hasChildren} onclick={() => hasChildren && toggle(node.key)}>
    <td class="arbol" style={`padding-left: calc(var(--space-3) + ${node.depth} * var(--space-4));`}>
      <span class="flecha" aria-hidden="true">{hasChildren ? (isExpanded ? '▾' : '▸') : ''}</span>
      <input type="checkbox" class="marca" style:visibility={item ? 'visible' : 'hidden'}
        tabindex={item ? 0 : -1} checked={item ? selected.has(node.key) : false}
        aria-label={`seleccionar ${node.label}`}
        onclick={(e) => { e.stopPropagation(); if (item) clickItem(item, siblings, e.shiftKey); }} />
      {#if canOpen}
        <button type="button" class="abrir" title="abrir ficha"
          onclick={(e) => { e.stopPropagation(); openLeaf(node); }}>{node.label}</button>
      {:else}
        <span class={natClass}>{node.label}</span>
      {/if}
      <small>({node.count})</small>
    </td>
    <td class="importe cifra {natClass}">{cellText(node.totalCents)}</td>
    <td class="importe cifra {natClass}">{cellText(node.avgCents)}</td>
    <td class="importe cifra {natClass}">{cellText(node.ticketCents)}</td>
    {#each months as m (m)}<td class="importe cifra {natClass}">{cellText(node.monthly[m])}</td>{/each}
  </tr>
  {#if isExpanded}
    {#each node.children as child (child.key)}
      {@render nodeRow(child, kind, nodeDims, childSiblings)}
    {/each}
  {/if}
{/snippet}
```

(d) actualiza TODAS las llamadas `{@render nodeRow(...)}` para pasar el cuarto argumento: en INGRESOS `selectableListAny(ingresoTree, dims)`, en GASTOS `selectableListAny(gastoTree, dims)`, en hijos de evento `selectableListAny(event.children, dims)`, en INTERNAS e INVERSIÓN `[]`.

(e) tras el cierre del `{#if isEmpty}…{/if}` del componente añade la barra y el toast:

```svelte
{#if selectionList.length > 0}
  <PivotActionBar concepts={selectionList.length} movs={selectionMovs}
    events={displayEventos.map((e) => ({ id: e.eventId, name: e.name, txCount: e.count, netCents: e.netCents, incomeCents: 0n, expenseCents: 0n }))}
    {categories} {invAccounts}
    categoryOnlySelection={selectionList.every((i) => i.categoryId != null)}
    onMoveToEvent={actionMoveToEvent} onNewEvent={actionNewEvent}
    onMoveToCategory={actionMoveToCategory} onSetRecurrence={actionSetRecurrence}
    onInvest={actionInvest} onOpenPanel={actionOpenPanel} onClear={clearSelection} />
{/if}

{#if toast}
  <div class="pivot-toast" role="status" data-testid="pivot-toast">
    <span>{toast.message}</span>
    {#if toast.onUndo}<button type="button" onclick={() => { const u = toast?.onUndo; toast = null; void u?.(); }}>Deshacer</button>{/if}
    <button type="button" aria-label="cerrar aviso" onclick={() => (toast = null)}>✕</button>
  </div>
{/if}
```

y en el `<style>`:

```css
  .marca { margin-right: var(--space-1); }
  .pivot-toast { position: fixed; z-index: 50; bottom: calc(var(--bottom-nav-h) + var(--space-6) + var(--space-6)); inset-inline: 0; margin-inline: auto; width: fit-content; max-width: calc(100% - var(--space-6)); display: flex; align-items: center; gap: var(--space-3); background: var(--primary); color: var(--ink-on-primary); border-radius: var(--r-md); box-shadow: var(--shadow-over); padding: var(--space-2) var(--space-3); font-size: var(--text-meta); }
  .pivot-toast button { border: 0; background: transparent; color: var(--ink-on-primary); cursor: pointer; font-weight: 700; text-decoration: underline; }
```

- [ ] **Step 3: verde.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm check && pnpm vitest run
```

- [ ] **Step 4: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/src/lib/components/finance/PivotActionBar.svelte apps/web/src/lib/components/finance/PivotTable.svelte
git commit -m "feat(finanzas): selección con Shift y barra de acciones flotante con toast Deshacer"
```

---

### Task 13: Drag-and-drop nativo con ghost, targets y popover de nuevo evento

**Files:**
- Modify: `apps/web/src/lib/components/finance/PivotTable.svelte`

**Interfaces:**
- Consumes: `buildDragPayload`, `dragGhostLabel`, `createDragGhostElement`, `collectLeafItems`, `type DragPayload` de `$lib/finance/pivot-state`; acciones de la tarea 12.
- Produces: asas `⠿` arrastrables en GASTOS/INGRESOS/EVENTOS; drop en filas con `catId`, en filas de evento y en la banda EVENTOS (= nuevo evento con popover); clases `dnd-target`/`dnd-dimmed` durante el arrastre; ghost global `.pivot-drag-ghost`.

- [ ] **Step 1: estado y handlers.** En el `<script>` de `PivotTable.svelte` añade los imports (`buildDragPayload, collectLeafItems, createDragGhostElement, dragGhostLabel, type DragPayload` de pivot-state) y:

```ts
  // ── Drag and drop nativo (la barra de acciones es la alternativa completa) ─
  let dragging = $state<DragPayload | null>(null);
  let newEventDrop = $state<DragPayload | null>(null);
  let newEventName = $state('');

  function onDragStart(e: DragEvent, node: PivotNodeLike, nodeDims: PivotDimension[]): void {
    const self = toAnySelectable(node, nodeDims);
    let items: SelectableItem[];
    let omitted = 0;
    if (self) {
      items = selected.has(node.key) && selectionList.length > 0 ? selectionList : [self];
    } else {
      const collected = collectLeafItems(node);
      items = collected.items;
      omitted = collected.omitted;
    }
    if (items.length === 0 || !e.dataTransfer) {
      e.preventDefault();
      return;
    }
    const payload = buildDragPayload(items, omitted);
    e.dataTransfer.setDragImage(createDragGhostElement(dragGhostLabel(payload)), 10, 10);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', node.key);
    dragging = payload;
  }
  const onDragEnd = () => (dragging = null);

  async function onDropCategory(categoryId: string): Promise<void> {
    const payload = dragging;
    dragging = null;
    if (!payload || payload.items.length === 0) return;
    const txIds = payload.items.filter((i) => i.txId != null).map((i) => i.txId!);
    const conceptItems = payload.items.filter((i) => i.txId == null && i.categoryId == null);
    const omitted = payload.omitted + payload.items.filter((i) => i.categoryId != null).length;
    const plan = planCategoryUndo(conceptItems, nodeMovIds, txCatIndex);
    const movidos = conceptItems.reduce((s, i) => s + i.count, 0) + txIds.length;
    const r = await sendAll([
      ...conceptItems.map((i) => assignConceptToCategory(i.provider, i.concept, categoryId)),
      ...(txIds.length ? [bulkByIds(txIds, { categoryId })] : [])
    ]);
    toast = r.ok
      ? { message: summarizeCategoryDrop(movidos, catPathOf(categoryId), omitted), ...(movidos > 0 ? { onUndo: () => runCategoryUndo(plan) } : {}) }
      : { message: r.message };
  }

  async function onDropEvent(eventId: string, eventName: string): Promise<void> {
    const payload = dragging;
    dragging = null;
    if (!payload || payload.items.length === 0) return;
    const txIds = payload.items.filter((i) => i.txId != null).map((i) => i.txId!);
    const conceptItems = payload.items.filter((i) => i.txId == null);
    const r = await sendAll([
      ...conceptItems.map((i) => assignConceptToEvent(conceptTargetOf(i), { eventId })),
      ...(txIds.length ? [bulkByIds(txIds, { addEventId: eventId })] : [])
    ]);
    toast = r.ok
      ? {
          message: summarizeEventDrop(payload.movs, eventName, payload.omitted),
          ...(conceptItems.length
            ? { onUndo: async () => { const u = await sendAll(conceptItems.map((i) => undoEventAssign(conceptTargetOf(i)))); toast = { message: u.ok ? 'Deshecho' : u.message }; } }
            : {})
        }
      : { message: r.message };
  }

  function onDropNewEvent(): void {
    const payload = dragging;
    dragging = null;
    if (!payload || payload.items.length === 0) return;
    newEventDrop = payload;
    newEventName = '';
  }
  async function confirmNewEventDrop(): Promise<void> {
    const payload = newEventDrop;
    const name = newEventName.trim();
    newEventDrop = null;
    if (!payload || !name) return;
    const conceptItems = payload.items.filter((i) => i.txId == null);
    const r = await sendAll(conceptItems.map((i) => assignConceptToEvent(conceptTargetOf(i), { newEventName: name })));
    toast = r.ok ? { message: summarizeEventDrop(payload.movs, name, payload.omitted) } : { message: r.message };
  }
```

- [ ] **Step 2: marcado.** En el snippet `nodeRow`, sustituye la apertura del `<tr>` y añade el asa:

```svelte
  {@const isDraggable = kind === 'gasto' || kind === 'ingreso' || kind === 'evento'}
  {@const isCategoryTarget = (kind === 'gasto' || kind === 'ingreso') && node.catId !== null}
  <tr style={tintFor(node.depth)} class:clicable={hasChildren}
    class:dnd-target={dragging && isCategoryTarget} class:dnd-dimmed={dragging && !isCategoryTarget}
    onclick={() => hasChildren && toggle(node.key)}
    ondragover={isCategoryTarget ? (e) => e.preventDefault() : undefined}
    ondrop={isCategoryTarget ? (e) => { e.preventDefault(); void onDropCategory(node.catId!); } : undefined}>
```

y dentro del `<td class="arbol">`, entre la flecha y el checkbox:

```svelte
      <span class="asa" draggable={isDraggable} title="arrastrar" aria-hidden="true"
        style:visibility={isDraggable ? 'visible' : 'hidden'}
        onclick={(e) => e.stopPropagation()}
        ondragstart={isDraggable ? (e) => onDragStart(e, node, nodeDims) : undefined}
        ondragend={isDraggable ? onDragEnd : undefined}>⠿</span>
```

En la fila de cada evento añade `class:dnd-target={dragging !== null}`, `ondragover={(e) => e.preventDefault()}` y `ondrop={(e) => { e.preventDefault(); void onDropEvent(event.eventId, event.name); }}`. En la banda EVENTOS sustituye la fila por:

```svelte
        <tr class="banda" class:dnd-target={dragging !== null} data-testid="pivot-banda-eventos"
          ondragover={(e) => e.preventDefault()} ondrop={(e) => { e.preventDefault(); onDropNewEvent(); }}>
          <td colspan={colSpan} class="banda-eventos">
            EVENTOS (soltar aquí = + nuevo evento · ☑ por evento = verlo en gastos/ingresos)
            {#if newEventDrop}
              <form class="popover-evento" onsubmit={(e) => { e.preventDefault(); void confirmNewEventDrop(); }}>
                <input type="text" placeholder="＋ nuevo evento…" bind:value={newEventName} data-autofocus
                  aria-label="Nombre del evento nuevo"
                  onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); newEventDrop = null; } }} />
                <button type="submit">Crear y asignar</button>
              </form>
            {/if}
          </td>
        </tr>
```

y en el `<style>`:

```css
  .asa { cursor: grab; color: var(--ink-faint); margin-right: var(--space-1); }
  tr.dnd-target { outline: 2px solid var(--primary); outline-offset: -2px; }
  tr.dnd-dimmed { opacity: .45; }
  .banda-eventos { position: relative; }
  .popover-evento { position: absolute; z-index: 30; top: 100%; left: var(--space-3); display: flex; gap: var(--space-1); background: var(--surface-strong); border: 1px solid var(--line-strong); border-radius: var(--r-md); box-shadow: var(--shadow-over); padding: var(--space-2); }
  .popover-evento input { border: 1px solid var(--line); border-radius: var(--r-sm); padding: var(--space-1); font-size: max(1em, 1rem); }
  .popover-evento button { border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--primary); color: var(--ink-on-primary); cursor: pointer; padding: var(--space-1) var(--space-2); }
  :global(.pivot-drag-ghost) { position: fixed; top: -1000px; left: -1000px; padding: var(--space-1) var(--space-3); border-radius: var(--r-full); background: var(--primary); color: var(--ink-on-primary); font-size: var(--text-micro); white-space: nowrap; pointer-events: none; }
```

- [ ] **Step 3: verde.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm check
```

- [ ] **Step 4: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/src/lib/components/finance/PivotTable.svelte
git commit -m "feat(finanzas): drag-and-drop nativo del pivot con ghost, targets y nuevo evento al soltar"
```

---

### Task 14: e2e fixture — pivot: expandir, seleccionar, mover por la barra de acciones

**Files:**
- Test: `apps/web/e2e/finanzas-pivot.e2e.ts`

**Interfaces:**
- Consumes: `loginAs`, `HOUSEHOLD` de `apps/web/e2e/helpers.ts`; la maqueta de la tarea 8 (datos deterministas); testids de las tareas 8–12. El servidor de Playwright corre SIN base de datos (modo fixture): las escrituras quedan en el outbox y el acuse honesto es «Guardado en este dispositivo…».

- [ ] **Step 1: escribe la spec.** Crea `apps/web/e2e/finanzas-pivot.e2e.ts`:

```ts
import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

test.beforeEach(async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/analitica`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Analítica');
});

test('la Analítica de la maqueta pinta KPIs, medias, partidas, gráfica y resumen', async ({ page }) => {
  await expect(page.getByTestId('kpi-analitica')).toContainText('Tasa ahorro bruta');
  await expect(page.getByTestId('kpi-analitica')).toContainText('Free cash flow');
  await expect(page.getByText('Media mensual · 3 meses completos')).toBeVisible();
  await expect(page.getByTestId('partidas-tabla')).toContainText('Semana Santa 2026');
  await expect(page.getByTestId('resumen-mensual')).toContainText('Ahorro bruto');
});

test('el pivot muestra las cinco bandas y el TOTAL NETO', async ({ page }) => {
  for (const banda of ['ingresos', 'gastos', 'eventos', 'internas', 'inversion']) {
    await expect(page.getByTestId(`pivot-banda-${banda}`)).toBeVisible();
  }
  await expect(page.getByTestId('pivot-table')).toContainText('TOTAL NETO');
  // El subtotal de internas de la maqueta suma 0: sin aviso ⚠.
  await expect(page.getByTestId('pivot-table').getByText('Subtotal internas ⚠')).toHaveCount(0);
});

test('expandir un nodo enseña sus hijos y la selección levanta la barra de acciones', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  await expect(tabla).not.toContainText('Mercadona');
  await tabla.getByText('Supermercado', { exact: false }).first().click();
  await expect(tabla).toContainText('Mercadona');
  const fila = tabla.locator('tr', { hasText: 'Mercadona' }).first();
  await fila.getByRole('checkbox').click();
  const barra = page.getByTestId('pivot-actionbar');
  await expect(barra).toBeVisible();
  await expect(barra).toContainText('1 concepto');
});

test('mover a evento por la barra da un acuse honesto en modo fixture (sin base de datos)', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  await tabla.getByText('Supermercado', { exact: false }).first().click();
  await tabla.locator('tr', { hasText: 'Mercadona' }).first().getByRole('checkbox').click();
  const barra = page.getByTestId('pivot-actionbar');
  await barra.getByText('Mover a evento ▾').click();
  await barra.getByRole('button', { name: 'Semana Santa 2026' }).click();
  // Sin base de datos el sync no confirma: el comando queda en cola y se dice.
  await expect(page.getByTestId('pivot-toast')).toContainText('Guardado en este dispositivo');
});

test('el atajo «/» enfoca el buscador y un chip filtra el pivot expandiéndolo', async ({ page }) => {
  await page.keyboard.press('/');
  const buscador = page.getByLabel('Buscar');
  await expect(buscador).toBeFocused();
  await buscador.fill('merca');
  await page.getByRole('button', { name: /Mercadona/ }).first().click();
  await expect(page.getByText('🔍 Proveedor: Mercadona')).toBeVisible();
  const tabla = page.getByTestId('pivot-table');
  await expect(tabla).toContainText('Mercadona'); // búsqueda activa fuerza expansión
  await expect(tabla).not.toContainText('Cine Ideal');
});

test('las dims son reordenables y persisten en la URL', async ({ page }) => {
  await page.getByRole('button', { name: 'Naturaleza' }).click(); // añade la dim nat
  await expect(page).toHaveURL(/dims=cat%2Csub%2Cnat|dims=cat,sub,nat/);
  await page.getByRole('button', { name: 'mover Naturaleza antes' }).click();
  await expect(page).toHaveURL(/nat/);
});
```

- [ ] **Step 2: ejecútala y ve el resultado.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm test:e2e finanzas-pivot.e2e.ts
```

Primera ejecución: es probable que algún selector o texto no case (rojo). Corrige EN LOS COMPONENTES (nunca relajando asertos que describen la spec §8) hasta el verde. Si sale verde a la primera, fuerza un rojo puntual (cambia temporalmente un texto esperado, confirma que falla, restáuralo) para validar que los asertos muerden.

- [ ] **Step 3: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/e2e/finanzas-pivot.e2e.ts
git commit -m "test(finanzas): e2e fixture del pivot — bandas, expansión, selección, barra y buscador"
```

---

### Task 15: e2e fixture — DnD básico

**Files:**
- Test: `apps/web/e2e/finanzas-pivot-dnd.e2e.ts`

**Interfaces:**
- Consumes: los mismos helpers y maqueta que la tarea 14; asas `⠿` (`title="arrastrar"`) y targets de la tarea 13. Playwright ejecuta el arrastre con eventos de ratón reales (Chromium dispara el dnd HTML5 nativo).

- [ ] **Step 1: escribe la spec.** Crea `apps/web/e2e/finanzas-pivot-dnd.e2e.ts`:

```ts
import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

test.beforeEach(async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/analitica`);
  const tabla = page.getByTestId('pivot-table');
  await tabla.getByText('Supermercado', { exact: false }).first().click();
  await expect(tabla).toContainText('Mercadona');
});

test('arrastrar un proveedor a otra categoría dispara el comando y da acuse honesto', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  const asa = tabla.locator('tr', { hasText: 'Mercadona' }).first().locator('[title="arrastrar"]');
  const destino = tabla.locator('tr', { hasText: 'Ocio' }).first();
  await asa.dragTo(destino, { targetPosition: { x: 40, y: 8 } });
  // Sin base de datos el comando queda en cola: acuse honesto, no un éxito falso.
  await expect(page.getByTestId('pivot-toast')).toContainText('Guardado en este dispositivo');
});

test('soltar sobre la banda EVENTOS abre el popover de nuevo evento y Escape lo cierra', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  const asa = tabla.locator('tr', { hasText: 'Mercadona' }).first().locator('[title="arrastrar"]');
  await asa.dragTo(page.getByTestId('pivot-banda-eventos'), { targetPosition: { x: 60, y: 8 } });
  const campo = page.getByPlaceholder('＋ nuevo evento…');
  await expect(campo).toBeVisible();
  await campo.press('Escape');
  await expect(campo).toHaveCount(0);
});

test('arrastrar a un evento existente da acuse honesto', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  const asa = tabla.locator('tr', { hasText: 'Mercadona' }).first().locator('[title="arrastrar"]');
  const evento = tabla.locator('tr', { hasText: 'Semana Santa 2026' }).first();
  await asa.dragTo(evento, { targetPosition: { x: 60, y: 8 } });
  await expect(page.getByTestId('pivot-toast')).toContainText('Guardado en este dispositivo');
});
```

- [ ] **Step 2: ejecuta.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm test:e2e finanzas-pivot-dnd.e2e.ts
```

Si `dragTo` no dispara el `dragstart` en tu Chromium, repite el gesto manualmente en la spec (`hover` sobre el asa → `mouse.down()` → dos `mouse.move` hasta el centro del destino con `steps: 10` → `mouse.up()`) — cambia el MECANISMO del test, jamás el comportamiento del componente. Verde antes de seguir.

- [ ] **Step 3: commit.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add apps/web/e2e/finanzas-pivot-dnd.e2e.ts
git commit -m "test(finanzas): e2e fixture del drag-and-drop básico del pivot"
```

---

### Task 16: Gates de la rama en verde

**Files:**
- Modify: solo lo que los gates señalen (correcciones puntuales).

**Interfaces:** ninguna nueva.

- [ ] **Step 1: gates completos.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
pnpm lint && pnpm typecheck && pnpm check && pnpm test
```

Salida esperada: todo verde (los tests nuevos de `apps/web/tests/` incluidos).

- [ ] **Step 2: presupuesto de Hoy.** Todo el código de esta fase debe vivir en los chunks de las rutas de finanzas:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm build && pnpm verify:bundle
```

Salida esperada: el verificador en verde. Si señala que algo de finanzas alcanzó el grafo inicial, la causa habitual es un import estático desde un módulo compartido: corrige el import (nunca el verificador).

- [ ] **Step 3: e2e completa (regresión).**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/apps/web
pnpm test:e2e
```

- [ ] **Step 4: commit final si hubo correcciones.**

```bash
cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
git add -A apps/web
git commit -m "chore(finanzas): fase 6 en verde — gates, presupuesto de Hoy y e2e completos"
```

(Si `git status` está limpio tras los gates, no hay commit: la fase queda cerrada con los commits de las tareas 1–15.)
