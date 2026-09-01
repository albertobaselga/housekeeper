# Módulo Finanzas: UI de lectura — Plan de implementación (Fase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dashboard y Movimientos de Finanzas leyendo datos reales bajo RLS: barra de filtros con merge no destructivo, KPIs con deltas, gráficas SVG artesanales, tabla ledger de lectura, panel de detalle accesible y endpoints GET `/api/v1/finance/*`, todo en verde con tests unitarios, de integración y e2e.

**Architecture:** Las lecturas SQL viven en `packages/server/src/finance/queries.ts` y se ejecutan siempre dentro de `withAuthorizedTransaction` + `requireFinanceAdmin`; los `+page.server.ts` de Dashboard y Movimientos las consumen vía `apps/web/src/lib/server/finance.server.ts` (con `demoOrUnavailable` y fixtures sintéticas para el modo demo), y los endpoints REST GET las exponen para la interactividad del cliente (`$lib/finance/api.ts`, panel de detalle). La UI son componentes Svelte 5 con runas en `$lib/components/finance/`, con la geometría de las gráficas extraída a módulos puros testeables en `$lib/finance/`.

**Tech Stack:** SvelteKit 2.70 / Svelte 5 (runas), TypeScript, pg (bigint como string), vitest, Playwright, Postgres 18.4 local en Docker, CSS por tokens de `app.css`.

**Spec:** /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/specs/2026-08-31-modulo-finanzas-design.md y /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/plans/2026-08-31-modulo-finanzas-interfaces.md (interfaces canónicas: sus nombres, rutas y firmas son LEY).

## Global Constraints

- Trabajar SOLO dentro del worktree `/home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas` (rama `worktree-modulo-finanzas`). El repo `/home/abf/github/home-finance` es solo-lectura (fuente a portar).
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

**Contexto común a todas las tareas** (repítelo mentalmente en cada una):

- Esta fase corre DESPUÉS de las fases 1 y 2: el esquema `0034_finance.sql`, las fixtures `packages/db/fixtures/002_finance.sql` (datos sintéticos en roble y olivo, concesión viva SOLO para el admin de roble), `requireFinanceAdmin`, el routing/nav y las páginas esqueleto de `/h/[householdId]/finanzas/*` ya existen en el worktree, igual que `packages/domain/src/finance/` completo.
- Patrón de load: `apps/web/src/routes/h/[householdId]/employment/+page.server.ts` (con `demoOrUnavailable` de `$lib/server/data-source.server`). Patrón de lector SQL bajo RLS: `apps/web/src/lib/server/employment.server.ts` (`withAuthorizedTransaction`, camelCase con `as "alias"`, céntimos como string). Patrón de endpoint: `apps/web/src/routes/api/v1/households/[householdId]/vacaciones/vistas/+server.ts`. Patrón de página Svelte 5: `apps/web/src/routes/h/[householdId]/employment/+page.svelte` (runas `$props/$state/$derived/$effect`, snippets, clases de `app.css`: `.page-wrap`, `.card`, `.chip`, `.summary-strip`, `.ledger-list`, `.cifra`).
- Los importes viajan por JSON SIEMPRE como cadenas de céntimos (`"amountCents": "-4550"`); solo se convierten a `BigInt` para operar y a `Number` únicamente para coordenadas de píxel de las gráficas (nunca para dinero).
- Postgres local para integración: el mismo del worktree que usa `test:e2e:db`; exporta `TEST_DATABASE_URL=postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_wt_u` (ajústalo si tu instancia difiere). Sin la variable, las suites de integración se saltan (`describe.runIf`), así que ponla siempre.

---

### Task 1: Filtros de URL con merge no destructivo (`$lib/finance/filters.ts`)

**Files:**
- Create: `apps/web/src/lib/finance/filters.ts`
- Test: `apps/web/tests/finance-filters.test.ts`

**Interfaces:**
- Produces (canónico según doc de interfaces: claves `from`, `to`, `g`, `acc`, `ev` gestionadas aquí; `exev`, `dims`, `q`, `cat`, `rec`, `dupev` deben SOBREVIVIR al merge):

```ts
export type FinanceGranularity = 'month' | 'quarter' | 'year';
export interface FinanceFilters {
  from: string; to: string; granularity: FinanceGranularity;
  accountIds: string[]; eventId: string | null;
}
export function parseFilters(params: URLSearchParams, today: string): FinanceFilters;
export function mergeFilters(current: URLSearchParams, next: FinanceFilters): URLSearchParams; // merge NO destructivo
export function mergeParams(current: URLSearchParams, patch: Record<string, string | null>): URLSearchParams;
export function apiQuery(filters: FinanceFilters): URLSearchParams; // from,to[,acc][,ev] para la API
export function monthRange(anchor: string): { from: string; to: string };
export function ytdRange(today: string): { from: string; to: string };
export function rangeOfMonths(anchor: string, months: number): { from: string; to: string };
export function spanMonths(filters: Pick<FinanceFilters, 'from' | 'to'>): number;
export function shiftRange(filters: FinanceFilters, direction: 1 | -1): FinanceFilters;
export function rangeLabel(filters: Pick<FinanceFilters, 'from' | 'to'>): string;
export function presetRanges(today: string): { label: string; range: { from: string; to: string } }[];
export function todayLocal(now?: Date, timeZone?: string): string; // yyyy-mm-dd en Europe/Madrid
export function isUuid(value: string): boolean;
```

- Consumes: `MONTHS_SHORT`/`MONTHS_LONG` de `./format` (Task 2 los crea; en esta tarea declara los arrays localmente y NO los importes — Task 2 los mueve).

**Pasos:**

- [ ] **Step 1: Escribe el test que falla.** Crea `apps/web/tests/finance-filters.test.ts` (imita el estilo de `apps/web/tests/app-title.test.ts`: imports relativos `../src/lib/...`):

```ts
import { describe, expect, it } from 'vitest';

import {
  apiQuery,
  mergeFilters,
  mergeParams,
  monthRange,
  parseFilters,
  presetRanges,
  rangeLabel,
  rangeOfMonths,
  shiftRange,
  spanMonths,
  ytdRange
} from '../src/lib/finance/filters';

const TODAY = '2026-08-31';
const base = { from: '2026-08-01', to: '2026-08-31', granularity: 'month' as const, accountIds: [], eventId: null };

describe('filtros de finanzas: parseo y presets', () => {
  it('sin parámetros: año hasta hoy, granularidad mensual, sin cuentas ni evento', () => {
    expect(parseFilters(new URLSearchParams(), TODAY)).toEqual({
      from: '2026-01-01', to: '2026-08-31', granularity: 'month', accountIds: [], eventId: null
    });
  });

  it('lee from/to/g/acc/ev y descarta lo malformado', () => {
    const params = new URLSearchParams('from=2026-02-01&to=2026-02-28&g=quarter&acc=a1,a2&ev=e9');
    expect(parseFilters(params, TODAY)).toEqual({
      from: '2026-02-01', to: '2026-02-28', granularity: 'quarter', accountIds: ['a1', 'a2'], eventId: 'e9'
    });
    expect(parseFilters(new URLSearchParams('g=bogus&from=ayer'), TODAY).granularity).toBe('month');
    expect(parseFilters(new URLSearchParams('g=bogus&from=ayer'), TODAY).from).toBe('2026-01-01');
  });

  it('monthRange y rangeOfMonths cierran en fin de mes real (febrero bisiesto incluido)', () => {
    expect(monthRange('2024-02-15')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(rangeOfMonths('2026-08-31', 3)).toEqual({ from: '2026-06-01', to: '2026-08-31' });
    expect(ytdRange(TODAY)).toEqual({ from: '2026-01-01', to: '2026-08-31' });
  });

  it('shiftRange desplaza el rango exactamente su propio ancho', () => {
    expect(shiftRange(base, -1)).toMatchObject({ from: '2026-07-01', to: '2026-07-31' });
    expect(shiftRange({ ...base, from: '2026-01-01', to: '2026-03-31' }, 1))
      .toMatchObject({ from: '2026-04-01', to: '2026-06-30' });
    expect(spanMonths({ from: '2026-01-01', to: '2026-03-31' })).toBe(3);
  });

  it('rangeLabel: mes suelto con nombre largo, rango con cortos', () => {
    expect(rangeLabel(base)).toBe('agosto 2026');
    expect(rangeLabel({ from: '2026-01-01', to: '2026-06-30' })).toBe('ene 2026 – jun 2026');
  });

  it('presetRanges: «Mes anterior» cruza el año sin romperse', () => {
    const presets = presetRanges('2026-01-15');
    const anterior = presets.find((preset) => preset.label === 'Mes anterior');
    expect(anterior?.range).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(presets.map((preset) => preset.label)).toEqual([
      'Año hasta hoy', 'Este mes', 'Mes anterior', 'Trimestre', '12 meses', 'Año'
    ]);
  });
});

describe('merge no destructivo (contrato del original state/filters.tsx)', () => {
  it('conserva las claves que no gestiona: exev, dims, q, cat, rec, dupev', () => {
    const current = new URLSearchParams(
      'from=2026-01-01&to=2026-06-30&g=month&dims=cat,sub&q=luz&cat=c1&rec=recurrente&dupev=1&exev=e1,e2'
    );
    const merged = mergeFilters(current, {
      from: '2026-07-01', to: '2026-07-31', granularity: 'quarter', accountIds: ['a1'], eventId: null
    });
    expect(merged.get('dims')).toBe('cat,sub');
    expect(merged.get('q')).toBe('luz');
    expect(merged.get('cat')).toBe('c1');
    expect(merged.get('rec')).toBe('recurrente');
    expect(merged.get('dupev')).toBe('1');
    expect(merged.get('exev')).toBe('e1,e2');
    expect(merged.get('g')).toBe('quarter');
    expect(merged.get('acc')).toBe('a1');
    expect(merged.has('ev')).toBe(false);
  });

  it('acc y ev desaparecen al quedar vacíos; mergeParams borra con null', () => {
    const current = new URLSearchParams('from=2026-01-01&to=2026-06-30&acc=a1&ev=e1&dims=cat');
    const merged = mergeFilters(current, { from: '2026-01-01', to: '2026-06-30', granularity: 'month', accountIds: [], eventId: null });
    expect(merged.has('acc')).toBe(false);
    expect(merged.has('ev')).toBe(false);
    const patched = mergeParams(current, { q: 'agua', ev: null });
    expect(patched.get('q')).toBe('agua');
    expect(patched.has('ev')).toBe(false);
    expect(patched.get('dims')).toBe('cat');
  });

  it('apiQuery emite from,to y solo añade acc/ev cuando existen', () => {
    expect(apiQuery(base).toString()).toBe('from=2026-08-01&to=2026-08-31');
    expect(apiQuery({ ...base, accountIds: ['a1', 'a2'], eventId: 'e1' }).toString())
      .toBe('from=2026-08-01&to=2026-08-31&acc=a1%2Ca2&ev=e1');
  });
});
```

- [ ] **Step 2: Ejecútalo y ve que falla.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-filters.test.ts` — salida esperada: `Error: Failed to load ... Cannot find module '../src/lib/finance/filters'` (o `failed to resolve import`).
- [ ] **Step 3: Implementación mínima.** Crea `apps/web/src/lib/finance/filters.ts`. Aritmética de fechas por cadenas (patrón de `$lib/employment/model`: nunca dependas del huso del proceso):

```ts
/**
 * Filtros de URL del módulo Finanzas (§7 de la spec, doc de interfaces).
 * Claves gestionadas aquí: from, to, g, acc, ev. Las demás (exev, dims, q,
 * cat, rec, dupev) pertenecen a otras pantallas y el merge las CONSERVA:
 * es el contrato del original (home-finance state/filters.tsx) que evitaba
 * romper la navegación cruzada entre pantallas.
 */

export type FinanceGranularity = 'month' | 'quarter' | 'year';

export interface FinanceFilters {
  from: string;
  to: string;
  granularity: FinanceGranularity;
  accountIds: string[];
  eventId: string | null;
}

const GRANULARITIES: readonly FinanceGranularity[] = ['month', 'quarter', 'year'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'] as const;
export const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function split(iso: string): [number, number, number] {
  const [year = 1970, month = 1, day = 1] = iso.split('-').map(Number);
  return [year, month, day];
}

function isoOf(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Mes `delta` meses después de (year, month), como par [año, mes 1-12]. */
function addMonths(year: number, month: number, delta: number): [number, number] {
  const index = year * 12 + (month - 1) + delta;
  return [Math.floor(index / 12), ((index % 12) + 12) % 12 + 1];
}

export function monthRange(anchor: string): { from: string; to: string } {
  const [year, month] = split(anchor);
  return { from: isoOf(year, month, 1), to: isoOf(year, month, daysInMonth(year, month)) };
}

export function ytdRange(today: string): { from: string; to: string } {
  const [year] = split(today);
  return { from: isoOf(year, 1, 1), to: today };
}

export function rangeOfMonths(anchor: string, months: number): { from: string; to: string } {
  const [year, month] = split(anchor);
  const [startYear, startMonth] = addMonths(year, month, -(months - 1));
  return { from: isoOf(startYear, startMonth, 1), to: isoOf(year, month, daysInMonth(year, month)) };
}

export function spanMonths(filters: Pick<FinanceFilters, 'from' | 'to'>): number {
  const [fromYear, fromMonth] = split(filters.from);
  const [toYear, toMonth] = split(filters.to);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
}

export function shiftRange(filters: FinanceFilters, direction: 1 | -1): FinanceFilters {
  const delta = spanMonths(filters) * direction;
  const [fromYear, fromMonth] = split(filters.from);
  const [toYear, toMonth] = split(filters.to);
  const [newFromYear, newFromMonth] = addMonths(fromYear, fromMonth, delta);
  const [newToYear, newToMonth] = addMonths(toYear, toMonth, delta);
  return {
    ...filters,
    from: isoOf(newFromYear, newFromMonth, 1),
    to: isoOf(newToYear, newToMonth, daysInMonth(newToYear, newToMonth))
  };
}

export function rangeLabel(filters: Pick<FinanceFilters, 'from' | 'to'>): string {
  const [fromYear, fromMonth] = split(filters.from);
  const [toYear, toMonth] = split(filters.to);
  if (spanMonths(filters) === 1) return `${MONTHS_LONG[fromMonth - 1]} ${fromYear}`;
  return `${MONTHS_SHORT[fromMonth - 1]} ${fromYear} – ${MONTHS_SHORT[toMonth - 1]} ${toYear}`;
}

export function presetRanges(today: string): { label: string; range: { from: string; to: string } }[] {
  const [year, month] = split(today);
  const [prevYear, prevMonth] = addMonths(year, month, -1);
  return [
    { label: 'Año hasta hoy', range: ytdRange(today) },
    { label: 'Este mes', range: monthRange(today) },
    { label: 'Mes anterior', range: monthRange(isoOf(prevYear, prevMonth, 1)) },
    { label: 'Trimestre', range: rangeOfMonths(today, 3) },
    { label: '12 meses', range: rangeOfMonths(today, 12) },
    { label: 'Año', range: { from: isoOf(year, 1, 1), to: isoOf(year, 12, 31) } }
  ];
}

export function parseFilters(params: URLSearchParams, today: string): FinanceFilters {
  const fallback = ytdRange(today);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const granularity = params.get('g');
  return {
    from: DATE_PATTERN.test(from) ? from : fallback.from,
    to: DATE_PATTERN.test(to) ? to : fallback.to,
    granularity: (GRANULARITIES as readonly string[]).includes(granularity ?? '')
      ? (granularity as FinanceGranularity)
      : 'month',
    accountIds: (params.get('acc') ?? '').split(',').map((piece) => piece.trim()).filter(Boolean),
    eventId: params.get('ev') || null
  };
}

/** Merge NO destructivo: parte del query string vivo y solo toca sus claves. */
export function mergeFilters(current: URLSearchParams, next: FinanceFilters): URLSearchParams {
  const merged = new URLSearchParams(current);
  merged.set('from', next.from);
  merged.set('to', next.to);
  merged.set('g', next.granularity);
  if (next.accountIds.length > 0) merged.set('acc', next.accountIds.join(','));
  else merged.delete('acc');
  if (next.eventId) merged.set('ev', next.eventId);
  else merged.delete('ev');
  return merged;
}

/** Merge genérico de claves sueltas (q, cat, rec, offset…); null o vacío borra. */
export function mergeParams(current: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const merged = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') merged.delete(key);
    else merged.set(key, value);
  }
  return merged;
}

/** Parámetros de las lecturas REST (`/api/v1/finance/*`): from,to[,acc][,ev]. */
export function apiQuery(filters: FinanceFilters): URLSearchParams {
  const params = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.accountIds.length > 0) params.set('acc', filters.accountIds.join(','));
  if (filters.eventId) params.set('ev', filters.eventId);
  return params;
}

/** Fecha local del hogar (patrón currentPeriod de $lib/employment/model). */
export function todayLocal(now: Date = new Date(), timeZone = 'Europe/Madrid'): string {
  const parts = new Intl.DateTimeFormat('es-ES', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year').padStart(4, '0')}-${get('month').padStart(2, '0')}-${get('day').padStart(2, '0')}`;
}
```

- [ ] **Step 4: En verde.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-filters.test.ts` — todos los tests pasan.
- [ ] **Step 5: Commit.** `git add apps/web/src/lib/finance/filters.ts apps/web/tests/finance-filters.test.ts && git commit -m "feat(finanzas): filtros de URL con merge no destructivo y presets de periodo"`

---

### Task 2: Formato de finanzas (`$lib/finance/format.ts`)

**Files:**
- Create: `apps/web/src/lib/finance/format.ts`
- Modify: `apps/web/src/lib/finance/filters.ts` (importa `MONTHS_*` desde `./format` y borra los arrays locales)
- Test: `apps/web/tests/finance-format.test.ts`

**Interfaces:**
- Consumes: `formatCents`, `dateLabel` de `$lib/employment/model` (ruta: `apps/web/src/lib/employment/model.ts`; `formatCents('145330') === '1.453,30 €'`, admite `{ signed: true }`).
- Produces:

```ts
export { formatCents, dateLabel } from '$lib/employment/model';
export const MONTHS_LONG: readonly string[]; export const MONTHS_SHORT: readonly string[];
export function formatPct(value: number | null): string;          // '—' o '12,3 %' es-ES
export function bucketLabel(bucket: string): string;              // '2026-05'→'may 26' · '2026-T2'→'2026 T2' · '2026'→'2026'
export function deltaPct(now: bigint, prev: bigint): number | null; // null si prev === 0n
export function axisEuro(cents: bigint): string;                  // '1.200 €' sin decimales (ejes)
export function summarizeTxs(rows: readonly { amountCents: string }[]): { count: number; totalCents: bigint; ticketCents: bigint };
```

**Pasos:**

- [ ] **Step 1: Test que falla.** `apps/web/tests/finance-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  axisEuro, bucketLabel, deltaPct, formatCents, formatPct, summarizeTxs
} from '../src/lib/finance/format';

describe('formato de finanzas', () => {
  it('formatCents reexportado: la misma función de la casa', () => {
    expect(formatCents('145330')).toBe('1.453,30 €');
    expect(formatCents('-4550', { signed: true })).toBe('−45,50 €');
  });

  it('formatPct: es-ES con — para null', () => {
    expect(formatPct(null)).toBe('—');
    expect(formatPct(12.3)).toBe('12,3 %');
  });

  it('bucketLabel (contrato del original format.ts): año, trimestre y mes corto', () => {
    expect(bucketLabel('2026')).toBe('2026');
    expect(bucketLabel('2026-T2')).toBe('2026 T2');
    expect(bucketLabel('2026-05')).toBe('may 26');
  });

  it('deltaPct: porcentaje redondeado contra el periodo anterior, null sin previo', () => {
    expect(deltaPct(110n, 100n)).toBe(10);
    expect(deltaPct(-150n, -100n)).toBe(-50);
    expect(deltaPct(50n, 0n)).toBeNull();
  });

  it('axisEuro: unidades con puntos de millar y sin decimales', () => {
    expect(axisEuro(120000n)).toBe('1.200 €');
    expect(axisEuro(-120000n)).toBe('−1.200 €');
    expect(axisEuro(0n)).toBe('0 €');
  });

  it('summarizeTxs: recuento, total y ticket medio en céntimos', () => {
    const figures = summarizeTxs([{ amountCents: '-3000' }, { amountCents: '-1000' }]);
    expect(figures).toEqual({ count: 2, totalCents: -4000n, ticketCents: -2000n });
    expect(summarizeTxs([]).ticketCents).toBe(0n);
  });
});
```

- [ ] **Step 2: Falla.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-format.test.ts` — `Cannot find module '../src/lib/finance/format'`.
- [ ] **Step 3: Implementación.** `apps/web/src/lib/finance/format.ts`:

```ts
/**
 * Formato del módulo Finanzas. `formatCents` NO se reescribe: se reexporta el
 * de la casa ($lib/employment/model), que ya formatea céntimos-string es-ES
 * sin pasar jamás por Number. Aquí solo vive lo específico de finanzas.
 */
export { formatCents, dateLabel } from '$lib/employment/model';

export const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'] as const;
export const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;

export function formatPct(value: number | null): string {
  return value === null ? '—' : `${value.toLocaleString('es-ES')} %`;
}

/** Etiqueta de cubo temporal (portada de home-finance format.ts). */
export function bucketLabel(bucket: string): string {
  if (/^\d{4}$/.test(bucket)) return bucket;
  if (bucket.includes('-T')) return bucket.replace('-', ' ');
  const [year, month] = bucket.split('-');
  return `${MONTHS_SHORT[Number(month) - 1]} ${year!.slice(2)}`;
}

/**
 * Variación porcentual contra el periodo anterior. La división es la única
 * operación que pasa por Number: es un porcentaje redondeado para un chip,
 * no dinero, y las magnitudes de un hogar caben de sobra en un double.
 */
export function deltaPct(now: bigint, prev: bigint): number | null {
  if (prev === 0n) return null;
  return Math.round((Number(now - prev) / Math.abs(Number(prev))) * 100);
}

/** Euros enteros para ejes de gráfica: '1.200 €' (los ticks caen en euros redondos). */
export function axisEuro(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const units = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '−' : ''}${units} €`;
}

/** Cifras de cabecera del panel de detalle: n movimientos · total · ticket. */
export function summarizeTxs(
  rows: readonly { amountCents: string }[]
): { count: number; totalCents: bigint; ticketCents: bigint } {
  const totalCents = rows.reduce((acc, row) => acc + BigInt(row.amountCents), 0n);
  const count = rows.length;
  return { count, totalCents, ticketCents: count === 0 ? 0n : totalCents / BigInt(count) };
}
```

Después, en `filters.ts`: borra sus `MONTHS_LONG`/`MONTHS_SHORT` locales y añade `import { MONTHS_LONG, MONTHS_SHORT } from './format';` (format no importa filters: sin ciclo).

- [ ] **Step 4: En verde ambos.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-format.test.ts tests/finance-filters.test.ts`
- [ ] **Step 5: Commit.** `git add apps/web/src/lib/finance/format.ts apps/web/src/lib/finance/filters.ts apps/web/tests/finance-format.test.ts && git commit -m "feat(finanzas): formato es-ES de porcentajes, cubos y deltas sobre céntimos"`

---

### Task 3: Geometría pura de las gráficas SVG y agrupación del desglose

**Files:**
- Create: `apps/web/src/lib/finance/chart-geometry.ts`
- Create: `apps/web/src/lib/finance/breakdown.ts`
- Test: `apps/web/tests/finance-charts.test.ts`

**Interfaces:**
- Consumes: `bucketLabel` de `./format`.
- Produces (la geometría portada de los componentes recharts del origen — `CashflowChart.tsx` altura 280/eje 70 px, `ui.tsx` Sparkline viewBox 100×32 con `y = 28 − ((v−min)/range)·24` — y de `CategoryBreakdown.tsx` `groupByParent`):

```ts
// chart-geometry.ts
export interface ChartBar { x: number; y: number; width: number; height: number }
export interface CashflowBucketInput { bucket: string; incomeCents: bigint; expenseCents: bigint; savingsCents: bigint }
export interface CashflowLayout {
  width: number; height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  ticks: { value: number; y: number; label: string }[];
  zeroY: number;
  groups: { label: string; centerX: number; income: ChartBar; expense: ChartBar }[];
  savings: { x: number; y: number }[];
}
export function sparklinePoints(values: readonly number[]): string;
export function niceCeil(value: number): number; // 1/2/5 × 10^n ≥ value
export function cashflowLayout(buckets: readonly CashflowBucketInput[], size?: { width?: number; height?: number }): CashflowLayout;
export interface NatureBucketInput { bucket: string; recurringCents: bigint; extraordinaryCents: bigint; unclassifiedCents: bigint; savingsCents: bigint }
export interface NatureStackLayout { /* como CashflowLayout, con */ groups: { label: string; centerX: number; segments: { nature: 'recurrente' | 'extraordinario' | 'sin'; bar: ChartBar }[] }[]; savings: { x: number; y: number }[]; ticks: CashflowLayout['ticks']; plot: CashflowLayout['plot']; width: number; height: number; zeroY: number }
export function natureStackLayout(buckets: readonly NatureBucketInput[], size?: { width?: number; height?: number }): NatureStackLayout;

// breakdown.ts
export interface BreakdownRowInput { categoryId: string | null; name: string; parentId: string | null; totalCents: string }
export interface BreakdownGroup {
  id: string | null; name: string; totalCents: bigint; percent: number;
  subs: { name: string; totalCents: bigint; categoryId: string | null }[];
}
export function groupExpenseCategories(rows: readonly BreakdownRowInput[], categoryNameById: ReadonlyMap<string, string>): BreakdownGroup[];
export function categoryPath(categories: readonly { id: string; name: string; parentId: string | null }[], id: string): string; // 'Casa › Supermercado'
```

**Pasos:**

- [ ] **Step 1: Test que falla.** `apps/web/tests/finance-charts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { categoryPath, groupExpenseCategories } from '../src/lib/finance/breakdown';
import { cashflowLayout, natureStackLayout, niceCeil, sparklinePoints } from '../src/lib/finance/chart-geometry';

describe('sparkline: la geometría exacta del original (viewBox 100×32)', () => {
  it('dos valores: primero abajo (y=28), último arriba (y=4)', () => {
    expect(sparklinePoints([0, 1])).toBe('0,28 100,4');
  });
  it('con menos de dos valores no hay línea', () => {
    expect(sparklinePoints([5])).toBe('');
  });
});

describe('niceCeil: pasos redondos 1/2/5', () => {
  it('sube al siguiente valor bonito', () => {
    expect(niceCeil(870)).toBe(1000);
    expect(niceCeil(140)).toBe(200);
    expect(niceCeil(45)).toBe(50);
    expect(niceCeil(0)).toBe(1);
  });
});

describe('cashflowLayout: barras + línea de ahorro', () => {
  const buckets = [
    { bucket: '2026-01', incomeCents: 400000n, expenseCents: -300000n, savingsCents: 100000n },
    { bucket: '2026-02', incomeCents: 200000n, expenseCents: -150000n, savingsCents: 50000n }
  ];
  const layout = cashflowLayout(buckets);

  it('el gasto se pinta en valor absoluto y el ingreso doble mide el doble', () => {
    const [january, february] = layout.groups;
    expect(january!.expense.height).toBeGreaterThan(0);
    expect(january!.income.height / february!.income.height).toBeCloseTo(2, 5);
  });
  it('sin valores negativos, la línea de cero es el suelo del área de dibujo', () => {
    expect(layout.zeroY).toBeCloseTo(layout.plot.bottom, 5);
  });
  it('los ticks incluyen el cero y sus etiquetas son euros enteros', () => {
    expect(layout.ticks.some((tick) => tick.value === 0)).toBe(true);
    expect(layout.ticks.every((tick) => /€$/.test(tick.label))).toBe(true);
  });
  it('hay un punto de ahorro por cubo y los grupos avanzan en x', () => {
    expect(layout.savings).toHaveLength(2);
    expect(layout.groups[1]!.centerX).toBeGreaterThan(layout.groups[0]!.centerX);
    expect(layout.groups[0]!.label).toBe('ene 26');
  });
});

describe('natureStackLayout: apilado por naturaleza', () => {
  it('los segmentos apilados suman la altura del gasto total del cubo', () => {
    const layout = natureStackLayout([
      { bucket: '2026-01', recurringCents: -200000n, extraordinaryCents: -80000n, unclassifiedCents: -20000n, savingsCents: 50000n }
    ]);
    const segments = layout.groups[0]!.segments;
    expect(segments.map((segment) => segment.nature)).toEqual(['recurrente', 'extraordinario', 'sin']);
    const total = segments.reduce((acc, segment) => acc + segment.bar.height, 0);
    const one = cashflowLayout([{ bucket: '2026-01', incomeCents: 300000n, expenseCents: -300000n, savingsCents: 0n }]);
    expect(total).toBeCloseTo(one.groups[0]!.expense.height, 1);
  });
});

describe('groupExpenseCategories: el groupByParent del original', () => {
  const names = new Map([['p1', 'Casa'], ['c1', 'Supermercado']]);
  it('solo gastos, agrupados por padre, ordenados del más gastado; (general) para el padre suelto', () => {
    const groups = groupExpenseCategories([
      { categoryId: 'c1', name: 'Supermercado', parentId: 'p1', totalCents: '-50000' },
      { categoryId: 'p1', name: 'Casa', parentId: null, totalCents: '-10000' },
      { categoryId: null, name: 'Sin categorizar', parentId: null, totalCents: '-70000' },
      { categoryId: 'c9', name: 'Nómina', parentId: null, totalCents: '425000' }
    ], names);
    expect(groups.map((group) => group.name)).toEqual(['Sin categorizar', 'Casa']);
    expect(groups[1]!.totalCents).toBe(-60000n);
    expect(groups[1]!.subs.map((sub) => sub.name)).toEqual(['Supermercado', '(general)']);
    expect(groups[0]!.percent).toBe(100);
  });
});

describe('categoryPath', () => {
  it('encadena padre e hija', () => {
    const categories = [
      { id: 'p1', name: 'Casa', parentId: null },
      { id: 'c1', name: 'Supermercado', parentId: 'p1' }
    ];
    expect(categoryPath(categories, 'c1')).toBe('Casa › Supermercado');
    expect(categoryPath(categories, 'p1')).toBe('Casa');
  });
});
```

- [ ] **Step 2: Falla.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-charts.test.ts` — módulos inexistentes.
- [ ] **Step 3: Implementa `chart-geometry.ts`.**

```ts
/**
 * Geometría PURA de las gráficas SVG artesanales (§8: sin librería de charts).
 * Porta las proporciones de los componentes recharts del origen: CashflowChart
 * (alto 280, eje Y de 70 px, barras agrupadas) y el Sparkline de ui.tsx
 * (viewBox 100×32). Los céntimos solo se convierten a Number para calcular
 * PÍXELES; el dinero de verdad nunca sale de bigint.
 */
import { axisEuro, bucketLabel } from './format';

export interface ChartBar { x: number; y: number; width: number; height: number }

export function sparklinePoints(values: readonly number[]): string {
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((value, index) => `${(index / (values.length - 1)) * 100},${28 - ((value - min) / range) * 24}`)
    .join(' ');
}

/** El siguiente «valor bonito» (1/2/5 × 10^n) por encima de value. */
export function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const multiplier of [1, 2, 5, 10]) {
    if (multiplier * power >= value) return multiplier * power;
  }
  return 10 * power;
}

const eurosOf = (cents: bigint): number => Number(cents) / 100;

interface Frame {
  width: number; height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  ticks: { value: number; y: number; label: string }[];
  zeroY: number;
  y: (value: number) => number;
  slot: number;
}

function frameFor(values: number[], bucketCount: number, size: { width?: number; height?: number }): Frame {
  const width = size.width ?? 720;
  const height = size.height ?? 280;
  const plot = { left: 70, right: width - 8, top: 8, bottom: height - 24 };
  const rawMax = Math.max(0, ...values);
  const rawMin = Math.min(0, ...values);
  const step = niceCeil(Math.max(rawMax - rawMin, 1) / 4);
  const max = Math.ceil(rawMax / step) * step || step;
  const min = Math.floor(rawMin / step) * step;
  const y = (value: number): number => plot.top + ((max - value) / (max - min)) * (plot.bottom - plot.top);
  const ticks: Frame['ticks'] = [];
  for (let value = min; value <= max; value += step) {
    ticks.push({ value, y: y(value), label: axisEuro(BigInt(Math.round(value)) * 100n) });
  }
  return { width, height, plot, ticks, zeroY: y(0), y, slot: (plot.right - plot.left) / Math.max(bucketCount, 1) };
}

export interface CashflowBucketInput { bucket: string; incomeCents: bigint; expenseCents: bigint; savingsCents: bigint }
export interface CashflowLayout {
  width: number; height: number;
  plot: Frame['plot']; ticks: Frame['ticks']; zeroY: number;
  groups: { label: string; centerX: number; income: ChartBar; expense: ChartBar }[];
  savings: { x: number; y: number }[];
}

export function cashflowLayout(
  buckets: readonly CashflowBucketInput[],
  size: { width?: number; height?: number } = {}
): CashflowLayout {
  const values = buckets.flatMap((bucket) => [
    eurosOf(bucket.incomeCents), Math.abs(eurosOf(bucket.expenseCents)), eurosOf(bucket.savingsCents)
  ]);
  const frame = frameFor(values, buckets.length, size);
  const barWidth = Math.max((frame.slot * 0.6 - 2) / 2, 2);
  const bar = (centerOffset: number, index: number, euros: number): ChartBar => {
    const centerX = frame.plot.left + frame.slot * (index + 0.5);
    const top = frame.y(Math.abs(euros));
    return { x: centerX + centerOffset, y: top, width: barWidth, height: frame.zeroY - top };
  };
  return {
    width: frame.width, height: frame.height, plot: frame.plot, ticks: frame.ticks, zeroY: frame.zeroY,
    groups: buckets.map((bucket, index) => ({
      label: bucketLabel(bucket.bucket),
      centerX: frame.plot.left + frame.slot * (index + 0.5),
      income: bar(-barWidth - 1, index, eurosOf(bucket.incomeCents)),
      expense: bar(1, index, eurosOf(bucket.expenseCents))
    })),
    savings: buckets.map((bucket, index) => ({
      x: frame.plot.left + frame.slot * (index + 0.5),
      y: frame.y(eurosOf(bucket.savingsCents))
    }))
  };
}

export interface NatureBucketInput { bucket: string; recurringCents: bigint; extraordinaryCents: bigint; unclassifiedCents: bigint; savingsCents: bigint }
export interface NatureStackLayout {
  width: number; height: number; plot: Frame['plot']; ticks: Frame['ticks']; zeroY: number;
  groups: { label: string; centerX: number; segments: { nature: 'recurrente' | 'extraordinario' | 'sin'; bar: ChartBar }[] }[];
  savings: { x: number; y: number }[];
}

/** Gasto apilado por naturaleza (♻/✦/—) + línea de ahorro, para Analítica (fase 6). */
export function natureStackLayout(
  buckets: readonly NatureBucketInput[],
  size: { width?: number; height?: number } = {}
): NatureStackLayout {
  const totals = buckets.map((bucket) =>
    Math.abs(eurosOf(bucket.recurringCents)) + Math.abs(eurosOf(bucket.extraordinaryCents)) + Math.abs(eurosOf(bucket.unclassifiedCents)));
  const frame = frameFor(
    [...totals, ...buckets.map((bucket) => eurosOf(bucket.savingsCents))],
    buckets.length, size
  );
  const barWidth = Math.max(frame.slot * 0.5, 4);
  return {
    width: frame.width, height: frame.height, plot: frame.plot, ticks: frame.ticks, zeroY: frame.zeroY,
    groups: buckets.map((bucket, index) => {
      const centerX = frame.plot.left + frame.slot * (index + 0.5);
      const pieces: [NatureStackLayout['groups'][number]['segments'][number]['nature'], number][] = [
        ['recurrente', Math.abs(eurosOf(bucket.recurringCents))],
        ['extraordinario', Math.abs(eurosOf(bucket.extraordinaryCents))],
        ['sin', Math.abs(eurosOf(bucket.unclassifiedCents))]
      ];
      let floor = frame.zeroY;
      const segments = pieces.map(([nature, euros]) => {
        const height = frame.zeroY - frame.y(euros);
        floor -= height;
        return { nature, bar: { x: centerX - barWidth / 2, y: floor, width: barWidth, height } };
      });
      return { label: bucketLabel(bucket.bucket), centerX, segments };
    }),
    savings: buckets.map((bucket, index) => ({
      x: frame.plot.left + frame.slot * (index + 0.5),
      y: frame.y(eurosOf(bucket.savingsCents))
    }))
  };
}
```

- [ ] **Step 4: Implementa `breakdown.ts`.**

```ts
/**
 * Agrupación del desglose por categoría (porta groupByParent del origen,
 * CategoryBreakdown.tsx): solo gastos, agrupados por categoría padre,
 * ordenados del más gastado, con «(general)» para el importe del propio padre.
 * Los porcentajes de barra se calculan en bigint: sin floats sobre dinero.
 */
export interface BreakdownRowInput { categoryId: string | null; name: string; parentId: string | null; totalCents: string }

export interface BreakdownGroup {
  id: string | null;
  name: string;
  totalCents: bigint;
  /** Ancho de la barra: |total| del grupo sobre el |total| máximo, 0–100. */
  percent: number;
  subs: { name: string; totalCents: bigint; categoryId: string | null }[];
}

export function groupExpenseCategories(
  rows: readonly BreakdownRowInput[],
  categoryNameById: ReadonlyMap<string, string>
): BreakdownGroup[] {
  const groups = new Map<string | null, BreakdownGroup>();
  for (const row of rows) {
    const total = BigInt(row.totalCents);
    if (total >= 0n) continue; // solo gastos (contrato del original)
    const parentId = row.parentId ?? row.categoryId;
    const name = parentId === null ? 'Sin categorizar' : (categoryNameById.get(parentId) ?? '?');
    const group = groups.get(parentId) ?? { id: parentId, name, totalCents: 0n, percent: 0, subs: [] };
    group.totalCents += total;
    group.subs.push({
      name: row.parentId === null && row.categoryId !== null ? '(general)' : row.name,
      totalCents: total,
      categoryId: row.categoryId
    });
    groups.set(parentId, group);
  }
  const ascending = (left: bigint, right: bigint): number => (left < right ? -1 : left > right ? 1 : 0);
  const list = [...groups.values()].sort((a, b) => ascending(a.totalCents, b.totalCents));
  const maxAbs = list.reduce((acc, group) => {
    const abs = group.totalCents < 0n ? -group.totalCents : group.totalCents;
    return abs > acc ? abs : acc;
  }, 1n);
  return list.map((group) => ({
    ...group,
    percent: Number(((group.totalCents < 0n ? -group.totalCents : group.totalCents) * 100n) / maxAbs),
    subs: [...group.subs].sort((a, b) => ascending(a.totalCents, b.totalCents))
  }));
}

/** 'Casa › Supermercado' para selects y chips (porta categoryPath del origen). */
export function categoryPath(
  categories: readonly { id: string; name: string; parentId: string | null }[],
  id: string
): string {
  const category = categories.find((candidate) => candidate.id === id);
  if (!category) return '?';
  if (category.parentId === null) return category.name;
  const parent = categories.find((candidate) => candidate.id === category.parentId);
  return parent ? `${parent.name} › ${category.name}` : category.name;
}
```

- [ ] **Step 5: En verde.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-charts.test.ts`
- [ ] **Step 6: Commit.** `git add apps/web/src/lib/finance/chart-geometry.ts apps/web/src/lib/finance/breakdown.ts apps/web/tests/finance-charts.test.ts && git commit -m "feat(finanzas): geometría pura de las gráficas SVG y agrupación del desglose"`

---

### Task 4: Stub de estado del pivot (`$lib/finance/pivot-state.ts`)

**Files:**
- Create: `apps/web/src/lib/finance/pivot-state.ts`
- Test: `apps/web/tests/finance-pivot-state.test.ts`

**Interfaces:**
- Consumes: `PivotDimension` de `@casa-clara/domain` (canónico, fase 2: `"cat" | "sub" | "nat" | "prov" | "concept" | "movement"`), solo `import type`.
- Produces (stub: la fase 6 lo amplía; el contrato de URL — clave `dims`, CSV — queda fijado aquí):

```ts
export const PIVOT_DIMENSIONS: readonly PivotDimension[];
export const DEFAULT_DIMS: readonly PivotDimension[]; // ['cat', 'sub']
export function parseDims(value: string | null): PivotDimension[];       // filtra inválidos y duplicados; vacío → DEFAULT_DIMS
export function serializeDims(dims: readonly PivotDimension[]): string | null; // null cuando es el orden por defecto (URL limpia)
```

**Pasos:**

- [ ] **Step 1: Test que falla.** `apps/web/tests/finance-pivot-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { DEFAULT_DIMS, parseDims, serializeDims } from '../src/lib/finance/pivot-state';

describe('pivot-state (stub, contrato de la clave dims)', () => {
  it('parsea el CSV descartando dimensiones desconocidas y duplicadas', () => {
    expect(parseDims('prov,cat,bogus,cat')).toEqual(['prov', 'cat']);
  });
  it('vacío o null caen al orden por defecto', () => {
    expect(parseDims(null)).toEqual([...DEFAULT_DIMS]);
    expect(parseDims('')).toEqual([...DEFAULT_DIMS]);
  });
  it('serializa a CSV y devuelve null para el orden por defecto (URL limpia)', () => {
    expect(serializeDims(['prov', 'cat'])).toBe('prov,cat');
    expect(serializeDims([...DEFAULT_DIMS])).toBeNull();
    expect(parseDims(serializeDims(['nat', 'concept']))).toEqual(['nat', 'concept']);
  });
});
```

- [ ] **Step 2: Falla.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-pivot-state.test.ts`
- [ ] **Step 3: Implementación.** `apps/web/src/lib/finance/pivot-state.ts`:

```ts
/**
 * STUB del estado del pivot de Analítica. La fase 6 construye aquí las
 * dimensiones reordenables, la selección y el resto del estado; esta fase
 * solo fija el contrato de URL de la clave `dims` (CSV de dimensiones, del
 * doc de interfaces) para que filters.ts ya la conserve en el merge.
 */
import type { PivotDimension } from '@casa-clara/domain';

export const PIVOT_DIMENSIONS: readonly PivotDimension[] = ['cat', 'sub', 'nat', 'prov', 'concept', 'movement'];

export const DEFAULT_DIMS: readonly PivotDimension[] = ['cat', 'sub'];

export function parseDims(value: string | null): PivotDimension[] {
  const parsed = (value ?? '')
    .split(',')
    .map((piece) => piece.trim())
    .filter((piece): piece is PivotDimension => (PIVOT_DIMENSIONS as readonly string[]).includes(piece));
  const unique = [...new Set(parsed)];
  return unique.length > 0 ? unique : [...DEFAULT_DIMS];
}

export function serializeDims(dims: readonly PivotDimension[]): string | null {
  if (dims.length === DEFAULT_DIMS.length && dims.every((dim, index) => dim === DEFAULT_DIMS[index])) return null;
  return dims.join(',');
}
```

- [ ] **Step 4: En verde.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-pivot-state.test.ts`
- [ ] **Step 5: Commit.** `git add apps/web/src/lib/finance/pivot-state.ts apps/web/tests/finance-pivot-state.test.ts && git commit -m "feat(finanzas): stub de pivot-state con el contrato de la clave dims"`

---

### Task 5: Lecturas SQL — transacciones y catálogos (`packages/server/src/finance/queries.ts`)

**Files:**
- Create: `packages/server/src/finance/queries.ts`
- Modify: `packages/server/src/index.ts` (añadir `export * from "./finance/queries.js";` en orden alfabético, entre `commands/wiki.js` y `database.js` — sigue el estilo del fichero)
- Test: `packages/server/src/finance/queries.test.ts` (puro, sin BD)
- Test: `packages/server/src/finance/queries.integration.test.ts` (Postgres real, `describe.runIf`)

**Interfaces:**
- Consumes: esquema `0034_finance.sql` (fase 1): tablas `app.finance_transactions`, `app.finance_accounts`, `app.finance_categories`, `app.finance_events`, `app.finance_transaction_events`, `app.finance_provider_aliases`, columnas del doc de interfaces §«Esquema SQL». `withAuthorizedTransaction`/`AuthorizationError` de `packages/server/src/database.ts`. Fixtures `packages/db/fixtures/002_finance.sql` (fase 1: datos en roble y olivo; concesión viva SOLO para el admin de roble).
- Produces (DTOs de cable, céntimos SIEMPRE como string; los consumen las tareas 7–9 y las fases 5–6):

```ts
export interface FinanceReadFilters { from: string; to: string; accountIds: string[]; eventId: string | null; excludeEventIds: string[] }
export interface FinanceAccountDto { id: string; name: string; bank: string; kind: string; ownerLabel: string; archived: boolean }
export interface FinanceCategoryDto { id: string; name: string; parentId: string | null; kind: string }
export interface FinanceEventDto { id: string; name: string }
export interface FinanceTxDto {
  id: string; accountId: string; accountName: string; opDate: string; valueDate: string | null;
  concept: string; provider: string | null; providerNorm: string | null; providerDisplay: string | null;
  amountCents: string; balanceCents: string | null; codeCommon: string | null; codeOwn: string | null;
  categoryId: string | null; categoryName: string | null; status: string; transferGroupId: string | null;
  recurrence: 'recurrente' | 'extraordinario' | null; recurrenceManual: boolean;
  bankCategory: string | null; eventIds: string[]; raw: Record<string, string> | null;
}
export interface FinanceTransactionsQuery extends FinanceReadFilters {
  q: string | null; categoryId: string | null; recurrence: 'recurrente' | 'extraordinario' | null;
  status: string | null; ids: string[]; groupIds: string[]; limit: number; offset: number;
}
export interface FinanceTransactionsPage { total: number; sumCents: string; limit: number; offset: number; rows: FinanceTxDto[] }
export function previousRange(from: string, to: string): { from: string; to: string };
export function seriesWindow(to: string, months: number): string;
export async function readFinanceAccounts(client: PoolClient, householdId: string): Promise<FinanceAccountDto[]>;
export async function readFinanceCategories(client: PoolClient, householdId: string): Promise<FinanceCategoryDto[]>;
export async function readFinanceEvents(client: PoolClient, householdId: string): Promise<FinanceEventDto[]>;
export async function readFinanceTransactions(client: PoolClient, householdId: string, query: FinanceTransactionsQuery): Promise<FinanceTransactionsPage>;
```

**Pasos:**

- [ ] **Step 1: Test puro que falla.** `packages/server/src/finance/queries.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { previousRange, seriesWindow } from "./queries.js";

describe("previousRange: el periodo anterior alineado a meses (porta _prev_range de reports.py)", () => {
  it("un bloque exacto de meses retrocede el mismo número de meses de calendario", () => {
    expect(previousRange("2026-01-01", "2026-06-30")).toEqual({ from: "2025-07-01", to: "2025-12-31" });
    expect(previousRange("2026-08-01", "2026-08-31")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });
  it("un rango arbitrario retrocede su número exacto de días", () => {
    expect(previousRange("2026-08-10", "2026-08-19")).toEqual({ from: "2026-07-31", to: "2026-08-09" });
  });
});

describe("seriesWindow: N cubos hacia atrás desde el final del rango", () => {
  it("empieza el día 1 del mes (months-1) meses antes", () => {
    expect(seriesWindow("2026-08-31", 12)).toBe("2025-09-01");
    expect(seriesWindow("2026-02-15", 1)).toBe("2026-02-01");
  });
});
```

- [ ] **Step 2: Falla.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/server test src/finance/queries.test.ts` — `Cannot find module './queries.js'`.
- [ ] **Step 3: Crea `queries.ts` (primera mitad).** Cabecera, tipos, helpers puros y las lecturas de esta tarea:

```ts
import type { PoolClient } from "pg";

/**
 * Lecturas SQL del módulo Finanzas (§7 de la spec), compartidas por los loads
 * de las páginas y por los endpoints GET /api/v1/finance/*. TODO corre dentro
 * de withAuthorizedTransaction: es la RLS (doble cerrojo de §4) quien decide
 * qué filas existen; estas consultas solo dan forma. Céntimos: bigint en SQL,
 * string en el DTO de cable, BigInt solo para operar. Jamás Number.
 */

export interface FinanceReadFilters {
  from: string;
  to: string;
  accountIds: string[];
  eventId: string | null;
  excludeEventIds: string[];
}

export interface FinanceAccountDto { id: string; name: string; bank: string; kind: string; ownerLabel: string; archived: boolean }
export interface FinanceCategoryDto { id: string; name: string; parentId: string | null; kind: string }
export interface FinanceEventDto { id: string; name: string }

export interface FinanceTxDto {
  id: string; accountId: string; accountName: string; opDate: string; valueDate: string | null;
  concept: string; provider: string | null; providerNorm: string | null; providerDisplay: string | null;
  amountCents: string; balanceCents: string | null; codeCommon: string | null; codeOwn: string | null;
  categoryId: string | null; categoryName: string | null; status: string; transferGroupId: string | null;
  recurrence: "recurrente" | "extraordinario" | null; recurrenceManual: boolean;
  bankCategory: string | null; eventIds: string[]; raw: Record<string, string> | null;
}

export interface FinanceTransactionsQuery extends FinanceReadFilters {
  q: string | null;
  categoryId: string | null;
  recurrence: "recurrente" | "extraordinario" | null;
  status: string | null;
  ids: string[];
  groupIds: string[];
  limit: number;
  offset: number;
}

export interface FinanceTransactionsPage {
  total: number;
  sumCents: string;
  limit: number;
  offset: number;
  rows: FinanceTxDto[];
}

// ── Helpers puros de rango ───────────────────────────────────────────────────

function splitIso(iso: string): [number, number, number] {
  const [year = 1970, month = 1, day = 1] = iso.split("-").map(Number);
  return [year, month, day];
}

function isoOf(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonths(year: number, month: number, delta: number): [number, number] {
  const index = year * 12 + (month - 1) + delta;
  return [Math.floor(index / 12), ((index % 12) + 12) % 12 + 1];
}

function addDays(iso: string, delta: number): string {
  const [year, month, day] = splitIso(iso);
  return new Date(Date.UTC(year, month - 1, day) + delta * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Periodo inmediatamente anterior a [from, to]. Bloques exactos de meses de
 * calendario retroceden en meses de calendario; el resto, en días (porta
 * _prev_range de reports.py: la comparativa de KPIs depende de esto).
 */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const [fromYear, fromMonth, fromDay] = splitIso(from);
  const [toYear, toMonth, toDay] = splitIso(to);
  if (fromDay === 1 && toDay === daysInMonth(toYear, toMonth)) {
    const span = (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
    const [startYear, startMonth] = addMonths(fromYear, fromMonth, -span);
    const [endYear, endMonth] = addMonths(fromYear, fromMonth, -1);
    return { from: isoOf(startYear, startMonth, 1), to: isoOf(endYear, endMonth, daysInMonth(endYear, endMonth)) };
  }
  const spanDays =
    Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86_400_000) + 1;
  return { from: addDays(from, -spanDays), to: addDays(from, -1) };
}

/** Día 1 del mes (months−1) meses antes del mes de `to`: la serie siempre mira hacia atrás. */
export function seriesWindow(to: string, months: number): string {
  const [year, month] = splitIso(to);
  const [startYear, startMonth] = addMonths(year, month, -(months - 1));
  return isoOf(startYear, startMonth, 1);
}

// ── Condiciones compartidas ──────────────────────────────────────────────────

interface SqlFilter { where: string; params: unknown[] }

/** Rango + cuentas + evento + exclusiones sobre el alias `tx` ($1 = householdId). */
function txConditions(householdId: string, filters: FinanceReadFilters): SqlFilter {
  const params: unknown[] = [householdId, filters.from, filters.to];
  const where: string[] = ["tx.household_id = $1", "tx.op_date >= $2", "tx.op_date <= $3"];
  if (filters.accountIds.length > 0) {
    params.push(filters.accountIds);
    where.push(`tx.account_id = any($${params.length}::uuid[])`);
  }
  if (filters.eventId) {
    params.push(filters.eventId);
    where.push(`exists (select 1 from app.finance_transaction_events te
                 where te.household_id = tx.household_id and te.transaction_id = tx.id
                   and te.event_id = $${params.length})`);
  }
  if (filters.excludeEventIds.length > 0) {
    params.push(filters.excludeEventIds);
    where.push(`not exists (select 1 from app.finance_transaction_events te
                 where te.household_id = tx.household_id and te.transaction_id = tx.id
                   and te.event_id = any($${params.length}::uuid[]))`);
  }
  return { where: where.join("\n     and "), params };
}

/**
 * Subconsulta con `kind` resuelto (el de la categoría; sin categoría, por el
 * signo) y SIN las patas de transferencia — el `_txs` del origen (reports.py).
 */
function kindedTx(where: string): string {
  return `
  select tx.*, case when cat.kind is not null then cat.kind::text
                    when tx.amount_cents > 0 then 'ingreso' else 'gasto' end as kind
    from app.finance_transactions tx
    left join app.finance_categories cat
      on cat.household_id = tx.household_id and cat.id = tx.category_id
   where ${where}
     and coalesce(cat.kind::text, '') <> 'transferencia'`;
}

// ── Catálogos ────────────────────────────────────────────────────────────────

export async function readFinanceAccounts(client: PoolClient, householdId: string): Promise<FinanceAccountDto[]> {
  const result = await client.query<FinanceAccountDto>(
    `select account.id, account.name, account.bank::text as "bank", account.kind::text as "kind",
            account.owner_label as "ownerLabel", (account.archived_at is not null) as "archived"
       from app.finance_accounts account
      where account.household_id = $1
      order by account.name`,
    [householdId],
  );
  return result.rows;
}

export async function readFinanceCategories(client: PoolClient, householdId: string): Promise<FinanceCategoryDto[]> {
  const result = await client.query<FinanceCategoryDto>(
    `select category.id, category.name, category.parent_id as "parentId", category.kind::text as "kind"
       from app.finance_categories category
      where category.household_id = $1
      order by category.parent_id nulls first, category.name`,
    [householdId],
  );
  return result.rows;
}

export async function readFinanceEvents(client: PoolClient, householdId: string): Promise<FinanceEventDto[]> {
  const result = await client.query<FinanceEventDto>(
    `select event.id, event.name from app.finance_events event
      where event.household_id = $1 order by lower(event.name)`,
    [householdId],
  );
  return result.rows;
}

// ── Movimientos con paginación explícita (§7: nunca truncar en silencio) ─────

export async function readFinanceTransactions(
  client: PoolClient,
  householdId: string,
  query: FinanceTransactionsQuery,
): Promise<FinanceTransactionsPage> {
  const byIds = query.ids.length > 0 || query.groupIds.length > 0;
  const params: unknown[] = [householdId];
  const where: string[] = ["tx.household_id = $1"];
  if (byIds) {
    // Petición exacta (panel de detalle): sin rango ni filtros de periodo.
    if (query.ids.length > 0) {
      params.push(query.ids);
      where.push(`tx.id = any($${params.length}::uuid[])`);
    }
    if (query.groupIds.length > 0) {
      params.push(query.groupIds);
      where.push(`tx.transfer_group_id = any($${params.length}::uuid[])`);
    }
  } else {
    const base = txConditions(householdId, query);
    params.length = 0;
    params.push(...base.params);
    where.length = 0;
    where.push(base.where);
  }
  if (query.q) {
    params.push(`%${query.q}%`);
    where.push(`(tx.concept ilike $${params.length} or tx.provider ilike $${params.length}
                 or coalesce(alias.display, '') ilike $${params.length})`);
  }
  if (query.categoryId) {
    params.push(query.categoryId);
    where.push(`tx.category_id = $${params.length}`);
  }
  if (query.recurrence) {
    params.push(query.recurrence);
    where.push(`tx.recurrence = $${params.length}`);
  }
  if (query.status) {
    params.push(query.status);
    where.push(`tx.status = $${params.length}`);
  }

  const fromSql = `
    from app.finance_transactions tx
    join app.finance_accounts account
      on account.household_id = tx.household_id and account.id = tx.account_id
    left join app.finance_categories cat
      on cat.household_id = tx.household_id and cat.id = tx.category_id
    left join app.finance_provider_aliases alias
      on alias.household_id = tx.household_id and alias.provider_norm = tx.provider_norm
   where ${where.join("\n     and ")}`;

  // Total y suma en consulta propia: con offset fuera de rango la página no
  // trae filas y aun así el total debe ser veraz (nunca truncar en silencio).
  const totals = await client.query<{ total: number; sumCents: string }>(
    `select count(*)::int as "total", coalesce(sum(tx.amount_cents), 0)::text as "sumCents" ${fromSql}`,
    params,
  );

  const page = await client.query<Omit<FinanceTxDto, "eventIds">>(
    `select tx.id, tx.account_id as "accountId", account.name as "accountName",
            tx.op_date::text as "opDate", tx.value_date::text as "valueDate",
            tx.concept, tx.provider, tx.provider_norm as "providerNorm",
            coalesce(alias.display, tx.provider) as "providerDisplay",
            tx.amount_cents::text as "amountCents", tx.balance_cents::text as "balanceCents",
            tx.code_common as "codeCommon", tx.code_own as "codeOwn",
            tx.category_id as "categoryId", cat.name as "categoryName",
            tx.status::text as "status", tx.transfer_group_id as "transferGroupId",
            tx.recurrence::text as "recurrence", tx.recurrence_manual as "recurrenceManual",
            tx.bank_category as "bankCategory", tx.raw
       ${fromSql}
      order by tx.op_date desc, tx.id desc
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, query.limit, query.offset],
  );

  const txIds = page.rows.map((row) => row.id);
  const eventsByTx = new Map<string, string[]>();
  if (txIds.length > 0) {
    const events = await client.query<{ transactionId: string; eventId: string }>(
      `select te.transaction_id as "transactionId", te.event_id as "eventId"
         from app.finance_transaction_events te
        where te.household_id = $1 and te.transaction_id = any($2::uuid[])`,
      [householdId, txIds],
    );
    for (const row of events.rows) {
      const list = eventsByTx.get(row.transactionId) ?? [];
      list.push(row.eventId);
      eventsByTx.set(row.transactionId, list);
    }
  }

  return {
    total: totals.rows[0]?.total ?? 0,
    sumCents: totals.rows[0]?.sumCents ?? "0",
    limit: query.limit,
    offset: query.offset,
    rows: page.rows.map((row) => ({ ...row, eventIds: eventsByTx.get(row.id) ?? [] }) as FinanceTxDto),
  };
}
```

Nota para ti: `kindedTx` y `txConditions` quedan sin usar hasta la Task 6 — expórtalos NO; si eslint protesta por «unused», añádelos ya con la Task 6 en mente o marca `// eslint-disable-next-line` temporal y retíralo en la Task 6 (mejor: implementa Task 6 antes de correr `pnpm lint`). Añade también el export en `packages/server/src/index.ts`.

- [ ] **Step 4: Puro en verde.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/server test src/finance/queries.test.ts`
- [ ] **Step 5: Test de integración que falla.** `packages/server/src/finance/queries.integration.test.ts` (patrón de `packages/server/src/employment.integration.test.ts`: el global setup ya migró 0001–0034 y cargó `fixtures/*.sql`, incluida `002_finance.sql`, y creó el rol `it_casa_clara_app_login`):

```ts
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, withAuthorizedTransaction } from "../database.js";
import {
  readFinanceAccounts,
  readFinanceTransactions,
  type FinanceTransactionsQuery,
} from "./queries.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = "it_casa_clara_app_login";
const ROBLE = "10000000-0000-4000-8000-000000000001";
const OLIVO = "20000000-0000-4000-8000-000000000001";

const WIDE: FinanceTransactionsQuery = {
  from: "2020-01-01", to: "2030-12-31", accountIds: [], eventId: null, excludeEventIds: [],
  q: null, categoryId: null, recurrence: null, status: null, ids: [], groupIds: [],
  limit: 1000, offset: 0,
};

describe.runIf(Boolean(adminUrl))("lecturas de finanzas bajo RLS (fase 4, doble cerrojo de §4)", () => {
  let appPool: pg.Pool;

  beforeAll(() => {
    const url = new URL(adminUrl!);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
  });

  const as = <T>(userId: string, householdId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> =>
    withAuthorizedTransaction(appPool, { userId }, householdId, (client) => fn(client));

  it("el admin de roble CON concesión ve cuentas y movimientos de su hogar", async () => {
    const accounts = await as("fixture:roble:admin", ROBLE, (client) => readFinanceAccounts(client, ROBLE));
    expect(accounts.length).toBeGreaterThan(0);
    const page = await as("fixture:roble:admin", ROBLE, (client) => readFinanceTransactions(client, ROBLE, WIDE));
    expect(page.total).toBeGreaterThan(0);
    for (const row of page.rows) {
      expect(row.amountCents).toMatch(/^-?\d+$/);
      expect(row.accountName.length).toBeGreaterThan(0);
    }
  });

  it("la paginación explícita conserva el total: nunca truncar en silencio", async () => {
    const all = await as("fixture:roble:admin", ROBLE, (client) => readFinanceTransactions(client, ROBLE, WIDE));
    const second = await as("fixture:roble:admin", ROBLE, (client) =>
      readFinanceTransactions(client, ROBLE, { ...WIDE, limit: 1, offset: 1 }));
    expect(second.total).toBe(all.total);
    expect(second.sumCents).toBe(all.sumCents);
    if (all.total > 1) {
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0]!.id).toBe(all.rows[1]!.id);
    }
    const beyond = await as("fixture:roble:admin", ROBLE, (client) =>
      readFinanceTransactions(client, ROBLE, { ...WIDE, offset: all.total + 100 }));
    expect(beyond.rows).toHaveLength(0);
    expect(beyond.total).toBe(all.total);
  });

  it("el admin de olivo SIN concesión ve cero filas aunque su hogar tiene datos", async () => {
    const accounts = await as("fixture:olivo:admin", OLIVO, (client) => readFinanceAccounts(client, OLIVO));
    expect(accounts).toEqual([]);
    const page = await as("fixture:olivo:admin", OLIVO, (client) => readFinanceTransactions(client, OLIVO, WIDE));
    expect(page.total).toBe(0);
  });

  it("empleada, apoyo y visor de roble ven cero filas por rol", async () => {
    for (const userId of ["fixture:roble:employee", "fixture:roble:helper", "fixture:roble:viewer"]) {
      const page = await as(userId, ROBLE, (client) => readFinanceTransactions(client, ROBLE, WIDE));
      expect(page.total).toBe(0);
    }
  });

  it("cruzar de hogar sin membresía es AuthorizationError, no un hogar vacío", async () => {
    await expect(
      as("fixture:roble:admin", OLIVO, (client) => readFinanceAccounts(client, OLIVO)),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
```

- [ ] **Step 6: Integración en verde.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL=${TEST_DATABASE_URL:-postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_wt_u} pnpm --filter @casa-clara/server test src/finance/queries.integration.test.ts` (primera pasada: falla — típicamente por columnas mal nombradas; corrige contra `packages/db/migrations/0034_finance.sql`, que ya está en el worktree, hasta verde).
- [ ] **Step 7: Commit.** `git add packages/server/src/finance/queries.ts packages/server/src/finance/queries.test.ts packages/server/src/finance/queries.integration.test.ts packages/server/src/index.ts && git commit -m "feat(finanzas): lecturas SQL de movimientos y catalogos con paginacion explicita bajo RLS"`

---

### Task 6: Lecturas SQL — summary, series, breakdown, providers y eventos

**Files:**
- Modify: `packages/server/src/finance/queries.ts`
- Test: `packages/server/src/finance/queries.integration.test.ts` (ampliar)

**Interfaces:**
- Consumes (canónicos, fase 2, desde `@casa-clara/domain`): `computeRangeSummary(txs: FinanceTxView[], opts: SummaryOptions): RangeSummary`, tipos `FinanceTxView`, `RangeSummary`, `SummaryOptions`. IMPORTANTE: los CAMPOS de `SummaryOptions` los fija `packages/domain/src/finance/types.ts` (ya está en el worktree): ábrelo antes de escribir la llamada y usa SUS nombres; lo que `queries.ts` debe procurarle, se llame como se llame allí, es: el rango [from, to], las cuentas del hogar (para inversión y aportaciones), las categorías (para el kind), el filtro de cuentas, los ids de transacciones del evento filtrado y de los excluidos, y el `pendingCount` global. La firma canónica de `computeRangeSummary` NO cambia jamás.
- Produces:

```ts
export interface FinanceSummaryDto {
  incomeCents: string; expenseCents: string; recurringExpenseCents: string;
  extraordinaryExpenseCents: string; unclassifiedExpenseCents: string;
  savingsCents: string; netSavingsRate: number | null; grossSavingsRate: number | null;
  investedCents: string; investmentRate: number | null;
  freeCashFlowCents: string; opsCashFlowCents: string;
  receivedContributionsCents: string; outgoingTransfersCents: string;
  pendingCount: number; prev: FinanceSummaryDto | null;
}
export interface FinanceSeriesPointDto { bucket: string; incomeCents: string; expenseCents: string; savingsCents: string }
export interface FinanceCategoryRowDto { categoryId: string | null; name: string; parentId: string | null; totalCents: string; count: number }
export interface FinanceProviderRowDto { provider: string; providerDisplay: string; totalCents: string; count: number }
export interface FinanceEventSummaryDto { id: string; name: string; incomeCents: string; expenseCents: string; netCents: string; txCount: number }
export interface FinanceEventDetailDto extends FinanceEventSummaryDto { categories: FinanceCategoryRowDto[] }
export function serializeRangeSummary(summary: RangeSummary): FinanceSummaryDto;
export async function readFinanceSummary(client: PoolClient, householdId: string, filters: FinanceReadFilters): Promise<FinanceSummaryDto>;
export async function readFinanceSeries(client: PoolClient, householdId: string, filters: FinanceReadFilters, granularity: 'month' | 'quarter' | 'year', months?: number): Promise<FinanceSeriesPointDto[]>;
export async function readFinanceBreakdown(client: PoolClient, householdId: string, filters: FinanceReadFilters): Promise<FinanceCategoryRowDto[]>;
export async function readFinanceProviders(client: PoolClient, householdId: string, filters: FinanceReadFilters, limit?: number): Promise<FinanceProviderRowDto[]>;
export async function readFinanceEventsSummary(client: PoolClient, householdId: string, filters: FinanceReadFilters): Promise<FinanceEventSummaryDto[]>;
export async function readFinanceEventDetail(client: PoolClient, householdId: string, eventId: string, filters: FinanceReadFilters): Promise<FinanceEventDetailDto | null>;
```

**Pasos:**

- [ ] **Step 1: Amplía el test de integración (falla).** Añade al `describe.runIf` existente:

```ts
const RANGE = { from: "2020-01-01", to: "2030-12-31", accountIds: [], eventId: null, excludeEventIds: [] };

it("summary: ahorro = ingresos + gastos, con periodo anterior y pendientes", async () => {
  const summary = await as("fixture:roble:admin", ROBLE, (client) => readFinanceSummary(client, ROBLE, RANGE));
  expect(BigInt(summary.savingsCents)).toBe(BigInt(summary.incomeCents) + BigInt(summary.expenseCents));
  expect(
    BigInt(summary.recurringExpenseCents) + BigInt(summary.extraordinaryExpenseCents) + BigInt(summary.unclassifiedExpenseCents),
  ).toBe(BigInt(summary.expenseCents));
  expect(summary.prev).not.toBeNull();
  expect(summary.pendingCount).toBeGreaterThanOrEqual(0);
});

it("series: cubos ordenados, ahorro coherente por cubo", async () => {
  const series = await as("fixture:roble:admin", ROBLE, (client) =>
    readFinanceSeries(client, ROBLE, RANGE, "month", 120));
  expect(series.length).toBeGreaterThan(0);
  for (const point of series) {
    expect(BigInt(point.savingsCents)).toBe(BigInt(point.incomeCents) + BigInt(point.expenseCents));
  }
  expect([...series.map((point) => point.bucket)].sort()).toEqual(series.map((point) => point.bucket));
});

it("breakdown: ordenado del gasto mayor (más negativo) al menor", async () => {
  const rows = await as("fixture:roble:admin", ROBLE, (client) => readFinanceBreakdown(client, ROBLE, RANGE));
  const totals = rows.map((row) => BigInt(row.totalCents));
  expect([...totals].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(totals);
});

it("providers: solo gasto, respeta el limit", async () => {
  const rows = await as("fixture:roble:admin", ROBLE, (client) => readFinanceProviders(client, ROBLE, RANGE, 3));
  expect(rows.length).toBeLessThanOrEqual(3);
  for (const row of rows) {
    expect(BigInt(row.totalCents)).toBeLessThan(0n);
    expect(row.providerDisplay.length).toBeGreaterThan(0);
  }
});

it("events-summary: net = income + expense; event-detail inexistente → null", async () => {
  const events = await as("fixture:roble:admin", ROBLE, (client) => readFinanceEventsSummary(client, ROBLE, RANGE));
  for (const event of events) {
    expect(BigInt(event.netCents)).toBe(BigInt(event.incomeCents) + BigInt(event.expenseCents));
  }
  const missing = await as("fixture:roble:admin", ROBLE, (client) =>
    readFinanceEventDetail(client, ROBLE, "00000000-0000-4000-8000-00000000dead", RANGE));
  expect(missing).toBeNull();
});

it("summary para el admin de olivo sin concesión: todo a cero", async () => {
  const summary = await as("fixture:olivo:admin", OLIVO, (client) => readFinanceSummary(client, OLIVO, RANGE));
  expect(summary.incomeCents).toBe("0");
  expect(summary.expenseCents).toBe("0");
  expect(summary.pendingCount).toBe(0);
});
```

Añade los imports nuevos (`readFinanceSummary`, `readFinanceSeries`, `readFinanceBreakdown`, `readFinanceProviders`, `readFinanceEventsSummary`, `readFinanceEventDetail`) al import de `./queries.js`.

- [ ] **Step 2: Falla.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL=${TEST_DATABASE_URL:-postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_wt_u} pnpm --filter @casa-clara/server test src/finance/queries.integration.test.ts` — `readFinanceSummary is not a function` (o error de import).
- [ ] **Step 3: Implementa las lecturas agregadas en `queries.ts`.** Añade al final del fichero:

```ts
import { computeRangeSummary, type RangeSummary, type SummaryOptions } from "@casa-clara/domain";
// (mueve este import a la cabecera del fichero, junto al de pg)

export interface FinanceSummaryDto { /* … la interfaz del bloque Interfaces … */ }

/** RangeSummary (bigint, canónico de fase 2) → DTO de cable (céntimos-string). */
export function serializeRangeSummary(summary: RangeSummary): FinanceSummaryDto {
  return {
    incomeCents: summary.incomeCents.toString(),
    expenseCents: summary.expenseCents.toString(),
    recurringExpenseCents: summary.recurringExpenseCents.toString(),
    extraordinaryExpenseCents: summary.extraordinaryExpenseCents.toString(),
    unclassifiedExpenseCents: summary.unclassifiedExpenseCents.toString(),
    savingsCents: summary.savingsCents.toString(),
    netSavingsRate: summary.netSavingsRate,
    grossSavingsRate: summary.grossSavingsRate,
    investedCents: summary.investedCents.toString(),
    investmentRate: summary.investmentRate,
    freeCashFlowCents: summary.freeCashFlowCents.toString(),
    opsCashFlowCents: summary.opsCashFlowCents.toString(),
    receivedContributionsCents: summary.receivedContributionsCents.toString(),
    outgoingTransfersCents: summary.outgoingTransfersCents.toString(),
    pendingCount: summary.pendingCount,
    prev: summary.prev ? serializeRangeSummary(summary.prev) : null,
  };
}

export async function readFinanceSummary(
  client: PoolClient,
  householdId: string,
  filters: FinanceReadFilters,
): Promise<FinanceSummaryDto> {
  // Ventana completa (periodo anterior + actual) y SIN excluir transferencias:
  // el dominio necesita las patas internas para inversión y aportaciones.
  const window = previousRange(filters.from, filters.to);
  const params: unknown[] = [householdId, window.from, filters.to];
  const conditions = ["tx.household_id = $1", "tx.op_date >= $2", "tx.op_date <= $3"];
  if (filters.accountIds.length > 0) {
    params.push(filters.accountIds);
    conditions.push(`tx.account_id = any($${params.length}::uuid[])`);
  }
  const txResult = await client.query<{
    id: string; accountId: string; opDate: string; concept: string; provider: string | null;
    providerNorm: string | null; amountCents: string; categoryId: string | null; status: string;
    transferGroupId: string | null; recurrence: "recurrente" | "extraordinario" | null;
    recurrenceManual: boolean; dedupHash: string;
  }>(
    `select tx.id, tx.account_id as "accountId", tx.op_date::text as "opDate", tx.concept,
            tx.provider, tx.provider_norm as "providerNorm", tx.amount_cents::text as "amountCents",
            tx.category_id as "categoryId", tx.status::text as "status",
            tx.transfer_group_id as "transferGroupId", tx.recurrence::text as "recurrence",
            tx.recurrence_manual as "recurrenceManual", tx.dedup_hash as "dedupHash"
       from app.finance_transactions tx
      where ${conditions.join("\n        and ")}`,
    params,
  );
  const txViews = txResult.rows.map((row) => ({ ...row, amountCents: BigInt(row.amountCents) }));

  const accounts = await readFinanceAccounts(client, householdId);
  const categories = await readFinanceCategories(client, householdId);
  const eventTxIds = filters.eventId
    ? (await client.query<{ id: string }>(
        `select transaction_id as "id" from app.finance_transaction_events
          where household_id = $1 and event_id = $2`, [householdId, filters.eventId])).rows.map((row) => row.id)
    : [];
  const excludedTxIds = filters.excludeEventIds.length > 0
    ? (await client.query<{ id: string }>(
        `select transaction_id as "id" from app.finance_transaction_events
          where household_id = $1 and event_id = any($2::uuid[])`, [householdId, filters.excludeEventIds])).rows.map((row) => row.id)
    : [];
  const pending = await client.query<{ n: number }>(
    `select count(*)::int as "n" from app.finance_transactions
      where household_id = $1 and status in ('pendiente', 'sugerida_regla', 'sugerida_agente')`,
    [householdId],
  );

  // ATENCIÓN: los nombres de los campos de SummaryOptions los fija
  // packages/domain/src/finance/types.ts (fase 2). Si `pnpm --filter
  // @casa-clara/server typecheck` acusa un nombre distinto, renombra AQUÍ el
  // campo del objeto (nunca el de types.ts): la firma computeRangeSummary(txs,
  // opts) es canónica y este objeto es su único punto de acople.
  const summary = computeRangeSummary(txViews as Parameters<typeof computeRangeSummary>[0], {
    from: filters.from,
    to: filters.to,
    accounts,
    categories,
    accountIds: filters.accountIds,
    eventTransactionIds: eventTxIds,
    excludedTransactionIds: excludedTxIds,
    pendingCount: pending.rows[0]?.n ?? 0,
  } as SummaryOptions);
  return serializeRangeSummary(summary);
}

export interface FinanceSeriesPointDto { bucket: string; incomeCents: string; expenseCents: string; savingsCents: string }

export async function readFinanceSeries(
  client: PoolClient,
  householdId: string,
  filters: FinanceReadFilters,
  granularity: "month" | "quarter" | "year",
  months = 12,
): Promise<FinanceSeriesPointDto[]> {
  const windowed = { ...filters, from: seriesWindow(filters.to, months) };
  const { where, params } = txConditions(householdId, windowed);
  const bucketExpr =
    granularity === "year" ? `to_char(kt.op_date, 'YYYY')`
    : granularity === "quarter" ? `to_char(kt.op_date, 'YYYY-"T"Q')`
    : `to_char(kt.op_date, 'YYYY-MM')`;
  const result = await client.query<{ bucket: string; incomeCents: string; expenseCents: string }>(
    `with kt as (${kindedTx(where)})
     select ${bucketExpr} as "bucket",
            coalesce(sum(kt.amount_cents) filter (where kt.kind = 'ingreso'), 0)::text as "incomeCents",
            coalesce(sum(kt.amount_cents) filter (where kt.kind = 'gasto'), 0)::text as "expenseCents"
       from kt group by 1 order by 1`,
    params,
  );
  return result.rows.map((row) => ({
    ...row,
    savingsCents: (BigInt(row.incomeCents) + BigInt(row.expenseCents)).toString(),
  }));
}

export interface FinanceCategoryRowDto { categoryId: string | null; name: string; parentId: string | null; totalCents: string; count: number }

export async function readFinanceBreakdown(
  client: PoolClient,
  householdId: string,
  filters: FinanceReadFilters,
): Promise<FinanceCategoryRowDto[]> {
  const { where, params } = txConditions(householdId, filters);
  const result = await client.query<FinanceCategoryRowDto>(
    `with kt as (${kindedTx(where)})
     select kt.category_id as "categoryId",
            coalesce(cat.name, 'Sin categorizar') as "name",
            cat.parent_id as "parentId",
            sum(kt.amount_cents)::text as "totalCents",
            count(*)::int as "count"
       from kt
       left join app.finance_categories cat on cat.household_id = $1 and cat.id = kt.category_id
      group by kt.category_id, cat.name, cat.parent_id
      order by sum(kt.amount_cents) asc`,
    params,
  );
  return result.rows;
}

export interface FinanceProviderRowDto { provider: string; providerDisplay: string; totalCents: string; count: number }

export async function readFinanceProviders(
  client: PoolClient,
  householdId: string,
  filters: FinanceReadFilters,
  limit = 10,
): Promise<FinanceProviderRowDto[]> {
  const { where, params } = txConditions(householdId, filters);
  const result = await client.query<FinanceProviderRowDto>(
    `with kt as (${kindedTx(where)})
     select min(kt.provider) as "provider",
            coalesce(max(alias.display), min(kt.provider)) as "providerDisplay",
            sum(kt.amount_cents)::text as "totalCents",
            count(*)::int as "count"
       from kt
       left join app.finance_provider_aliases alias
         on alias.household_id = $1 and alias.provider_norm = kt.provider_norm
      where kt.kind = 'gasto' and kt.provider is not null and kt.provider <> ''
      group by kt.provider_norm
     having sum(kt.amount_cents) < 0
      order by sum(kt.amount_cents) asc
      limit ${Math.max(1, Math.min(50, Math.trunc(limit)))}`,
    params,
  );
  return result.rows;
}

export interface FinanceEventSummaryDto { id: string; name: string; incomeCents: string; expenseCents: string; netCents: string; txCount: number }
export interface FinanceEventDetailDto extends FinanceEventSummaryDto { categories: FinanceCategoryRowDto[] }

export async function readFinanceEventsSummary(
  client: PoolClient,
  householdId: string,
  filters: FinanceReadFilters,
): Promise<FinanceEventSummaryDto[]> {
  const { where, params } = txConditions(householdId, filters);
  const result = await client.query<Omit<FinanceEventSummaryDto, "netCents">>(
    `with kt as (${kindedTx(where)})
     select event.id, event.name,
            coalesce(sum(kt.amount_cents) filter (where kt.kind = 'ingreso'), 0)::text as "incomeCents",
            coalesce(sum(kt.amount_cents) filter (where kt.kind = 'gasto'), 0)::text as "expenseCents",
            count(kt.id)::int as "txCount"
       from app.finance_events event
       left join app.finance_transaction_events te
         on te.household_id = event.household_id and te.event_id = event.id
       left join kt on kt.id = te.transaction_id
      where event.household_id = $1
      group by event.id, event.name
      order by lower(event.name)`,
    params,
  );
  return result.rows.map((row) => ({
    ...row,
    netCents: (BigInt(row.incomeCents) + BigInt(row.expenseCents)).toString(),
  }));
}

export async function readFinanceEventDetail(
  client: PoolClient,
  householdId: string,
  eventId: string,
  filters: FinanceReadFilters,
): Promise<FinanceEventDetailDto | null> {
  const event = await client.query<{ id: string; name: string }>(
    `select id, name from app.finance_events where household_id = $1 and id = $2`,
    [householdId, eventId],
  );
  if (event.rows.length === 0) return null;
  const summary = (await readFinanceEventsSummary(client, householdId, filters))
    .find((row) => row.id === eventId) ?? {
      id: eventId, name: event.rows[0]!.name, incomeCents: "0", expenseCents: "0", netCents: "0", txCount: 0,
    };
  const categories = await readFinanceBreakdown(client, householdId, { ...filters, eventId });
  return { ...summary, categories };
}
```

- [ ] **Step 4: En verde (puro + integración + tipos).** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL=${TEST_DATABASE_URL:-postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_wt_u} pnpm --filter @casa-clara/server test src/finance/queries.test.ts src/finance/queries.integration.test.ts && pnpm --filter @casa-clara/server typecheck` — si el typecheck acusa los campos de `SummaryOptions`, reconcílialos contra `packages/domain/src/finance/types.ts` como dice el comentario.
- [ ] **Step 5: Commit.** `git add packages/server/src/finance/queries.ts packages/server/src/finance/queries.integration.test.ts && git commit -m "feat(finanzas): lecturas agregadas (summary, series, breakdown, providers, eventos) sobre el dominio"`

---

### Task 7: Cargadores de servidor y fixtures demo

**Files:**
- Create: `apps/web/src/lib/server/finance.server.ts`
- Modify: `apps/web/src/lib/server/fixtures.server.ts` (añadir al final los constructores de finanzas)
- Test: `apps/web/tests/finance-fixtures.test.ts`

**Interfaces:**
- Consumes: todo lo de `@casa-clara/server` de las tareas 5–6, más `requireFinanceAdmin` (canónico, fase 1, exportado desde `@casa-clara/server`; consúmelo como `await requireFinanceAdmin(client, membership)` — si la firma real de fase 1 difiere en parámetros, ajusta la LLAMADA, nunca el nombre), `withAuthorizedTransaction`, `AuthorizationError`, `createLogger`, `errorCode`. `unreadable`/`demoOnly` de `$lib/server/data-source.server`. `getDatabasePool` de `$lib/server/db.server`. `FinanceFilters` de `$lib/finance/filters`.
- Produces:

```ts
export interface FinanceDashboardData {
  householdId: string; filters: FinanceFilters;
  summary: FinanceSummaryDto; series: FinanceSeriesPointDto[];
  breakdown: FinanceCategoryRowDto[]; providers: FinanceProviderRowDto[];
  accounts: FinanceAccountDto[]; categories: FinanceCategoryDto[];
}
export interface FinanceMovimientosData {
  householdId: string; filters: FinanceFilters;
  page: FinanceTransactionsPage;
  accounts: FinanceAccountDto[]; categories: FinanceCategoryDto[]; events: FinanceEventDto[];
}
export interface FinanceMovimientosQuery { q: string | null; categoryId: string | null; recurrence: 'recurrente' | 'extraordinario' | null; limit: number; offset: number }
export async function loadFinanceDashboard(user: { id: string }, householdId: string, filters: FinanceFilters, pool?: Pool | null): Promise<FinanceDashboardData | null>;
export async function loadFinanceMovimientos(user: { id: string }, householdId: string, filters: FinanceFilters, query: FinanceMovimientosQuery, pool?: Pool | null): Promise<FinanceMovimientosData | null>;
// fixtures.server.ts:
export function getFinanceDashboardFixture(filters: FinanceFilters): FinanceDashboardData; // demoOnly
export function getFinanceMovimientosFixture(filters: FinanceFilters): FinanceMovimientosData; // demoOnly
```

**Pasos:**

- [ ] **Step 1: Test que falla.** `apps/web/tests/finance-fixtures.test.ts` (los datos demo también deben ser coherentes: la página no distingue fixture de Postgres):

```ts
import { describe, expect, it } from 'vitest';

import { getFinanceDashboardFixture, getFinanceMovimientosFixture } from '../src/lib/server/fixtures.server';

const FILTERS = { from: '2026-01-01', to: '2026-08-31', granularity: 'month' as const, accountIds: [], eventId: null };

describe('fixtures sintéticas de finanzas (modo demo)', () => {
  it('el resumen es aritméticamente coherente: ahorro = ingresos + gastos, desglose que suma', () => {
    const dashboard = getFinanceDashboardFixture(FILTERS);
    const summary = dashboard.summary;
    expect(BigInt(summary.savingsCents)).toBe(BigInt(summary.incomeCents) + BigInt(summary.expenseCents));
    expect(
      BigInt(summary.recurringExpenseCents) + BigInt(summary.extraordinaryExpenseCents) + BigInt(summary.unclassifiedExpenseCents)
    ).toBe(BigInt(summary.expenseCents));
    expect(summary.prev).not.toBeNull();
    expect(dashboard.series.length).toBeGreaterThanOrEqual(6);
    for (const point of dashboard.series) {
      expect(BigInt(point.savingsCents)).toBe(BigInt(point.incomeCents) + BigInt(point.expenseCents));
    }
    expect(dashboard.accounts.length).toBeGreaterThan(0);
    expect(dashboard.providers.length).toBeGreaterThan(0);
  });

  it('los movimientos demo traen raw para el panel «Datos del origen» y total veraz', () => {
    const movimientos = getFinanceMovimientosFixture(FILTERS);
    expect(movimientos.page.total).toBe(movimientos.page.rows.length);
    expect(movimientos.page.rows.some((row) => row.raw !== null)).toBe(true);
    const sum = movimientos.page.rows.reduce((acc, row) => acc + BigInt(row.amountCents), 0n);
    expect(BigInt(movimientos.page.sumCents)).toBe(sum);
    for (const row of movimientos.page.rows) expect(row.amountCents).toMatch(/^-?\d+$/);
  });
});
```

- [ ] **Step 2: Falla.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-fixtures.test.ts`
- [ ] **Step 3: Fixtures.** Al final de `apps/web/src/lib/server/fixtures.server.ts` añade (imports arriba: `import type { FinanceDashboardData, FinanceMovimientosData } from './finance.server';` y `import type { FinanceFilters } from '$lib/finance/filters';`). Datos INVENTADOS, ids `fa…/fb…` hexadecimales válidos:

```ts
// ── Finanzas (fase 4): corpus demo del módulo. Todo inventado. ───────────────

const FINANCE_ACCOUNTS = [
  { id: 'fa000000-0000-4000-8000-000000000001', name: 'Cuenta común', bank: 'caixabank', kind: 'comun', ownerLabel: 'familia', archived: false },
  { id: 'fa000000-0000-4000-8000-000000000002', name: 'Cuenta nómina', bank: 'openbank', kind: 'personal', ownerLabel: 'padre', archived: false },
  { id: 'fa000000-0000-4000-8000-000000000003', name: 'Plan índice', bank: 'deutsche_bank', kind: 'inversion', ownerLabel: 'familia', archived: false }
];

const FINANCE_CATEGORIES = [
  { id: 'fb000000-0000-4000-8000-000000000001', name: 'Casa', parentId: null, kind: 'gasto' },
  { id: 'fb000000-0000-4000-8000-000000000002', name: 'Supermercado', parentId: 'fb000000-0000-4000-8000-000000000001', kind: 'gasto' },
  { id: 'fb000000-0000-4000-8000-000000000003', name: 'Suministros', parentId: 'fb000000-0000-4000-8000-000000000001', kind: 'gasto' },
  { id: 'fb000000-0000-4000-8000-000000000004', name: 'Ingresos', parentId: null, kind: 'ingreso' },
  { id: 'fb000000-0000-4000-8000-000000000005', name: 'Nómina', parentId: 'fb000000-0000-4000-8000-000000000004', kind: 'ingreso' },
  { id: 'fb000000-0000-4000-8000-000000000006', name: 'Transferencias', parentId: null, kind: 'transferencia' }
];

/** Serie mensual coherente: ahorro = ingresos + gastos en cada cubo. */
const FINANCE_SERIES = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map(
  (bucket, index) => {
    const income = 420000n + BigInt(index) * 1000n;
    const expense = -(300000n + BigInt(index % 3) * 12000n);
    return { bucket, incomeCents: income.toString(), expenseCents: expense.toString(), savingsCents: (income + expense).toString() };
  }
);

const FINANCE_SUMMARY_PREV = {
  incomeCents: '402000', expenseCents: '-355000', recurringExpenseCents: '-260000',
  extraordinaryExpenseCents: '-80000', unclassifiedExpenseCents: '-15000',
  savingsCents: '47000', netSavingsRate: 11.7, grossSavingsRate: 35.3,
  investedCents: '40000', investmentRate: 10, freeCashFlowCents: '7000', opsCashFlowCents: '47000',
  receivedContributionsCents: '0', outgoingTransfersCents: '0', pendingCount: 0, prev: null
};

export const getFinanceDashboardFixture = demoOnly(
  'finance-dashboard',
  (filters: FinanceFilters): FinanceDashboardData => ({
    householdId: HOUSEHOLD.id,
    filters,
    summary: {
      incomeCents: '425000', expenseCents: '-318550', recurringExpenseCents: '-214000',
      extraordinaryExpenseCents: '-84550', unclassifiedExpenseCents: '-20000',
      savingsCents: '106450', netSavingsRate: 25, grossSavingsRate: 49.6,
      investedCents: '60000', investmentRate: 14.1, freeCashFlowCents: '46450', opsCashFlowCents: '106450',
      receivedContributionsCents: '0', outgoingTransfersCents: '0', pendingCount: 3,
      prev: FINANCE_SUMMARY_PREV
    },
    series: FINANCE_SERIES,
    breakdown: [
      { categoryId: 'fb000000-0000-4000-8000-000000000002', name: 'Supermercado', parentId: 'fb000000-0000-4000-8000-000000000001', totalCents: '-182000', count: 14 },
      { categoryId: 'fb000000-0000-4000-8000-000000000003', name: 'Suministros', parentId: 'fb000000-0000-4000-8000-000000000001', totalCents: '-96550', count: 6 },
      { categoryId: null, name: 'Sin categorizar', parentId: null, totalCents: '-40000', count: 3 },
      { categoryId: 'fb000000-0000-4000-8000-000000000005', name: 'Nómina', parentId: 'fb000000-0000-4000-8000-000000000004', totalCents: '425000', count: 2 }
    ],
    providers: [
      { provider: 'SUPERMERCADOS ENCINA', providerDisplay: 'Encina', totalCents: '-98000', count: 9 },
      { provider: 'LUZ DEL VALLE SA', providerDisplay: 'Luz del Valle', totalCents: '-56550', count: 4 },
      { provider: 'AGUAS DE LA VEGA', providerDisplay: 'Aguas de la Vega', totalCents: '-24000', count: 2 }
    ],
    accounts: FINANCE_ACCOUNTS,
    categories: FINANCE_CATEGORIES
  })
);

const FINANCE_TXS = [
  {
    id: 'fc000000-0000-4000-8000-000000000001', accountId: FINANCE_ACCOUNTS[0]!.id, accountName: 'Cuenta común',
    opDate: '2026-08-28', valueDate: '2026-08-28', concept: 'COMPRA SUPERMERCADOS ENCINA MADRID',
    provider: 'SUPERMERCADOS ENCINA', providerNorm: 'supermercados encina', providerDisplay: 'Encina',
    amountCents: '-8734', balanceCents: '215600', codeCommon: '12', codeOwn: '300',
    categoryId: 'fb000000-0000-4000-8000-000000000002', categoryName: 'Supermercado',
    status: 'confirmada', transferGroupId: null, recurrence: 'recurrente' as const, recurrenceManual: false,
    bankCategory: 'Alimentación', eventIds: [],
    raw: { 'Fecha operación': '28/08/2026', 'Concepto': 'COMPRA SUPERMERCADOS ENCINA MADRID', 'Importe': '-87,34', 'Saldo': '2.156,00' }
  },
  {
    id: 'fc000000-0000-4000-8000-000000000002', accountId: FINANCE_ACCOUNTS[1]!.id, accountName: 'Cuenta nómina',
    opDate: '2026-08-25', valueDate: '2026-08-25', concept: 'NOMINA AGOSTO TALLERES ROBLE SL',
    provider: 'TALLERES ROBLE SL', providerNorm: 'talleres roble sl', providerDisplay: 'Talleres Roble',
    amountCents: '212500', balanceCents: '389000', codeCommon: '01', codeOwn: '100',
    categoryId: 'fb000000-0000-4000-8000-000000000005', categoryName: 'Nómina',
    status: 'confirmada', transferGroupId: null, recurrence: 'recurrente' as const, recurrenceManual: false,
    bankCategory: null, eventIds: [],
    raw: { 'Fecha operación': '25/08/2026', 'Concepto': 'NOMINA AGOSTO TALLERES ROBLE SL', 'Importe': '2.125,00' }
  },
  {
    id: 'fc000000-0000-4000-8000-000000000003', accountId: FINANCE_ACCOUNTS[1]!.id, accountName: 'Cuenta nómina',
    opDate: '2026-08-20', valueDate: null, concept: 'TRASPASO A CUENTA COMUN',
    provider: null, providerNorm: null, providerDisplay: null,
    amountCents: '-50000', balanceCents: null, codeCommon: null, codeOwn: null,
    categoryId: 'fb000000-0000-4000-8000-000000000006', categoryName: 'Transferencias',
    status: 'confirmada', transferGroupId: 'fd000000-0000-4000-8000-000000000001', recurrence: null, recurrenceManual: false,
    bankCategory: null, eventIds: [], raw: null
  },
  {
    id: 'fc000000-0000-4000-8000-000000000004', accountId: FINANCE_ACCOUNTS[0]!.id, accountName: 'Cuenta común',
    opDate: '2026-08-20', valueDate: '2026-08-20', concept: 'TRANSFERENCIA DE CUENTA NOMINA',
    provider: null, providerNorm: null, providerDisplay: null,
    amountCents: '50000', balanceCents: '224334', codeCommon: '04', codeOwn: null,
    categoryId: 'fb000000-0000-4000-8000-000000000006', categoryName: 'Transferencias',
    status: 'confirmada', transferGroupId: 'fd000000-0000-4000-8000-000000000001', recurrence: null, recurrenceManual: false,
    bankCategory: null, eventIds: [],
    raw: { 'Fecha operación': '20/08/2026', 'Concepto': 'TRANSFERENCIA DE CUENTA NOMINA', 'Importe': '500,00' }
  },
  {
    id: 'fc000000-0000-4000-8000-000000000005', accountId: FINANCE_ACCOUNTS[0]!.id, accountName: 'Cuenta común',
    opDate: '2026-08-12', valueDate: '2026-08-12', concept: 'RECIBO LUZ DEL VALLE SA',
    provider: 'LUZ DEL VALLE SA', providerNorm: 'luz del valle sa', providerDisplay: 'Luz del Valle',
    amountCents: '-14210', balanceCents: '174334', codeCommon: '03', codeOwn: '210',
    categoryId: 'fb000000-0000-4000-8000-000000000003', categoryName: 'Suministros',
    status: 'sugerida_regla', transferGroupId: null, recurrence: 'recurrente' as const, recurrenceManual: false,
    bankCategory: 'Hogar', eventIds: [],
    raw: { 'Fecha operación': '12/08/2026', 'Concepto': 'RECIBO LUZ DEL VALLE SA', 'Importe': '-142,10' }
  }
];

export const getFinanceMovimientosFixture = demoOnly(
  'finance-movimientos',
  (filters: FinanceFilters): FinanceMovimientosData => ({
    householdId: HOUSEHOLD.id,
    filters,
    page: {
      total: FINANCE_TXS.length,
      sumCents: FINANCE_TXS.reduce((acc, tx) => acc + BigInt(tx.amountCents), 0n).toString(),
      limit: 100,
      offset: 0,
      rows: FINANCE_TXS
    },
    accounts: FINANCE_ACCOUNTS,
    categories: FINANCE_CATEGORIES,
    events: [{ id: 'fe000000-0000-4000-8000-000000000001', name: 'Semana Santa 2026' }]
  })
);
```

- [ ] **Step 4: Cargadores.** Crea `apps/web/src/lib/server/finance.server.ts` (patrón de `employment.server.ts`):

```ts
import type { Pool } from 'pg';

import {
  AuthorizationError,
  createLogger,
  requireFinanceAdmin,
  withAuthorizedTransaction,
  readFinanceAccounts,
  readFinanceBreakdown,
  readFinanceCategories,
  readFinanceEvents,
  readFinanceProviders,
  readFinanceSeries,
  readFinanceSummary,
  readFinanceTransactions,
  type FinanceAccountDto,
  type FinanceCategoryDto,
  type FinanceCategoryRowDto,
  type FinanceEventDto,
  type FinanceProviderRowDto,
  type FinanceReadFilters,
  type FinanceSeriesPointDto,
  type FinanceSummaryDto,
  type FinanceTransactionsPage
} from '@casa-clara/server';

import type { FinanceFilters } from '$lib/finance/filters';
import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:finance');

/**
 * Lecturas del módulo Finanzas bajo RLS y doble cerrojo (§4): la transacción
 * autorizada fija el contexto y `requireFinanceAdmin` corta en seco a quien no
 * es admin-con-concesión (cinturón además de la RLS, que ya devuelve cero
 * filas). Devuelve null cuando no hay pool (demo) o la membresía no autoriza:
 * la página cae entonces a la fixture o al 404 del guard.
 */

const toReadFilters = (filters: FinanceFilters): FinanceReadFilters => ({
  from: filters.from,
  to: filters.to,
  accountIds: filters.accountIds,
  eventId: filters.eventId,
  excludeEventIds: []
});

export interface FinanceDashboardData {
  householdId: string;
  filters: FinanceFilters;
  summary: FinanceSummaryDto;
  series: FinanceSeriesPointDto[];
  breakdown: FinanceCategoryRowDto[];
  providers: FinanceProviderRowDto[];
  accounts: FinanceAccountDto[];
  categories: FinanceCategoryDto[];
}

export async function loadFinanceDashboard(
  user: { id: string },
  householdId: string,
  filters: FinanceFilters,
  pool: Pool | null = getDatabasePool()
): Promise<FinanceDashboardData | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      await requireFinanceAdmin(client, membership);
      const read = toReadFilters(filters);
      const summary = await readFinanceSummary(client, householdId, read);
      const series = await readFinanceSeries(client, householdId, read, filters.granularity, 12);
      const breakdown = await readFinanceBreakdown(client, householdId, read);
      const providers = await readFinanceProviders(client, householdId, read, 10);
      const accounts = await readFinanceAccounts(client, householdId);
      const categories = await readFinanceCategories(client, householdId);
      return { householdId, filters, summary, series, breakdown, providers, accounts, categories };
    });
  } catch (cause) {
    if (cause instanceof AuthorizationError) return null;
    return unreadable(log, 'finance dashboard', cause);
  }
}

export interface FinanceMovimientosQuery {
  q: string | null;
  categoryId: string | null;
  recurrence: 'recurrente' | 'extraordinario' | null;
  limit: number;
  offset: number;
}

export interface FinanceMovimientosData {
  householdId: string;
  filters: FinanceFilters;
  page: FinanceTransactionsPage;
  accounts: FinanceAccountDto[];
  categories: FinanceCategoryDto[];
  events: FinanceEventDto[];
}

export async function loadFinanceMovimientos(
  user: { id: string },
  householdId: string,
  filters: FinanceFilters,
  query: FinanceMovimientosQuery,
  pool: Pool | null = getDatabasePool()
): Promise<FinanceMovimientosData | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      await requireFinanceAdmin(client, membership);
      const page = await readFinanceTransactions(client, householdId, {
        ...toReadFilters(filters),
        q: query.q,
        categoryId: query.categoryId,
        recurrence: query.recurrence,
        status: null,
        ids: [],
        groupIds: [],
        limit: query.limit,
        offset: query.offset
      });
      const accounts = await readFinanceAccounts(client, householdId);
      const categories = await readFinanceCategories(client, householdId);
      const events = await readFinanceEvents(client, householdId);
      return { householdId, filters, page, accounts, categories, events };
    });
  } catch (cause) {
    if (cause instanceof AuthorizationError) return null;
    return unreadable(log, 'finance movimientos', cause);
  }
}
```

Nota: si `requireFinanceAdmin` (fase 1) rechaza con un error propio distinto de `AuthorizationError` (por ejemplo `CommandRejectedError`), añade su captura junto a la de `AuthorizationError` devolviendo null — mira su implementación en `packages/server/src/commands/finance.ts`.

- [ ] **Step 5: En verde + tipos.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-fixtures.test.ts && pnpm --filter @casa-clara/web typecheck`
- [ ] **Step 6: Commit.** `git add apps/web/src/lib/server/finance.server.ts apps/web/src/lib/server/fixtures.server.ts apps/web/tests/finance-fixtures.test.ts && git commit -m "feat(finanzas): cargadores bajo RLS con doble cerrojo y corpus demo sintetico"`

---

### Task 8: Endpoints GET `/api/v1/finance/*`

**Files:**
- Create: `apps/web/src/routes/api/v1/finance/summary/+server.ts`
- Create: `apps/web/src/routes/api/v1/finance/series/+server.ts`
- Create: `apps/web/src/routes/api/v1/finance/breakdown/+server.ts`
- Create: `apps/web/src/routes/api/v1/finance/providers/+server.ts`
- Create: `apps/web/src/routes/api/v1/finance/transactions/+server.ts`
- Create: `apps/web/src/routes/api/v1/finance/events-summary/+server.ts`
- Create: `apps/web/src/routes/api/v1/finance/events/[id]/+server.ts`
- Modify: `apps/web/src/lib/server/finance.server.ts` (guard y parseo compartidos)
- Test: `apps/web/tests/finance-endpoints.test.ts`

**Interfaces:**
- Consumes: contrato canónico de rutas y parámetros del doc de interfaces (`household`, `from,to,g,acc,ev,exev`, `months`, `limit`, `q,cat,rec,status,ids,group_ids,limit/offset`); `belongsToHousehold` de `$lib/auth/membership`; lecturas de `@casa-clara/server`.
- Produces (añadidos a `finance.server.ts`):

```ts
export function requireFinanceRequest(locals: App.Locals, url: URL): { user: { id: string }; householdId: string; pool: Pool };
export function parseReadFilters(url: URL): FinanceReadFilters;          // 400 si from/to/uuids malformados
export function parseTransactionsQuery(url: URL): FinanceTransactionsQuery;
export async function financeRead<T>(locals: App.Locals, url: URL, reader: (client: PoolClient, householdId: string) => Promise<T>): Promise<Response>;
```

**Pasos:**

- [ ] **Step 1: Test que falla.** `apps/web/tests/finance-endpoints.test.ts` (los caminos de guarda son puros de HTTP y se prueban sin base; las lecturas reales ya quedaron probadas en las tareas 5–6 contra Postgres):

```ts
import { describe, expect, it } from 'vitest';

import { parseReadFilters, parseTransactionsQuery, requireFinanceRequest } from '../src/lib/server/finance.server';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const USER = {
  id: 'u1', name: 'Alberto', initials: 'A', email: 'a@casaclara.demo',
  memberships: [{ householdId: HOUSEHOLD, membershipId: 'm1', role: 'family_admin' as const }]
};
const urlOf = (query: string): URL => new URL(`https://casa.local/api/v1/finance/summary?${query}`);

function statusOf(run: () => unknown): number | null {
  try { run(); return null; } catch (cause) { return (cause as { status?: number }).status ?? null; }
}

describe('guard de los endpoints GET /api/v1/finance/* (el hook no cubre /api)', () => {
  it('sin sesión: 401', () => {
    expect(statusOf(() => requireFinanceRequest({ user: null } as unknown as App.Locals, urlOf(`household=${HOUSEHOLD}`)))).toBe(401);
  });
  it('household ausente o malformado: 400', () => {
    expect(statusOf(() => requireFinanceRequest({ user: USER } as unknown as App.Locals, urlOf('')))).toBe(400);
    expect(statusOf(() => requireFinanceRequest({ user: USER } as unknown as App.Locals, urlOf('household=patata')))).toBe(400);
  });
  it('hogar ajeno: 404, indistinguible de inexistente', () => {
    expect(statusOf(() => requireFinanceRequest({ user: USER } as unknown as App.Locals, urlOf('household=20000000-0000-4000-8000-000000000001')))).toBe(404);
  });
  it('con sesión y membresía pero sin base de datos configurada: 503 honesto', () => {
    expect(statusOf(() => requireFinanceRequest({ user: USER } as unknown as App.Locals, urlOf(`household=${HOUSEHOLD}`)))).toBe(503);
  });
});

describe('parseo de filtros de lectura', () => {
  it('fechas malformadas: 400; válidas: pasan con acc/ev/exev', () => {
    expect(statusOf(() => parseReadFilters(urlOf('from=ayer&to=2026-01-31')))).toBe(400);
    const filters = parseReadFilters(urlOf(`from=2026-01-01&to=2026-01-31&acc=${HOUSEHOLD}&ev=${HOUSEHOLD}`));
    expect(filters.accountIds).toEqual([HOUSEHOLD]);
    expect(filters.eventId).toBe(HOUSEHOLD);
  });
  it('uuids malformados en acc/ids: 400', () => {
    expect(statusOf(() => parseReadFilters(urlOf('from=2026-01-01&to=2026-01-31&acc=uno,dos')))).toBe(400);
    expect(statusOf(() => parseTransactionsQuery(urlOf('ids=nope')))).toBe(400);
  });
  it('transactions: por ids ignora el rango; limit con tope y offset saneados', () => {
    const byIds = parseTransactionsQuery(urlOf(`ids=${HOUSEHOLD}`));
    expect(byIds.ids).toEqual([HOUSEHOLD]);
    const paged = parseTransactionsQuery(urlOf('from=2026-01-01&to=2026-01-31&limit=9999&offset=-3&rec=recurrente&status=confirmada'));
    expect(paged.limit).toBe(500);
    expect(paged.offset).toBe(0);
    expect(paged.recurrence).toBe('recurrente');
    expect(statusOf(() => parseTransactionsQuery(urlOf('from=2026-01-01&to=2026-01-31&status=inventado')))).toBe(400);
  });
});
```

- [ ] **Step 2: Falla.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-endpoints.test.ts` — no existen los exports.
- [ ] **Step 3: Guard y parseo en `finance.server.ts`.** Añade (imports: `error`, `isHttpError`, `json` de `@sveltejs/kit`; `belongsToHousehold` de `$lib/auth/membership`; `errorCode` de `@casa-clara/server`; `DATA_UNAVAILABLE_MESSAGE`, `DATA_UNAVAILABLE_STATUS` de `./data-source.server`; `PoolClient` de `pg`):

```ts
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TX_STATUSES = ['pendiente', 'sugerida_regla', 'sugerida_agente', 'confirmada'];

function csvUuids(value: string | null, name: string): string[] {
  if (!value) return [];
  const ids = value.split(',').map((piece) => piece.trim()).filter(Boolean);
  for (const id of ids) if (!UUID_PATTERN.test(id)) error(400, `Parámetro ${name} inválido`);
  return ids;
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) error(400, `Parámetro ${name} inválido`);
  return Math.min(max, Math.max(min, value));
}

/**
 * Guard común de los GET /api/v1/finance/* (§7): el hook de sesión no cubre
 * /api, así que sesión, hogar y membresía se comprueban aquí, explícitos y en
 * este orden. Sin base de datos no hay lectura REST que servir: 503 honesto,
 * nunca una maqueta (regla de data-source.server.ts).
 */
export function requireFinanceRequest(
  locals: App.Locals,
  url: URL
): { user: { id: string }; householdId: string; pool: Pool } {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  const householdId = url.searchParams.get('household') ?? '';
  if (!UUID_PATTERN.test(householdId)) error(400, 'Falta el hogar (household)');
  if (!belongsToHousehold(locals.user, householdId)) error(404, 'Hogar no encontrado');
  const pool = getDatabasePool();
  if (!pool) error(DATA_UNAVAILABLE_STATUS, DATA_UNAVAILABLE_MESSAGE);
  return { user: { id: locals.user.id }, householdId, pool };
}

export function parseReadFilters(url: URL): FinanceReadFilters {
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) error(400, 'Rango de fechas inválido (from/to)');
  const eventId = url.searchParams.get('ev');
  if (eventId && !UUID_PATTERN.test(eventId)) error(400, 'Parámetro ev inválido');
  return {
    from,
    to,
    accountIds: csvUuids(url.searchParams.get('acc'), 'acc'),
    eventId: eventId || null,
    excludeEventIds: csvUuids(url.searchParams.get('exev'), 'exev')
  };
}

export function parseTransactionsQuery(url: URL): FinanceTransactionsQuery {
  const ids = csvUuids(url.searchParams.get('ids'), 'ids');
  const groupIds = csvUuids(url.searchParams.get('group_ids'), 'group_ids');
  // Petición exacta (ids/grupos): el rango no aplica, como el fetch por id del
  // panel del original. Con rango, from/to son obligatorios y validados.
  const filters = ids.length > 0 || groupIds.length > 0
    ? { from: '1900-01-01', to: '2999-12-31', accountIds: [], eventId: null, excludeEventIds: [] }
    : parseReadFilters(url);
  const categoryId = url.searchParams.get('cat');
  if (categoryId && !UUID_PATTERN.test(categoryId)) error(400, 'Parámetro cat inválido');
  const recurrence = url.searchParams.get('rec');
  if (recurrence && recurrence !== 'recurrente' && recurrence !== 'extraordinario') error(400, 'Parámetro rec inválido');
  const status = url.searchParams.get('status');
  if (status && !TX_STATUSES.includes(status)) error(400, 'Parámetro status inválido');
  return {
    ...filters,
    q: url.searchParams.get('q') || null,
    categoryId: categoryId || null,
    recurrence: (recurrence as 'recurrente' | 'extraordinario' | null) || null,
    status: status || null,
    ids,
    groupIds,
    limit: intParam(url, 'limit', 100, 1, 500),
    offset: intParam(url, 'offset', 0, 0, 1_000_000)
  };
}

/** Ejecuta una lectura autorizada y responde JSON sin caché. */
export async function financeRead<T>(
  locals: App.Locals,
  url: URL,
  reader: (client: PoolClient, householdId: string) => Promise<T>
): Promise<Response> {
  const { user, householdId, pool } = requireFinanceRequest(locals, url);
  try {
    const payload = await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      await requireFinanceAdmin(client, membership);
      return reader(client, householdId);
    });
    return json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    // Sin membresía o sin concesión: 404, indistinguible de inexistente.
    if (cause instanceof AuthorizationError) error(404, 'Hogar no encontrado');
    if (isHttpError(cause)) throw cause;
    log.error('finance api unavailable', { code: errorCode(cause) });
    error(DATA_UNAVAILABLE_STATUS, DATA_UNAVAILABLE_MESSAGE);
  }
}
```

(Como en Task 7: si `requireFinanceAdmin` rechaza con un error propio de fase 1, captúralo junto a `AuthorizationError` como 404.)

- [ ] **Step 4: Los siete endpoints.** Cada fichero es una llamada a `financeRead`; imita el estilo de `apps/web/src/routes/api/v1/households/[householdId]/vacaciones/vistas/+server.ts`:

```ts
// apps/web/src/routes/api/v1/finance/summary/+server.ts
import { readFinanceSummary } from '@casa-clara/server';

import { financeRead, parseReadFilters } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) =>
  financeRead(locals, url, (client, householdId) => readFinanceSummary(client, householdId, parseReadFilters(url)));
```

```ts
// series/+server.ts — mismos imports, cuerpo:
export const GET: RequestHandler = async ({ locals, url }) => {
  const granularity = url.searchParams.get('g') ?? 'month';
  if (!['month', 'quarter', 'year'].includes(granularity)) error(400, 'Parámetro g inválido');
  const months = Number(url.searchParams.get('months') ?? '12');
  if (!Number.isInteger(months) || months < 1 || months > 60) error(400, 'Parámetro months inválido');
  return financeRead(locals, url, (client, householdId) =>
    readFinanceSeries(client, householdId, parseReadFilters(url), granularity as 'month' | 'quarter' | 'year', months));
};
```

```ts
// breakdown/+server.ts
export const GET: RequestHandler = async ({ locals, url }) =>
  financeRead(locals, url, (client, householdId) => readFinanceBreakdown(client, householdId, parseReadFilters(url)));

// providers/+server.ts
export const GET: RequestHandler = async ({ locals, url }) => {
  const limit = Number(url.searchParams.get('limit') ?? '10');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) error(400, 'Parámetro limit inválido');
  return financeRead(locals, url, (client, householdId) =>
    readFinanceProviders(client, householdId, parseReadFilters(url), limit));
};

// transactions/+server.ts
export const GET: RequestHandler = async ({ locals, url }) =>
  financeRead(locals, url, (client, householdId) =>
    readFinanceTransactions(client, householdId, parseTransactionsQuery(url)));

// events-summary/+server.ts
export const GET: RequestHandler = async ({ locals, url }) =>
  financeRead(locals, url, (client, householdId) => readFinanceEventsSummary(client, householdId, parseReadFilters(url)));

// events/[id]/+server.ts
export const GET: RequestHandler = async ({ locals, url, params }) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.id)) error(404, 'Evento no encontrado');
  return financeRead(locals, url, async (client, householdId) => {
    const detail = await readFinanceEventDetail(client, householdId, params.id, parseReadFilters(url));
    if (!detail) error(404, 'Evento no encontrado');
    return detail;
  });
};
```

- [ ] **Step 5: En verde.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-endpoints.test.ts && pnpm --filter @casa-clara/web typecheck`
- [ ] **Step 6: Commit.** `git add apps/web/src/routes/api/v1/finance apps/web/src/lib/server/finance.server.ts apps/web/tests/finance-endpoints.test.ts && git commit -m "feat(finanzas): endpoints GET de lectura con sesion, membresia y concesion explicitas"`

---

### Task 9: Cliente REST (`$lib/finance/api.ts`)

**Files:**
- Create: `apps/web/src/lib/finance/api.ts`
- Test: `apps/web/tests/finance-api.test.ts`

**Interfaces:**
- Consumes: `apiQuery`, `FinanceFilters` de `./filters`; tipos DTO SOLO como `import type { … } from '@casa-clara/server'` (se borran al compilar: nada del paquete servidor llega al navegador).
- Produces:

```ts
export class FinanceApiError extends Error { readonly status: number }
export type FinanceDetailMode =
  | { kind: 'movimiento'; tx: FinanceTxDto }
  | { kind: 'ids'; ids: string[]; label: string; sub?: string | null }
  | { kind: 'grupo'; groupId: string; label: string };
export function financeApi(householdId: string, fetchFn?: typeof fetch): {
  summary(filters: FinanceFilters, excludeEventIds?: string[]): Promise<FinanceSummaryDto>;
  series(filters: FinanceFilters, months?: number): Promise<FinanceSeriesPointDto[]>;
  breakdown(filters: FinanceFilters): Promise<FinanceCategoryRowDto[]>;
  providers(filters: FinanceFilters, limit?: number): Promise<FinanceProviderRowDto[]>;
  transactions(filters: FinanceFilters, extra?: Record<string, string>): Promise<FinanceTransactionsPage>;
  transactionsByIds(ids: string[]): Promise<FinanceTransactionsPage>;
  transactionsByGroups(groupIds: string[]): Promise<FinanceTransactionsPage>;
  eventsSummary(filters: FinanceFilters): Promise<FinanceEventSummaryDto[]>;
  eventDetail(id: string, filters: FinanceFilters): Promise<FinanceEventDetailDto>;
}
```

**Pasos:**

- [ ] **Step 1: Test que falla.** `apps/web/tests/finance-api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { FinanceApiError, financeApi } from '../src/lib/finance/api';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const FILTERS = { from: '2026-01-01', to: '2026-08-31', granularity: 'month' as const, accountIds: ['a1'], eventId: null };

function stubFetch(status = 200, body: unknown = {}): { calls: string[]; fetchFn: typeof fetch } {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('cliente de /api/v1/finance', () => {
  it('summary construye la URL canónica con household y filtros', async () => {
    const { calls, fetchFn } = stubFetch();
    await financeApi(HOUSEHOLD, fetchFn).summary(FILTERS);
    expect(calls[0]).toBe(`/api/v1/finance/summary?from=2026-01-01&to=2026-08-31&acc=a1&household=${HOUSEHOLD}`);
  });

  it('series añade granularidad y months; transactionsByIds pide por ids exactos', async () => {
    const { calls, fetchFn } = stubFetch(200, []);
    const api = financeApi(HOUSEHOLD, fetchFn);
    await api.series(FILTERS, 6);
    expect(calls[0]).toContain('/api/v1/finance/series?');
    expect(calls[0]).toContain('g=month');
    expect(calls[0]).toContain('months=6');
    await api.transactionsByIds(['b1', 'b2']);
    expect(calls[1]).toBe(`/api/v1/finance/transactions?household=${HOUSEHOLD}&ids=b1%2Cb2`);
  });

  it('una respuesta no-ok se convierte en FinanceApiError con su status', async () => {
    const { fetchFn } = stubFetch(503);
    await expect(financeApi(HOUSEHOLD, fetchFn).summary(FILTERS)).rejects.toBeInstanceOf(FinanceApiError);
    await expect(financeApi(HOUSEHOLD, fetchFn).summary(FILTERS)).rejects.toMatchObject({ status: 503 });
  });
});
```

- [ ] **Step 2: Falla.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-api.test.ts`
- [ ] **Step 3: Implementación.**

```ts
/**
 * Cliente de las lecturas REST de finanzas (§7). Solo lecturas: toda escritura
 * va por comandos de /api/v1/sync (fase 5). Los tipos DTO se importan SOLO
 * como tipos del paquete servidor: se borran al compilar y nada de
 * @casa-clara/server llega al navegador.
 */
import type {
  FinanceCategoryRowDto,
  FinanceEventDetailDto,
  FinanceEventSummaryDto,
  FinanceProviderRowDto,
  FinanceSeriesPointDto,
  FinanceSummaryDto,
  FinanceTransactionsPage,
  FinanceTxDto
} from '@casa-clara/server';

import { apiQuery, type FinanceFilters } from './filters';

export class FinanceApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'FinanceApiError';
  }
}

/** Modo de apertura del panel de detalle (§8: ids / grupo / movimiento). */
export type FinanceDetailMode =
  | { kind: 'movimiento'; tx: FinanceTxDto }
  | { kind: 'ids'; ids: string[]; label: string; sub?: string | null }
  | { kind: 'grupo'; groupId: string; label: string };

async function getJson<T>(fetchFn: typeof fetch, path: string, params: URLSearchParams): Promise<T> {
  const response = await fetchFn(`/api/v1/finance/${path}?${params}`);
  if (!response.ok) throw new FinanceApiError(response.status, `GET /api/v1/finance/${path} → ${response.status}`);
  return (await response.json()) as T;
}

export function financeApi(householdId: string, fetchFn: typeof fetch = fetch) {
  const withHousehold = (params: URLSearchParams): URLSearchParams => {
    params.set('household', householdId);
    return params;
  };
  const base = (filters: FinanceFilters): URLSearchParams => withHousehold(apiQuery(filters));
  return {
    summary: (filters: FinanceFilters, excludeEventIds: string[] = []): Promise<FinanceSummaryDto> => {
      const params = base(filters);
      if (excludeEventIds.length > 0) params.set('exev', excludeEventIds.join(','));
      return getJson(fetchFn, 'summary', params);
    },
    series: (filters: FinanceFilters, months = 12): Promise<FinanceSeriesPointDto[]> => {
      const params = base(filters);
      params.set('g', filters.granularity);
      params.set('months', String(months));
      return getJson(fetchFn, 'series', params);
    },
    breakdown: (filters: FinanceFilters): Promise<FinanceCategoryRowDto[]> => getJson(fetchFn, 'breakdown', base(filters)),
    providers: (filters: FinanceFilters, limit = 10): Promise<FinanceProviderRowDto[]> => {
      const params = base(filters);
      params.set('limit', String(limit));
      return getJson(fetchFn, 'providers', params);
    },
    transactions: (filters: FinanceFilters, extra: Record<string, string> = {}): Promise<FinanceTransactionsPage> => {
      const params = base(filters);
      for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
      return getJson(fetchFn, 'transactions', params);
    },
    transactionsByIds: (ids: string[]): Promise<FinanceTransactionsPage> =>
      getJson(fetchFn, 'transactions', withHousehold(new URLSearchParams({ ids: ids.join(',') }))),
    transactionsByGroups: (groupIds: string[]): Promise<FinanceTransactionsPage> =>
      getJson(fetchFn, 'transactions', withHousehold(new URLSearchParams({ group_ids: groupIds.join(',') }))),
    eventsSummary: (filters: FinanceFilters): Promise<FinanceEventSummaryDto[]> => getJson(fetchFn, 'events-summary', base(filters)),
    eventDetail: (id: string, filters: FinanceFilters): Promise<FinanceEventDetailDto> => getJson(fetchFn, `events/${id}`, base(filters))
  };
}
```

Ojo con el orden de parámetros del primer test (`apiQuery` primero, `household` después): la implementación de arriba lo produce tal cual.

- [ ] **Step 4: En verde.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test tests/finance-api.test.ts`
- [ ] **Step 5: Commit.** `git add apps/web/src/lib/finance/api.ts apps/web/tests/finance-api.test.ts && git commit -m "feat(finanzas): cliente tipado de las lecturas REST"`

---

### Task 10: Componentes de gráficas SVG

**Files:**
- Create: `apps/web/src/lib/components/finance/FinanceSparkline.svelte`
- Create: `apps/web/src/lib/components/finance/CashflowChart.svelte`
- Create: `apps/web/src/lib/components/finance/NatureStackChart.svelte`
- Create: `apps/web/src/lib/components/finance/CategoryBars.svelte`

**Interfaces:**
- Consumes: `sparklinePoints`, `cashflowLayout`, `natureStackLayout` de `$lib/finance/chart-geometry`; `groupExpenseCategories` de `$lib/finance/breakdown`; `formatCents`, `bucketLabel` de `$lib/finance/format`. Tipos de entrada: `CashflowBucketInput[]`, `NatureBucketInput[]`, `BreakdownRowInput[]`.
- Produces: props de cada componente (los consumen las tareas 12–13 y la fase 6): `FinanceSparkline { values: number[]; label: string; stroke?: string }` · `CashflowChart { buckets: CashflowBucketInput[] }` · `NatureStackChart { buckets: NatureBucketInput[] }` · `CategoryBars { rows: BreakdownRowInput[]; categories: { id: string; name: string; parentId: string | null }[]; movementsHref: (categoryId: string) => string }`.
- La geometría ya está testeada (Task 3); aquí la verificación es `pnpm check` (svelte-check + linter de tokens CSS) y el e2e de las tareas 12–13. Colores SOLO tokens: ingresos `var(--success)`, gastos `var(--danger)`, línea de ahorro `var(--ink)`, rejilla `var(--line)`; en el apilado: recurrente `var(--primary)`, extraordinario `var(--info)`, sin clasificar `var(--line-strong)`. Nada de terracota (reservado a «ahora»).

**Pasos:**

- [ ] **Step 1: FinanceSparkline.svelte.**

```svelte
<script lang="ts">
  import { sparklinePoints } from '$lib/finance/chart-geometry';

  let { values, label, stroke = 'var(--success)' }: { values: number[]; label: string; stroke?: string } = $props();

  const points = $derived(sparklinePoints(values));
</script>

{#if points}
  <svg class="finance-sparkline" viewBox="0 0 100 32" role="img" aria-label={label}>
    <polyline {points} fill="none" {stroke} stroke-width="1.8" stroke-linejoin="round" />
  </svg>
{/if}

<style>
  .finance-sparkline { width: 6.25rem; height: 2rem; }
</style>
```

- [ ] **Step 2: CashflowChart.svelte.** (Geometría del original, dibujada a mano; tabla `sr-only` como alternativa accesible al dibujo.)

```svelte
<script lang="ts">
  import { cashflowLayout, type CashflowBucketInput } from '$lib/finance/chart-geometry';
  import { formatCents } from '$lib/finance/format';

  let { buckets }: { buckets: CashflowBucketInput[] } = $props();

  const layout = $derived(cashflowLayout(buckets));
</script>

{#if buckets.length === 0}
  <p class="audit-note">No hay movimientos en este periodo.</p>
{:else}
  <figure class="cashflow">
    <svg viewBox="0 0 {layout.width} {layout.height}" role="img"
      aria-label="Flujo de caja: barras de ingresos y gastos por periodo y línea de ahorro">
      {#each layout.ticks as tick (tick.value)}
        <line x1={layout.plot.left} x2={layout.plot.right} y1={tick.y} y2={tick.y} stroke="var(--line)" />
        <text class="cashflow-tick" x={layout.plot.left - 8} y={tick.y + 4} text-anchor="end">{tick.label}</text>
      {/each}
      {#each layout.groups as group (group.label)}
        <rect x={group.income.x} y={group.income.y} width={group.income.width} height={group.income.height} rx="2" fill="var(--success)" />
        <rect x={group.expense.x} y={group.expense.y} width={group.expense.width} height={group.expense.height} rx="2" fill="var(--danger)" />
        <text class="cashflow-tick" x={group.centerX} y={layout.height - 6} text-anchor="middle">{group.label}</text>
      {/each}
      <polyline points={layout.savings.map((point) => `${point.x},${point.y}`).join(' ')}
        fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" />
      {#each layout.savings as point, index (index)}
        <circle cx={point.x} cy={point.y} r="2.5" fill="var(--ink)" />
      {/each}
    </svg>
    <figcaption class="cashflow-legend">
      <span><i class="dot ingresos" aria-hidden="true"></i>Ingresos</span>
      <span><i class="dot gastos" aria-hidden="true"></i>Gastos</span>
      <span><i class="dot ahorro" aria-hidden="true"></i>Ahorro</span>
    </figcaption>
    <table class="sr-only">
      <caption>Flujo de caja por periodo</caption>
      <thead><tr><th>Periodo</th><th>Ingresos</th><th>Gastos</th><th>Ahorro</th></tr></thead>
      <tbody>
        {#each buckets as bucket (bucket.bucket)}
          <tr>
            <td>{bucket.bucket}</td>
            <td>{formatCents(bucket.incomeCents)}</td>
            <td>{formatCents(bucket.expenseCents)}</td>
            <td>{formatCents(bucket.savingsCents)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </figure>
{/if}

<style>
  .cashflow { margin: 0; }
  .cashflow svg { width: 100%; height: auto; }
  .cashflow-tick { font-size: var(--text-micro); fill: var(--ink-faint); }
  .cashflow-legend { display: flex; gap: var(--space-4); margin-top: var(--space-2); color: var(--ink-soft); font-size: var(--text-meta); }
  .cashflow-legend span { display: inline-flex; align-items: center; gap: var(--space-1); }
  .dot { width: .6em; height: .6em; border-radius: var(--r-full); }
  .dot.ingresos { background: var(--success); }
  .dot.gastos { background: var(--danger); }
  .dot.ahorro { background: var(--ink); }
</style>
```

- [ ] **Step 3: NatureStackChart.svelte.** Igual que el anterior pero con `natureStackLayout` y tres `rect` por grupo (`segment.nature`: `recurrente` → `var(--primary)`, `extraordinario` → `var(--info)`, `sin` → `var(--line-strong)`), la misma polyline de ahorro, leyenda «Recurrente / Extraordinario / Sin clasificar / Ahorro» y tabla `sr-only` con esas cuatro columnas. `aria-label="Gasto apilado por naturaleza y línea de ahorro"`. Lo consume Analítica en la fase 6; aquí queda construido y tipado.
- [ ] **Step 4: CategoryBars.svelte.**

```svelte
<script lang="ts">
  import { groupExpenseCategories, type BreakdownRowInput } from '$lib/finance/breakdown';
  import { formatCents } from '$lib/finance/format';

  let { rows, categories, movementsHref }: {
    rows: BreakdownRowInput[];
    categories: { id: string; name: string; parentId: string | null }[];
    movementsHref: (categoryId: string) => string;
  } = $props();

  const nameById = $derived(new Map(categories.map((category) => [category.id, category.name])));
  const groups = $derived(groupExpenseCategories(rows, nameById));
</script>

{#if groups.length === 0}
  <p class="audit-note">No hay gasto en este periodo.</p>
{:else}
  <div class="catbars">
    {#each groups as group (String(group.id))}
      <details class="catbar">
        <summary>
          <span class="catbar-name">{group.name}</span>
          <span class="catbar-track" aria-hidden="true"><i style="width: {group.percent}%"></i></span>
          <strong class="cifra pequena">{formatCents(group.totalCents.toString())}</strong>
        </summary>
        <ul>
          {#each group.subs as sub, index (index)}
            <li>
              <span>{sub.name}
                {#if sub.categoryId !== null}
                  <a class="chip" href={movementsHref(sub.categoryId)}>ver →</a>
                {/if}
              </span>
              <strong class="cifra pequena">{formatCents(sub.totalCents.toString())}</strong>
            </li>
          {/each}
        </ul>
      </details>
    {/each}
  </div>
{/if}

<style>
  .catbars { display: grid; gap: var(--space-2); }
  .catbar summary {
    display: grid; grid-template-columns: minmax(6rem, 10rem) minmax(0, 1fr) auto;
    align-items: center; gap: var(--space-3); min-height: var(--row-data); cursor: pointer;
  }
  .catbar-name { font-weight: 700; }
  .catbar-track { height: var(--space-4); overflow: hidden; border-radius: var(--r-sm); background: var(--primary-pale); }
  .catbar-track i { display: block; height: 100%; border-radius: var(--r-sm); background: var(--danger); opacity: .85; }
  .catbar ul { display: grid; gap: var(--space-1); margin: 0; padding: 0 0 var(--space-2); list-style: none; }
  .catbar li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); padding-left: var(--space-5); color: var(--ink-soft); font-size: var(--text-meta); }
</style>
```

- [ ] **Step 5: Verifica tokens y tipos.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web check` — cero errores de svelte-check y cero violaciones del linter de tokens (si el linter acusa una longitud, sustitúyela por el token `--space-*`/`--text-*` más cercano).
- [ ] **Step 6: Commit.** `git add apps/web/src/lib/components/finance && git commit -m "feat(finanzas): graficas SVG artesanales con tokens de la casa"`

---

### Task 11: FinanceFilterBar, LedgerTable y FinanceDetailPanel

**Files:**
- Create: `apps/web/src/lib/components/finance/modal-dialog.ts`
- Create: `apps/web/src/lib/components/finance/FinanceFilterBar.svelte`
- Create: `apps/web/src/lib/components/finance/LedgerTable.svelte`
- Create: `apps/web/src/lib/components/finance/FinanceDetailPanel.svelte`

**Interfaces:**
- Consumes: `mergeFilters`, `presetRanges`, `rangeLabel`, `shiftRange`, `todayLocal` de `$lib/finance/filters`; `financeApi`, `FinanceDetailMode` de `$lib/finance/api`; `formatCents`, `dateLabel`, `summarizeTxs` de `$lib/finance/format`; `import type { FinanceTxDto } from '@casa-clara/server'`; el patrón `modalDialog` de `apps/web/src/lib/components/AppShell.svelte` (líneas 137–183: cópialo tal cual a `modal-dialog.ts`, exportado, con un comentario que lo diga).
- Produces: `FinanceFilterBar { filters: FinanceFilters; accounts: { id: string; name: string; kind: string }[] }` · `LedgerTable { rows: FinanceTxDto[]; eventNameById: Record<string, string>; onOpen: (tx: FinanceTxDto) => void }` · `FinanceDetailPanel { mode: FinanceDetailMode | null; householdId: string; live?: boolean; onClose: () => void }` · `export const modalDialog: Action<HTMLElement, { onClose: () => void }>`.

**Pasos:**

- [ ] **Step 1: `modal-dialog.ts`.** Copia LITERAL de la acción `modalDialog` del AppShell (foco inicial, ciclo de Tab, Escape cierra, bloqueo de scroll, foco de vuelta), con cabecera:

```ts
import { tick } from 'svelte';
import type { Action } from 'svelte/action';

/**
 * El patrón modalDialog del AppShell (§8 de la spec ordena reutilizarlo),
 * extraído para los diálogos del módulo Finanzas. Si el AppShell lo corrige,
 * corrige aquí lo mismo: es el mismo contrato de accesibilidad.
 */
export const modalDialog: Action<HTMLElement, { onClose: () => void }> = (node, options) => {
  /* …cuerpo idéntico al de AppShell.svelte… */
};
```

- [ ] **Step 2: FinanceFilterBar.svelte.** Porta `FilterBar.tsx` del origen al idioma de la casa (chips y botones de `app.css`, `goto` con merge no destructivo):

```svelte
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    mergeFilters, presetRanges, rangeLabel, shiftRange, todayLocal,
    type FinanceFilters, type FinanceGranularity
  } from '$lib/finance/filters';

  let { filters, accounts }: {
    filters: FinanceFilters;
    accounts: { id: string; name: string; kind: string }[];
  } = $props();

  const GRANULARITIES: { id: FinanceGranularity; label: string }[] = [
    { id: 'month', label: 'Mes' }, { id: 'quarter', label: 'Trim' }, { id: 'year', label: 'Año' }
  ];
  const presets = presetRanges(todayLocal());
  let showCustom = $state(false);
  let accountsOpen = $state(false);

  // Merge NO destructivo sobre el query string vivo: las claves de otras
  // pantallas (q, cat, rec, dims…) sobreviven a cada cambio de periodo.
  function apply(patch: Partial<FinanceFilters>): void {
    const merged = mergeFilters(page.url.searchParams, { ...filters, ...patch });
    void goto(`?${merged}`, { noScroll: true, keepFocus: true });
  }

  function pickPreset(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    (event.currentTarget as HTMLSelectElement).value = '';
    if (value === 'custom') { showCustom = true; return; }
    const preset = presets.find((candidate) => candidate.label === value);
    if (preset) { showCustom = false; apply(preset.range); }
  }

  function toggleAccount(id: string): void {
    const set = new Set(filters.accountIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    apply({ accountIds: [...set] });
  }
</script>

<div class="finance-filterbar" role="group" aria-label="Filtros del periodo">
  <button type="button" class="button secondary small-button" aria-label="Periodo anterior" onclick={() => apply(shiftRange(filters, -1))}>‹</button>
  <span class="finance-range">{rangeLabel(filters)}</span>
  <button type="button" class="button secondary small-button" aria-label="Periodo siguiente" onclick={() => apply(shiftRange(filters, 1))}>›</button>

  <select class="finance-preset" aria-label="Elegir periodo" onchange={pickPreset}>
    <option value="" disabled selected>Periodo…</option>
    {#each presets as preset (preset.label)}<option value={preset.label}>{preset.label}</option>{/each}
    <option value="custom">Personalizado…</option>
  </select>

  {#if showCustom}
    <label class="finance-date">Desde <input type="date" value={filters.from} onchange={(event) => apply({ from: event.currentTarget.value })} /></label>
    <label class="finance-date">Hasta <input type="date" value={filters.to} onchange={(event) => apply({ to: event.currentTarget.value })} /></label>
  {/if}

  <span class="chip-strip" role="group" aria-label="Granularidad">
    {#each GRANULARITIES as granularity (granularity.id)}
      <button type="button" class="chip" class:active={filters.granularity === granularity.id}
        aria-pressed={filters.granularity === granularity.id}
        onclick={() => apply({ granularity: granularity.id })}>{granularity.label}</button>
    {/each}
  </span>

  <button type="button" class="chip" aria-expanded={accountsOpen} onclick={() => (accountsOpen = !accountsOpen)}>
    Cuentas{filters.accountIds.length ? ` (${filters.accountIds.length})` : ''}
  </button>
  {#if accountsOpen}
    <nav class="chip-strip finance-accounts" aria-label="Filtrar por cuenta">
      {#each accounts as account (account.id)}
        <!-- Las cuentas virtuales (inversión) también se filtran: «todas» no
             puede omitirlas en silencio (regla del original). -->
        <button type="button" class="chip" class:virtual={account.kind === 'inversion'}
          class:active={filters.accountIds.length === 0 || filters.accountIds.includes(account.id)}
          aria-pressed={filters.accountIds.length === 0 || filters.accountIds.includes(account.id)}
          onclick={() => toggleAccount(account.id)}>{account.name}</button>
      {/each}
    </nav>
  {/if}
  {#if filters.eventId}
    <button type="button" class="chip active" onclick={() => apply({ eventId: null })} aria-label="Quitar el filtro de evento">Evento filtrado ✕</button>
  {/if}
</div>

<style>
  .finance-filterbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .finance-range { min-width: 9rem; text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; }
  .finance-preset, .finance-date input { min-height: 2.75rem; border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--surface-strong); padding: var(--space-1) var(--space-2); }
  .finance-date { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--ink-soft); font-size: var(--text-meta); }
  .finance-accounts { flex-basis: 100%; }
  .chip.virtual { border-style: dashed; }
</style>
```

- [ ] **Step 3: LedgerTable.svelte.** Lista `.ledger-list` de la casa (móvil primero), fila entera pulsable que abre el panel:

```svelte
<script lang="ts">
  import type { FinanceTxDto } from '@casa-clara/server';
  import { dateLabel, formatCents } from '$lib/finance/format';

  let { rows, eventNameById, onOpen }: {
    rows: FinanceTxDto[];
    eventNameById: Record<string, string>;
    onOpen: (tx: FinanceTxDto) => void;
  } = $props();

  const STATUS_LABEL: Record<string, string> = {
    pendiente: 'pendiente', sugerida_regla: 'regla', sugerida_agente: 'agente', confirmada: 'confirmada'
  };

  const meta = (tx: FinanceTxDto): string =>
    [
      `${dateLabel(tx.opDate)} · ${tx.accountName}`,
      tx.categoryName ?? 'Sin categorizar',
      tx.eventIds.map((id) => eventNameById[id]).filter(Boolean).join(', ') || null,
      tx.recurrence === 'recurrente' ? '♻' : tx.recurrence === 'extraordinario' ? '✦' : null,
      STATUS_LABEL[tx.status] ?? tx.status
    ].filter((piece): piece is string => piece !== null).join(' · ');
</script>

<div class="ledger-list finance-ledger" data-lista="principal">
  {#each rows as tx (tx.id)}
    <button type="button" class="finance-row" onclick={() => onOpen(tx)}>
      <span>
        <strong>{tx.transferGroupId ? '⇄ ' : ''}{tx.providerDisplay || tx.provider || tx.concept}</strong>
        <small>{meta(tx)}</small>
      </span>
      <strong class="cifra pequena" class:positivo={BigInt(tx.amountCents) > 0n}>
        {formatCents(tx.amountCents, { signed: true })}
      </strong>
    </button>
  {:else}
    <div><span><strong>Sin movimientos</strong><small>No hay movimientos con estos filtros.</small></span></div>
  {/each}
</div>

<style>
  .finance-row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-3);
    min-height: var(--row-action); width: 100%;
    border: 0; border-top: 1px solid var(--line); padding: var(--space-2) 0;
    background: none; text-align: left;
  }
  .finance-row:first-child { border-top: 0; }
  .finance-row > span { display: grid; min-width: 0; }
  .finance-row small { overflow: hidden; color: var(--ink-faint); font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; }
  .positivo { color: var(--success); }
</style>
```

- [ ] **Step 4: FinanceDetailPanel.svelte.** Drawer accesible (patrón `modalDialog`), modos ids/grupo/movimiento, «Datos del origen» con `raw` y, para espejos sin `raw` con grupo, el cargo emparejado:

```svelte
<script lang="ts">
  import type { FinanceTxDto } from '@casa-clara/server';
  import { financeApi, type FinanceDetailMode } from '$lib/finance/api';
  import { dateLabel, formatCents, summarizeTxs } from '$lib/finance/format';
  import { modalDialog } from './modal-dialog';

  let { mode, householdId, live = true, onClose }: {
    mode: FinanceDetailMode | null;
    householdId: string;
    /** false en modo demo (sin base): el panel no hace fetch, pinta lo que tiene. */
    live?: boolean;
    onClose: () => void;
  } = $props();

  let fetched = $state<FinanceTxDto[] | null>(null);
  let partnerByTx = $state<Record<string, FinanceTxDto>>({});
  let loadError = $state(false);

  $effect(() => {
    fetched = null;
    partnerByTx = {};
    loadError = false;
    const current = mode;
    if (!current || !live) return;
    const api = financeApi(householdId);
    void (async () => {
      try {
        if (current.kind === 'ids') fetched = (await api.transactionsByIds(current.ids)).rows;
        else if (current.kind === 'grupo') fetched = (await api.transactionsByGroups([current.groupId])).rows;
        else if (!current.tx.raw && current.tx.transferGroupId) {
          // Espejo sin datos de fichero: los datos del origen son los del
          // cargo real emparejado en el mismo grupo (contrato del original).
          const legs = (await api.transactionsByGroups([current.tx.transferGroupId])).rows;
          const partner = legs.find((leg) => leg.id !== current.tx.id && leg.raw);
          if (partner) partnerByTx = { [current.tx.id]: partner };
        }
      } catch {
        loadError = true;
      }
    })();
  });

  const cards = $derived(mode === null ? [] : mode.kind === 'movimiento' ? [mode.tx] : (fetched ?? []));
  const figures = $derived(summarizeTxs(cards));
  const heading = $derived(
    mode === null ? ''
      : mode.kind === 'movimiento' ? (mode.tx.providerDisplay || mode.tx.provider || mode.tx.concept)
      : mode.label
  );

  const STATUS_LABEL: Record<string, string> = {
    pendiente: 'pendiente', sugerida_regla: 'regla', sugerida_agente: 'agente', confirmada: 'confirmada'
  };

  function originRows(tx: FinanceTxDto): { label: string; rows: [string, string][] } | null {
    const partner = partnerByTx[tx.id];
    const source = tx.raw ? tx : partner?.raw ? partner : tx;
    if (source.raw) {
      return {
        label: source === tx ? 'Datos del origen' : 'Datos del origen (cargo emparejado)',
        rows: Object.entries(source.raw).map(([key, value]) => [key, String(value)])
      };
    }
    const rows = (
      [
        ['Fecha valor', source.valueDate],
        ['Saldo', source.balanceCents === null ? null : formatCents(source.balanceCents)],
        ['Concepto común', source.codeCommon],
        ['Concepto propio', source.codeOwn],
        ['Categoría banco', source.bankCategory]
      ] as [string, string | null][]
    ).filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== '');
    return rows.length > 0 ? { label: 'Detalles', rows } : null;
  }
</script>

{#if mode}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="sheet-backdrop" onclick={onClose}></div>
  <aside class="finance-panel" role="dialog" aria-modal="true" aria-label="Detalle"
    use:modalDialog={{ onClose }}>
    <header class="finance-panel-head">
      <div>
        <h2>{heading}</h2>
        {#if mode.kind === 'ids' && mode.sub}<p class="finance-panel-sub">{mode.sub}</p>{/if}
        {#if mode.kind !== 'movimiento'}
          <p class="finance-panel-figs cifra pequena">
            {figures.count} mov{figures.count === 1 ? '' : 's'} · {formatCents(figures.totalCents.toString(), { signed: true })} · ticket {formatCents(figures.ticketCents.toString())}
          </p>
        {/if}
      </div>
      <button type="button" class="button secondary small-button" onclick={onClose} aria-label="Cerrar el detalle">✕</button>
    </header>

    {#if loadError}
      <p class="note error" role="status">No hemos podido cargar el detalle. Vuelve a intentarlo.</p>
    {:else if cards.length === 0 && mode.kind !== 'movimiento'}
      <p class="audit-note">{live ? 'Cargando…' : 'El detalle por grupo necesita conexión con la base de datos.'}</p>
    {/if}

    <div class="finance-panel-cards">
      {#each cards as tx (tx.id)}
        <article class="card">
          <div class="finance-panel-row">
            <span>
              <strong>{tx.concept}</strong>
              <small>{dateLabel(tx.opDate)} · {tx.accountName} · {STATUS_LABEL[tx.status] ?? tx.status}</small>
            </span>
            <strong class="cifra pequena">{formatCents(tx.amountCents, { signed: true })}</strong>
          </div>
          {#if tx.transferGroupId}<p class="audit-note">⇄ Transferencia interna (grupo vinculado).</p>{/if}
          {#if originRows(tx)}
            {@const origin = originRows(tx)!}
            <details class="finance-origen" open>
              <summary>{origin.label} · {origin.rows.length}</summary>
              <dl>
                {#each origin.rows as [key, value] (key)}
                  <div><dt>{key}</dt><dd>{value}</dd></div>
                {/each}
              </dl>
            </details>
          {/if}
        </article>
      {/each}
    </div>
  </aside>
{/if}

<style>
  .finance-panel {
    position: fixed; z-index: 80; inset-block: 0; right: 0;
    display: grid; grid-template-rows: auto 1fr; align-content: start; gap: var(--space-3);
    width: min(28rem, 100%); overflow-y: auto;
    background: var(--surface); box-shadow: var(--shadow-over); padding: var(--pad-card);
  }
  .finance-panel-head { display: flex; align-items: start; justify-content: space-between; gap: var(--space-3); }
  .finance-panel-sub { color: var(--ink-soft); font-size: var(--text-meta); }
  .finance-panel-figs { color: var(--ink-soft); }
  .finance-panel-cards { display: grid; gap: var(--space-2); align-content: start; }
  .finance-panel-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); }
  .finance-panel-row > span { display: grid; min-width: 0; }
  .finance-panel-row small { color: var(--ink-faint); font-size: var(--text-meta); }
  .finance-origen summary { min-height: var(--row-data); cursor: pointer; color: var(--ink-soft); font-size: var(--text-meta); font-weight: 700; }
  .finance-origen dl { display: grid; gap: var(--space-1); margin: 0; }
  .finance-origen div { display: grid; grid-template-columns: minmax(6rem, 10rem) minmax(0, 1fr); gap: var(--space-2); font-size: var(--text-meta); }
  .finance-origen dt { color: var(--ink-faint); }
  .finance-origen dd { margin: 0; overflow-wrap: anywhere; }
</style>
```

- [ ] **Step 5: Verifica.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web check`
- [ ] **Step 6: Commit.** `git add apps/web/src/lib/components/finance && git commit -m "feat(finanzas): barra de filtros, ledger de lectura y panel de detalle accesible"`

---

### Task 12: Dashboard — load real, página y e2e

**Files:**
- Modify: `apps/web/src/routes/h/[householdId]/finanzas/+page.server.ts` (esqueleto de fase 1)
- Modify: `apps/web/src/routes/h/[householdId]/finanzas/+page.svelte` (esqueleto de fase 1)
- Test: `apps/web/e2e/finanzas.e2e.ts`

**Interfaces:**
- Consumes: `loadFinanceDashboard`, `FinanceDashboardData` de `$lib/server/finance.server`; `getFinanceDashboardFixture` de `$lib/server/fixtures.server`; `demoOrUnavailable` de `$lib/server/data-source.server`; `parseFilters`, `todayLocal`, `mergeParams`, `rangeLabel` de `$lib/finance/filters`; `formatCents`, `formatPct`, `deltaPct` de `$lib/finance/format`; componentes de las tareas 10–11; `PageHeader` de `$lib/components/PageHeader.svelte`.
- Produces: `load` que devuelve `{ dashboard: FinanceDashboardData; demo: boolean }`. Token de invalidación: `depends('cc:finance')` (canónico `cc:finance`).

**Pasos:**

- [ ] **Step 1: e2e que falla.** `apps/web/e2e/finanzas.e2e.ts` (patrón de `apps/web/e2e/employment.e2e.ts`; corre contra la build fixture sin base de datos):

```ts
import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

test('admin en modo fixture: el Dashboard de Finanzas pinta KPIs, flujo de caja y proveedores', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Finanzas');
  await expect(page.locator('.finance-kpis .card')).toHaveCount(5);
  await expect(page.locator('.finance-kpis')).toContainText('Ingresos');
  await expect(page.locator('.finance-kpis')).toContainText('Tasa de ahorro');
  await expect(page.locator('.cashflow svg')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Top proveedores' })).toBeVisible();
});

test('la empleada no alcanza Finanzas: fail-closed con 404', async ({ page }) => {
  await loginAs(page, 'employee');
  const response = await page.goto(`/h/${HOUSEHOLD}/finanzas`);
  expect(response?.status()).toBe(404);
});
```

- [ ] **Step 2: Falla.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test:e2e finanzas.e2e.ts` — el primer test falla (la página esqueleto no tiene `.finance-kpis`).
- [ ] **Step 3: Load.** Sustituye el contenido de `finanzas/+page.server.ts` (calca el patrón de `employment/+page.server.ts`):

```ts
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceDashboard } from '$lib/server/finance.server';
import { getFinanceDashboardFixture } from '$lib/server/fixtures.server';
import { parseFilters, todayLocal } from '$lib/finance/filters';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url, depends }) => {
  // Token propio del módulo: invalidate('cc:finance') re-ejecuta solo esto.
  depends('cc:finance');
  // Los filtros viajan en la URL (compartible, con atrás/adelante); cambiar
  // el periodo es una navegación SPA que re-ejecuta este load sin recargar.
  const filters = parseFilters(url.searchParams, todayLocal());
  const dashboard = locals.user
    ? await loadFinanceDashboard({ id: locals.user.id }, params.householdId, filters)
    : null;
  if (dashboard) return { dashboard, demo: false };
  // Con base configurada aquí no hay maqueta: 503 honesto (data-source.server).
  return demoOrUnavailable(() => ({ dashboard: getFinanceDashboardFixture(filters), demo: true }));
};
```

- [ ] **Step 4: Página.** Sustituye `finanzas/+page.svelte`:

```svelte
<script lang="ts">
  import { page } from '$app/state';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import CashflowChart from '$lib/components/finance/CashflowChart.svelte';
  import CategoryBars from '$lib/components/finance/CategoryBars.svelte';
  import FinanceFilterBar from '$lib/components/finance/FinanceFilterBar.svelte';
  import FinanceSparkline from '$lib/components/finance/FinanceSparkline.svelte';
  import { mergeParams, rangeLabel } from '$lib/finance/filters';
  import { deltaPct, formatCents, formatPct } from '$lib/finance/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const dashboard = $derived(data.dashboard);
  const summary = $derived(dashboard.summary);
  const prev = $derived(summary.prev);
  const base = $derived(`/h/${dashboard.householdId}/finanzas`);
  const empty = $derived(summary.incomeCents === '0' && summary.expenseCents === '0');

  // La serie de la sparkline es una FORMA, no dinero: Number solo para píxeles.
  const savingsSpark = $derived(dashboard.series.map((point) => Number(point.savingsCents) / 100));
  const cashflowBuckets = $derived(dashboard.series.map((point) => ({
    bucket: point.bucket,
    incomeCents: BigInt(point.incomeCents),
    expenseCents: BigInt(point.expenseCents),
    savingsCents: BigInt(point.savingsCents)
  })));

  const movementsHref = (categoryId: string): string =>
    `${base}/movimientos?${mergeParams(page.url.searchParams, { cat: categoryId })}`;
</script>

{#snippet delta(nowCents: string, prevCents: string | undefined, invert: boolean)}
  {#if prevCents !== undefined}
    {@const pct = deltaPct(BigInt(nowCents), BigInt(prevCents))}
    {#if pct === null}
      <span class="status-chip">sin periodo anterior</span>
    {:else}
      {@const good = invert ? pct < 0 : pct > 0}
      <span class="status-chip {good ? 'success' : 'warning'}" title={`anterior: ${formatCents(prevCents)}`}>
        {pct > 0 ? '▲' : '▼'} {Math.abs(pct)} %
      </span>
    {/if}
  {/if}
{/snippet}

<div class="page-wrap">
  <PageHeader eyebrow="Cuentas de la casa" title="Finanzas" support={rangeLabel(dashboard.filters)} />

  <FinanceFilterBar filters={dashboard.filters} accounts={dashboard.accounts} />

  {#if empty}
    <!-- Vacío honesto: quien llega hasta aquí SÍ puede ver; es que no hay datos. -->
    <article class="card quiet-card">
      <span class="card-icon" aria-hidden="true">·</span>
      <h2>No hay movimientos en este periodo</h2>
      <p>Cambia el periodo con los filtros o <a href={`${base}/importar`}>importa un extracto</a>.</p>
    </article>
  {:else}
    <section class="finance-kpis" aria-label="Indicadores del periodo">
      <article class="card">
        <p class="eyebrow">Ingresos</p>
        <p class="cifra kpi-pos">{formatCents(summary.incomeCents)}</p>
        {@render delta(summary.incomeCents, prev?.incomeCents, false)}
      </article>
      <article class="card">
        <p class="eyebrow">Gastos</p>
        <p class="cifra kpi-neg">{formatCents(summary.expenseCents)}</p>
        {@render delta(summary.expenseCents, prev?.expenseCents, true)}
        <p class="kpi-note">♻ {formatCents(summary.recurringExpenseCents)} · ✦ {formatCents(summary.extraordinaryExpenseCents)}{summary.unclassifiedExpenseCents !== '0' ? ` · — ${formatCents(summary.unclassifiedExpenseCents)}` : ''}</p>
      </article>
      <article class="card">
        <p class="eyebrow">Ahorro</p>
        <p class="cifra">{formatCents(summary.savingsCents)}</p>
        {@render delta(summary.savingsCents, prev?.savingsCents, false)}
        <FinanceSparkline values={savingsSpark} label="Evolución del ahorro por periodo" />
      </article>
      <article class="card">
        <p class="eyebrow">Tasa de ahorro</p>
        <p class="cifra">{formatPct(summary.netSavingsRate)}</p>
        {#if summary.pendingCount > 0}
          <a class="status-chip warning" href={`${base}/revision`}>{summary.pendingCount} sin revisar</a>
        {:else}
          <span class="status-chip success">todo revisado</span>
        {/if}
      </article>
      <article class="card">
        <p class="eyebrow">Inversión</p>
        <p class="cifra kpi-pos">{formatCents(summary.investedCents)}</p>
        <p class="kpi-note">{formatPct(summary.investmentRate)} sobre ingresos</p>
      </article>
    </section>

    <article class="card">
      <div class="section-heading"><div><p class="eyebrow">Últimos 12 periodos</p><h2>Flujo de caja</h2></div></div>
      <CashflowChart buckets={cashflowBuckets} />
    </article>

    <div class="content-grid">
      <article class="card">
        <div class="section-heading"><div><h2>Gasto por categoría</h2></div></div>
        <CategoryBars rows={dashboard.breakdown} categories={dashboard.categories} {movementsHref} />
      </article>
      <article class="card">
        <div class="section-heading"><div><h2>Top proveedores</h2></div></div>
        <div class="ledger-list">
          {#each dashboard.providers as provider, index (provider.provider)}
            <div>
              <span><strong>{index + 1} · {provider.providerDisplay}</strong><small>×{provider.count}</small></span>
              <strong class="cifra pequena">{formatCents(provider.totalCents)}</strong>
            </div>
          {:else}
            <div><span><strong>Sin gasto con proveedor</strong><small>No hay proveedores en este periodo.</small></span></div>
          {/each}
        </div>
      </article>
    </div>
  {/if}
</div>

<style>
  .finance-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: var(--gap-card); }
  .finance-kpis .card { display: grid; align-content: start; gap: var(--space-1); }
  .kpi-pos { color: var(--success); }
  .kpi-neg { color: var(--danger); }
  .kpi-note { color: var(--ink-faint); font-size: var(--text-meta); }
</style>
```

- [ ] **Step 5: En verde.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web check && pnpm --filter @casa-clara/web test:e2e finanzas.e2e.ts` — los dos tests pasan. Si el test de la empleada devuelve otro código, mira qué hace el guard de fase 1 en `src/lib/auth/routing.ts` y ajusta LA ASERCIÓN al comportamiento fail-closed real (404), nunca el guard.
- [ ] **Step 6: Commit.** `git add apps/web/src/routes/h/\[householdId\]/finanzas/+page.server.ts apps/web/src/routes/h/\[householdId\]/finanzas/+page.svelte apps/web/e2e/finanzas.e2e.ts && git commit -m "feat(finanzas): dashboard real con KPIs, deltas, flujo de caja y desglose"`

---

### Task 13: Movimientos — load real, página con panel y e2e

**Files:**
- Modify: `apps/web/src/routes/h/[householdId]/finanzas/movimientos/+page.server.ts` (esqueleto de fase 1)
- Modify: `apps/web/src/routes/h/[householdId]/finanzas/movimientos/+page.svelte` (esqueleto de fase 1)
- Test: `apps/web/e2e/finanzas.e2e.ts` (ampliar)

**Interfaces:**
- Consumes: `loadFinanceMovimientos`, `FinanceMovimientosData` de `$lib/server/finance.server`; `getFinanceMovimientosFixture` de `$lib/server/fixtures.server`; `parseFilters`, `todayLocal`, `mergeParams`, `isUuid`, `rangeLabel` de `$lib/finance/filters`; `categoryPath` de `$lib/finance/breakdown`; `formatCents` de `$lib/finance/format`; `LedgerTable`, `FinanceFilterBar`, `FinanceDetailPanel` (Task 11); `FinanceDetailMode` de `$lib/finance/api`.
- Produces: `load` que devuelve `{ movimientos: FinanceMovimientosData; demo: boolean }`. Claves de URL locales de esta pantalla: `q`, `cat`, `rec` (contrato del original) y `offset` (paginación explícita).

**Pasos:**

- [ ] **Step 1: Amplía el e2e (falla).** Añade a `apps/web/e2e/finanzas.e2e.ts`:

```ts
test('admin en modo fixture: Movimientos lista el ledger y abre el panel con «Datos del origen»', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/movimientos`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Movimientos');
  const rows = page.locator('.finance-ledger .finance-row');
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  const panel = page.getByRole('dialog', { name: 'Detalle' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Datos del origen');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});
```

- [ ] **Step 2: Falla.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test:e2e finanzas.e2e.ts` — el test nuevo falla.
- [ ] **Step 3: Load.** `movimientos/+page.server.ts`:

```ts
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceMovimientos } from '$lib/server/finance.server';
import { getFinanceMovimientosFixture } from '$lib/server/fixtures.server';
import { isUuid, parseFilters, todayLocal } from '$lib/finance/filters';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 100;

export const load: PageServerLoad = async ({ locals, params, url, depends }) => {
  depends('cc:finance');
  const filters = parseFilters(url.searchParams, todayLocal());
  // Filtros locales de la pantalla (contrato del original): q, cat, rec.
  // Lo malformado se ignora en el load; la API, en cambio, responde 400.
  const category = url.searchParams.get('cat');
  const recurrence = url.searchParams.get('rec');
  const offsetRaw = Number(url.searchParams.get('offset') ?? '0');
  const query = {
    q: url.searchParams.get('q') || null,
    categoryId: category && isUuid(category) ? category : null,
    recurrence: recurrence === 'recurrente' || recurrence === 'extraordinario' ? recurrence : null,
    limit: PAGE_SIZE,
    offset: Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0
  };
  const movimientos = locals.user
    ? await loadFinanceMovimientos({ id: locals.user.id }, params.householdId, filters, query)
    : null;
  if (movimientos) return { movimientos, demo: false };
  return demoOrUnavailable(() => ({ movimientos: getFinanceMovimientosFixture(filters), demo: true }));
};
```

- [ ] **Step 4: Página.** `movimientos/+page.svelte`:

```svelte
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import FinanceDetailPanel from '$lib/components/finance/FinanceDetailPanel.svelte';
  import FinanceFilterBar from '$lib/components/finance/FinanceFilterBar.svelte';
  import LedgerTable from '$lib/components/finance/LedgerTable.svelte';
  import type { FinanceDetailMode } from '$lib/finance/api';
  import { categoryPath } from '$lib/finance/breakdown';
  import { mergeParams, rangeLabel } from '$lib/finance/filters';
  import { formatCents } from '$lib/finance/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const movimientos = $derived(data.movimientos);
  const eventNameById = $derived(Object.fromEntries(movimientos.events.map((event) => [event.id, event.name])));

  let panelMode = $state<FinanceDetailMode | null>(null);
  let searchText = $state(page.url.searchParams.get('q') ?? '');
  const currentCategory = $derived(page.url.searchParams.get('cat') ?? '');
  const currentRecurrence = $derived(page.url.searchParams.get('rec') ?? '');
  const offset = $derived(movimientos.page.offset);

  // Cambiar un filtro local vuelve a la primera página (offset fuera);
  // paginar conserva los filtros. Siempre merge no destructivo.
  function applyLocal(patch: Record<string, string | null>): void {
    void goto(`?${mergeParams(page.url.searchParams, { ...patch, offset: null })}`, { noScroll: true, keepFocus: true });
  }
  function goPage(nextOffset: number): void {
    void goto(`?${mergeParams(page.url.searchParams, { offset: nextOffset > 0 ? String(nextOffset) : null })}`, { noScroll: true });
  }
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Cuentas de la casa" title="Movimientos" support={rangeLabel(movimientos.filters)} />

  <FinanceFilterBar filters={movimientos.filters} accounts={movimientos.accounts} />

  <form class="finance-localfilters" onsubmit={(event) => { event.preventDefault(); applyLocal({ q: searchText.trim() || null }); }}>
    <input type="search" bind:value={searchText} placeholder="Buscar concepto o proveedor…" aria-label="Buscar concepto o proveedor" />
    <select aria-label="Filtrar por categoría" value={currentCategory}
      onchange={(event) => applyLocal({ cat: event.currentTarget.value || null })}>
      <option value="">Todas las categorías</option>
      {#each movimientos.categories.filter((category) => category.kind !== 'transferencia') as category (category.id)}
        <option value={category.id}>{categoryPath(movimientos.categories, category.id)}</option>
      {/each}
    </select>
    <select aria-label="Filtrar por naturaleza" value={currentRecurrence}
      onchange={(event) => applyLocal({ rec: event.currentTarget.value || null })}>
      <option value="">Todos</option>
      <option value="recurrente">♻ Recurrentes</option>
      <option value="extraordinario">✦ Extraordinarios</option>
    </select>
    <button type="submit" class="button secondary small-button">Buscar</button>
  </form>

  <article class="card">
    <LedgerTable rows={movimientos.page.rows} {eventNameById} onOpen={(tx) => (panelMode = { kind: 'movimiento', tx })} />
    <div class="ledger-total">
      <span>{movimientos.page.total} movimiento{movimientos.page.total === 1 ? '' : 's'} con estos filtros</span>
      <strong>{formatCents(movimientos.page.sumCents, { signed: true })}</strong>
    </div>
    {#if movimientos.page.total > movimientos.page.limit}
      <nav class="action-row" aria-label="Paginación">
        <button type="button" class="button secondary small-button" disabled={offset === 0}
          onclick={() => goPage(Math.max(0, offset - movimientos.page.limit))}>‹ Anteriores</button>
        <span class="audit-note">{offset + 1}–{Math.min(offset + movimientos.page.rows.length, movimientos.page.total)} de {movimientos.page.total}</span>
        <button type="button" class="button secondary small-button"
          disabled={offset + movimientos.page.limit >= movimientos.page.total}
          onclick={() => goPage(offset + movimientos.page.limit)}>Siguientes ›</button>
      </nav>
    {/if}
  </article>
</div>

<FinanceDetailPanel mode={panelMode} householdId={movimientos.householdId} live={!data.demo} onClose={() => (panelMode = null)} />

<style>
  .finance-localfilters { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .finance-localfilters input, .finance-localfilters select {
    min-height: 2.75rem; border: 1px solid var(--line-strong); border-radius: var(--r-sm);
    background: var(--surface-strong); padding: var(--space-1) var(--space-2);
  }
  .finance-localfilters input { flex: 1 1 14rem; min-width: 0; }
</style>
```

- [ ] **Step 5: En verde.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web check && pnpm --filter @casa-clara/web test:e2e finanzas.e2e.ts` — los tres tests del spec pasan.
- [ ] **Step 6: Commit.** `git add apps/web/src/routes/h/\[householdId\]/finanzas/movimientos apps/web/e2e/finanzas.e2e.ts && git commit -m "feat(finanzas): movimientos con filtros locales, paginacion explicita y panel de detalle"`

---

### Task 14: Gates de la rama y presupuesto de arranque

**Files:**
- Modify: (solo si algún gate lo exige) los ficheros de esta fase; ningún fichero nuevo.

**Interfaces:**
- Consumes: todos los productos de las tareas 1–13.
- Produces: rama en verde. Las specs nuevas quedan cableadas a CI SIN tocar `.github/workflows/ci.yml`: `finance-*.test.ts` caen en el glob del job «Unit and domain tests» y «Server, web and worker integration» (`pnpm test` / `pnpm --filter … test`), `queries.integration.test.ts` en el job de integración (que exporta `TEST_DATABASE_URL`), y `finanzas.e2e.ts` en el project `e2e` de Playwright del job «E2E and axe (fixture mode)»; `assert-suite-coverage.py` verificará que todas corrieron.

**Pasos:**

- [ ] **Step 1: Unit y tipos de todo el monorepo.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm typecheck && pnpm --filter @casa-clara/web test && TEST_DATABASE_URL=${TEST_DATABASE_URL:-postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_wt_u} pnpm --filter @casa-clara/server test` — todo verde.
- [ ] **Step 2: Lint y check.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm lint && pnpm check` — cero errores (tokens CSS incluidos).
- [ ] **Step 3: Presupuesto de Hoy.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web build && pnpm --filter @casa-clara/web verify:bundle` — el verificador debe seguir verde: NADA de `$lib/finance/`, `$lib/components/finance/` ni `@casa-clara/server` puede aparecer en el grafo inicial de Hoy (si aparece, algún import se coló fuera de las rutas de finanzas: búscalo con `.svelte-kit/casa-clara-module-map.json`).
- [ ] **Step 4: e2e completo en fixture.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm test:e2e && pnpm test:a11y` — sin regresiones en las suites existentes.
- [ ] **Step 5: db/rls intactos.** `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm test:db && pnpm test:rls` — esta fase no toca el esquema; deben seguir verdes tal cual.
- [ ] **Step 6: Commit de cierre (solo si hubo retoques).** `git add -A && git commit -m "chore(finanzas): fase 4 en verde — gates de rama y presupuesto de arranque"`
