import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { getFinanceAjustesFixture } from '../src/lib/server/fixtures.server';

// Mismo motivo que en finance-fixtures.test.ts (Ruling R19): `demoOnly()`
// consulta `$env/dynamic/private` en cada llamada, y quien tenga DATABASE_URL
// exportada en su shell vería fallar en falso las maquetas.
vi.mock('$env/dynamic/private', () => ({ env: {} }));

/**
 * [FASE 5 · despacho de cierre, F5-C1] La columna `bank_ref` de
 * `app.finance_accounts` es NULLABLE (`packages/db/migrations/0036_finance.sql:110`,
 * `CHECK (bank_ref IS NULL OR …)`) y el ETL de la fase 3 la deja vacía para las
 * cuentas virtuales del origen (efectivo, inversión, manual). El tipo de fila
 * decía `bankRef: string` y la plantilla hacía `{account.bankRef.slice(-4)}`:
 * la primera cuenta de Efectivo de un hogar migrado tumbaba /finanzas/ajustes
 * entera en SSR con un `TypeError: Cannot read properties of null`.
 *
 * No hay librería de montaje de componentes Svelte en este repo (vitest corre
 * en `node`): la plantilla se vigila leyendo su FUENTE, mismo patrón que
 * `finance-pivot-actionbar.test.ts` y `finance-grant-card.test.ts`. La
 * regresión de comportamiento la sujeta además el e2e de fixture
 * `finanzas-ajustes.e2e.ts`, que renderiza esa cuenta de verdad.
 */
let ajustesPage = '';

beforeAll(async () => {
  ajustesPage = await readFile(
    new URL('../src/routes/h/[householdId]/finanzas/ajustes/+page.svelte', import.meta.url),
    'utf8'
  );
});

describe('F5-C1: una cuenta sin referencia bancaria no puede tumbar Ajustes', () => {
  it('la maqueta trae una cuenta de Efectivo sin banco ni referencia', () => {
    const cuentas = getFinanceAjustesFixture().accounts;
    expect(cuentas.length).toBeGreaterThan(1);
    const efectivo = cuentas.find((cuenta) => cuenta.bankRef === null);
    expect(efectivo).toBeDefined();
    expect(efectivo?.bank).toBeNull();
    // Y sigue habiendo una cuenta CON referencia: sin ella el caso feliz
    // («…5678») dejaría de estar cubierto por el mismo corpus.
    expect(cuentas.some((cuenta) => typeof cuenta.bankRef === 'string')).toBe(true);
  });

  it('la plantilla nunca desreferencia bankRef sin guarda', () => {
    // Toda aparición de `.slice` sobre `bankRef` va DENTRO de una plantilla
    // (`${…}`), es decir, dentro del ternario que ya comprobó el nulo: la
    // interpolación suelta `{account.bankRef.slice(…)}` —la que reventaba— ya
    // no aparece en ninguna parte del fichero.
    expect(ajustesPage).not.toMatch(/(?<!\$)\{account\.bankRef\.slice/);
    expect(ajustesPage).toContain("account.bankRef ? `…${account.bankRef.slice(-4)}` : '—'");
  });

  it('el banco nulo se pinta con el mismo guion que el resto de celdas vacías', () => {
    expect(ajustesPage).toContain("account.bank ?? '—'");
  });
});
