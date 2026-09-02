import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { getFinanceRevisionFixture } from '../src/lib/server/fixtures.server';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

/**
 * La pantalla de Revisión no tiene librería de montaje en este repo (vitest
 * corre en `node`): estas pruebas vigilan su FUENTE, mismo patrón que
 * `finance-pivot-actionbar.test.ts`. El comportamiento en un navegador de
 * verdad lo cubren `e2e/finanzas-revision.e2e.ts` (maqueta) y
 * `e2e/finanzas-revision.dbe2e.ts` (con base).
 */
let revision = '';

beforeAll(async () => {
  revision = await readFile(
    new URL('../src/routes/h/[householdId]/finanzas/revision/+page.svelte', import.meta.url),
    'utf8'
  );
});

describe('F5-I7 (2): «Crear regla al confirmar» no se ofrece sin proveedor', () => {
  it('la casilla se deshabilita y dice por qué', () => {
    expect(revision).toContain('disabled={!row.provider}');
    expect(revision).toContain('Sin proveedor no se puede crear una regla');
  });

  it('la maqueta trae una fila sin proveedor para que el e2e vea la casilla apagada', () => {
    const filas = getFinanceRevisionFixture({ from: '2026-01-01', to: '2026-08-31' }).rows;
    expect(filas.some((fila) => fila.provider === null)).toBe(true);
    expect(filas.some((fila) => fila.provider !== null)).toBe(true);
  });
});

describe('F5-I1: el aviso de «hay más pendientes» es un status, no un adorno', () => {
  it('se pinta con role="status" y solo cuando el conteo supera a las filas cargadas', () => {
    expect(revision).toContain('role="status"');
    expect(revision).toContain('totalPending > loaded.length');
    expect(revision).toContain('movimientos más recientes de');
  });

  it('la maqueta declara tantos pendientes como filas: sin aviso en demo', () => {
    const fixture = getFinanceRevisionFixture({ from: '2026-01-01', to: '2026-08-31' });
    expect(fixture.totalPending).toBe(fixture.rows.length);
  });
});
