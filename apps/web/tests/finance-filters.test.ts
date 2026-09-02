import { describe, expect, it } from 'vitest';

import {
  DATE_PATTERN,
  apiQuery,
  isGranularity,
  isUuid,
  mergeFilters,
  mergeParams,
  monthRange,
  monthsAgoISO,
  parseDateRange,
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

  it('lee from/to/g y descarta lo malformado', () => {
    const params = new URLSearchParams('from=2026-02-01&to=2026-02-28&g=quarter');
    expect(parseFilters(params, TODAY)).toEqual({
      from: '2026-02-01', to: '2026-02-28', granularity: 'quarter', accountIds: [], eventId: null
    });
    expect(parseFilters(new URLSearchParams('g=bogus&from=ayer'), TODAY).granularity).toBe('month');
    expect(parseFilters(new URLSearchParams('g=bogus&from=ayer'), TODAY).from).toBe('2026-01-01');
  });

  // I1: `acc`/`ev` que no son UUID llegarían a `tx.account_id = any($n::uuid[])`
  // / `te.event_id = $n` y Postgres respondería 22P02 (invalid input syntax),
  // que el catch de los loaders confunde con una avería (503 falso). Mismo
  // criterio de «descartar lo malformado» que ya aplica a from/to/g.
  it('descarta acc/ev que no son UUID (antes sobrevivían y tumbaban el load con un 503 falso)', () => {
    const params = new URLSearchParams('acc=a1,a2&ev=e9');
    expect(parseFilters(params, TODAY).accountIds).toEqual([]);
    expect(parseFilters(params, TODAY).eventId).toBeNull();
  });

  it('acc mezcla un UUID válido con basura: solo sobrevive el válido', () => {
    const validUuid = '11000000-0000-4000-8000-000000000001';
    const params = new URLSearchParams(`acc=${validUuid},a2`);
    expect(parseFilters(params, TODAY).accountIds).toEqual([validUuid]);
  });

  // m10(a): sin este descarte, spanMonths sale negativo, rangeLabel se pinta
  // al revés y la consulta devuelve cero filas sin decir por qué.
  it('to < from: descarta to como malformado y cae al valor por defecto', () => {
    const params = new URLSearchParams('from=2026-05-01&to=2026-04-01');
    expect(parseFilters(params, TODAY)).toMatchObject({ from: '2026-05-01', to: '2026-08-31' });
  });

  it('acc/ev con UUID válido: pasan tal cual', () => {
    const validUuid = '11000000-0000-4000-8000-000000000001';
    const params = new URLSearchParams(`acc=${validUuid}&ev=${validUuid}`);
    expect(parseFilters(params, TODAY).accountIds).toEqual([validUuid]);
    expect(parseFilters(params, TODAY).eventId).toBe(validUuid);
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

describe('isUuid y DATE_PATTERN: exportados para que otras tareas no copien el regex', () => {
  it('isUuid reconoce un UUID válido en mayúsculas o minúsculas', () => {
    expect(isUuid('11000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('11000000-0000-4000-8000-000000000001'.toUpperCase())).toBe(true);
  });

  it('isUuid rechaza la cadena vacía y un casi-UUID', () => {
    expect(isUuid('')).toBe(false);
    // Un carácter corto en el último grupo: la forma es casi correcta.
    expect(isUuid('11000000-0000-4000-8000-00000000001')).toBe(false);
  });

  it('DATE_PATTERN acepta yyyy-mm-dd y rechaza el resto', () => {
    expect(DATE_PATTERN.test('2026-08-31')).toBe(true);
    expect(DATE_PATTERN.test('ayer')).toBe(false);
    expect(DATE_PATTERN.test('2026-8-31')).toBe(false);
    expect(DATE_PATTERN.test('')).toBe(false);
  });

  // m2: única guarda de granularidad (antes `parseFilters` asertaba `as
  // FinanceGranularity` sobre un valor crudo de la URL, y `series/+server.ts`
  // reimplementaba la misma comprobación en vez de importar esta).
  it('isGranularity reconoce month/quarter/year y rechaza el resto', () => {
    expect(isGranularity('year')).toBe(true);
    expect(isGranularity('week')).toBe(false);
    expect(isGranularity('')).toBe(false);
  });

  it('parseFilters con g=week (no es una granularidad válida) cae al valor por defecto', () => {
    expect(parseFilters(new URLSearchParams('g=week'), TODAY).granularity).toBe('month');
  });
});

// [FASE 5, T10 · corrección Minor 7] `revision/+page.server.ts` reimplementaba
// esto con `date.setUTCMonth(date.getUTCMonth() - months)`: un día 31 con un
// mes destino más corto se desbordaba al mes siguiente (31/8 − 6 → 3/3, no
// 28/2). Se movió aquí para reutilizar `addMonths`/`daysInMonth`, que ya
// resuelven el mismo desborde para `rangeOfMonths`/`shiftRange`.
describe('monthsAgoISO (rango rodante de la bandeja de Revisión)', () => {
  it('31 de agosto menos 6 meses clampa a 28 de febrero, no se desborda a marzo', () => {
    expect(monthsAgoISO(6, new Date(Date.UTC(2026, 7, 31)))).toBe('2026-02-28');
  });

  it('29 de febrero (bisiesto) menos 12 meses clampa a 28 de febrero del año anterior', () => {
    expect(monthsAgoISO(12, new Date(Date.UTC(2024, 1, 29)))).toBe('2023-02-28');
  });

  it('un mes de igual longitud conserva el día exacto', () => {
    expect(monthsAgoISO(1, new Date(Date.UTC(2026, 8, 15)))).toBe('2026-08-15');
  });

  it('cruza el cambio de año', () => {
    expect(monthsAgoISO(2, new Date(Date.UTC(2026, 0, 15)))).toBe('2025-11-15');
  });
});

// [FASE 5 · despacho de cierre, F5-I2 + T11-R3 + F5-M3 + N3] Revisión mandaba
// `from`/`to` CRUDOS de la URL a Postgres (22007 → `unreadable` → 503 en
// pantalla y un `log.error` por visita, desde un enlace mal escrito), Eventos
// validaba la forma pero no el calendario ni `to >= from`, y las dos calculaban
// «hoy» en UTC en vez de en Europe/Madrid (de madrugada, el `to` por omisión
// era ayer). Un solo saneado para las dos.
describe('parseDateRange: el rango de la URL, saneado en un solo sitio', () => {
  it('sin parámetros: los últimos 6 meses hasta hoy', () => {
    expect(parseDateRange(new URLSearchParams(), TODAY)).toEqual({ from: '2026-02-28', to: TODAY });
  });

  it('una fecha con forma correcta pero imposible (2026-13-40) cae al valor por omisión', () => {
    // DATE_PATTERN la acepta —solo mira la FORMA—, y así llegaba a Postgres.
    expect(DATE_PATTERN.test('2026-13-40')).toBe(true);
    expect(parseDateRange(new URLSearchParams('from=2026-13-40&to=2026-02-30'), TODAY)).toEqual({
      from: '2026-02-28',
      to: TODAY
    });
  });

  it('«ayer» y demás basura caen igual, sin llegar nunca a la consulta', () => {
    expect(parseDateRange(new URLSearchParams('from=ayer&to=hoy'), TODAY)).toEqual({
      from: '2026-02-28',
      to: TODAY
    });
  });

  it('un rango válido pasa tal cual', () => {
    expect(parseDateRange(new URLSearchParams('from=2026-04-01&to=2026-04-30'), TODAY)).toEqual({
      from: '2026-04-01',
      to: '2026-04-30'
    });
  });

  it('to < from: el rango se cierra en from, nunca al revés (N3)', () => {
    expect(parseDateRange(new URLSearchParams('from=2026-05-01&to=2026-04-01'), TODAY)).toEqual({
      from: '2026-05-01',
      to: '2026-05-01'
    });
  });

  it('un from futuro tampoco invierte el rango: el to por omisión se ancla en from', () => {
    expect(parseDateRange(new URLSearchParams('from=2027-01-01'), TODAY)).toEqual({
      from: '2027-01-01',
      to: '2027-01-01'
    });
  });

  it('la ventana por omisión es un parámetro, no una constante escondida', () => {
    expect(parseDateRange(new URLSearchParams(), TODAY, 1)).toEqual({ from: '2026-07-31', to: TODAY });
  });
});

// N3 en `parseFilters`: hasta ahora un `from` futuro dejaba el `to` por
// omisión (hoy) POR DEBAJO del from — spanMonths negativo y cero filas sin
// explicación.
describe('parseFilters: el rango nunca queda invertido', () => {
  it('from futuro: el to por omisión se ancla en from en vez de quedar detrás', () => {
    expect(parseFilters(new URLSearchParams('from=2027-03-01'), TODAY)).toMatchObject({
      from: '2027-03-01',
      to: '2027-03-01'
    });
  });

  it('una fecha imposible con forma correcta se descarta como cualquier otra basura', () => {
    expect(parseFilters(new URLSearchParams('from=2026-02-30'), TODAY)).toMatchObject({
      from: '2026-01-01',
      to: TODAY
    });
  });
});
