import { expect, test } from '@playwright/test';

import pg from 'pg';

import { E2E_SEED, HOUSEHOLD, loginAs } from './helpers';

test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

async function onDatabase(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`BEGIN; SET LOCAL row_security = off;\n${sql}\nCOMMIT;`);
  } finally {
    await client.end();
  }
}

// [FASE 5, T10 · corrección Minor 4] Este caso confirma dos de las tres filas
// sembradas (quedan `confirmada`): las baterías vecinas que visitan Revisión
// después de esta (mobile-densidad, entre otras) tienen que encontrar el
// hogar como estaba, mismo criterio que `finanzas-concesion.dbe2e.ts`.
test.afterAll(async () => {
  await onDatabase(`
    UPDATE app.finance_transactions SET status = 'pendiente', category_id = NULL
     WHERE id = '${E2E_SEED.finanzas.txSuper}';
    UPDATE app.finance_transactions SET status = 'sugerida_regla', category_id = '${E2E_SEED.finanzas.catCasa}'
     WHERE id = '${E2E_SEED.finanzas.txSugerida}';
  `);
});

test('el admin con concesión confirma un pendiente desde Revisión', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/revision`);

  // Badge de pendientes visible en la navegación del módulo.
  await expect(page.locator('.revision-badge')).toBeVisible();

  const fila = page.locator('tr', { hasText: 'SUPERMERCADO RIO E2E' });
  await expect(fila).toBeVisible();
  await fila.getByRole('combobox', { name: 'Categoría' }).selectOption({ label: 'Casa E2E' });
  await expect(page.locator('.success-message')).toContainText('Guardado ✓');
  await fila.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.locator('.success-message')).toContainText('Guardado ✓');
  await expect(page.locator('tr', { hasText: 'SUPERMERCADO RIO E2E' })).toHaveCount(0);

  // [FASE 5, T10 · corrección Important 3] La fila sembrada `sugerida_regla`
  // con categoría ya asignada (`txSugerida`) activa el botón de confirmación
  // en lote (`finance.transactions.bulk`): hasta esta corrección ni el dbe2e
  // ni la maqueta ejercitaban ese camino ni los estados sugerida_* de
  // STATUS_LABEL.
  const boton = page.getByRole('button', { name: '✓ Confirmar 1 sugerencia' });
  await expect(boton).toBeVisible();
  await boton.click();
  await expect(page.locator('.success-message')).toContainText('Guardado ✓');
  await expect(page.locator('tr', { hasText: 'CAFETERA EXPRESS E2E' })).toHaveCount(0);
});
