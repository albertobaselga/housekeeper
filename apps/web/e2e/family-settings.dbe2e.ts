import { expect, test, type Page } from '@playwright/test';

import { ACCOUNT_EMAILS, HOUSEHOLD, loginAs } from './helpers';

// Gestión de accesos del hogar (Alberto, family_admin) contra Postgres real:
// fecha límite futura para el apoyo, retirada del acceso puntual escribiendo
// QUITAR (F4-03) y descarga del traspaso operativo (F4-02). Los nombres son
// los display_name reales de las fixtures (`Fixture Apoyo Roble`…), no los de
// la maqueta demo.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

const ACCESS_HEADING = '¿Hasta cuándo puede entrar cada persona?';

async function gotoSettings(page: Page): Promise<void> {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/settings`);
  await expect(page.getByRole('heading', { name: ACCESS_HEADING })).toBeVisible();
}

function memberItem(page: Page, name: string) {
  return page
    .locator('section', { has: page.getByRole('heading', { name: ACCESS_HEADING }) })
    .locator('li')
    .filter({ hasText: name });
}

test('Alberto pone una fecha límite futura a Lucía y aparece «Con fecha límite»', async ({ page }) => {
  await gotoSettings(page);

  const lucia = memberItem(page, 'Fixture Apoyo Roble');
  await expect(lucia.locator('.status-chip').filter({ hasText: 'Activo' })).toBeVisible();

  await lucia.getByLabel('Fecha límite del acceso').fill('2031-12-31T10:00');
  await lucia.getByRole('button', { name: 'Poner fecha límite' }).click();

  await expect(lucia.locator('.status-chip').filter({ hasText: 'Con fecha límite' })).toBeVisible();
  await expect(lucia).toContainText('Puede entrar hasta el');
});

test('Alberto quita el acceso a Diego escribiendo QUITAR y la base de datos le niega el hogar (F4-03)', async ({ page, browser }) => {
  await gotoSettings(page);

  const diego = memberItem(page, 'Fixture Visor Roble');
  await diego.getByRole('button', { name: 'Quitar el acceso', exact: true }).click();

  // La confirmación exige escribir la palabra exacta; hasta entonces, deshabilitado.
  const confirmButton = diego.getByRole('button', { name: 'Quitar el acceso ahora' });
  await expect(confirmButton).toBeDisabled();
  await diego.getByLabel('Confirmación').fill('QUITAR');
  await confirmButton.click();

  await expect(diego.locator('.status-chip').filter({ hasText: 'Sin acceso' })).toBeVisible();
  await expect(diego).toContainText('Sin acceso desde el');

  // Nueva pestaña/contexto: Diego aún puede abrir el selector demo (la cáscara
  // de sesión es fixture), pero la base de datos rechaza cualquier operación
  // sobre el hogar en su siguiente petición: membresía revocada bajo RLS.
  const revokedContext = await browser.newContext();
  try {
    const revokedPage = await revokedContext.newPage();
    await revokedPage.goto('/login');
    await revokedPage.locator('button.account-card', { hasText: ACCOUNT_EMAILS.viewer }).click();
    await revokedPage.waitForURL(`**/h/${HOUSEHOLD}/today`);

    const response = await revokedPage.request.post('/api/v1/sync', {
      data: {
        apiVersion: 1,
        commands: [
          {
            apiVersion: 1,
            operationId: crypto.randomUUID(),
            householdId: HOUSEHOLD,
            schemaVersion: 1,
            aggregateType: 'shopping_item',
            aggregateId: null,
            baseRevision: null,
            occurredAt: new Date().toISOString(),
            payload: { action: 'add', customName: 'Prueba revocación E2E' }
          }
        ]
      }
    });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      acknowledgements: Array<{ status: string; errorCode?: string }>;
    };
    expect(body.acknowledgements[0]?.status).toBe('rejected');
    expect(body.acknowledgements[0]?.errorCode).toBe('not_authorized');
  } finally {
    await revokedContext.close();
  }
});

test('Alberto descarga el traspaso operativo como ZIP (F4-02)', async ({ page }) => {
  await gotoSettings(page);

  const link = page.getByRole('link', { name: 'Descargar traspaso (apoyo)' });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toBe(`/api/v1/households/${HOUSEHOLD}/handover?audience=helper`);

  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('application/zip');
  expect(response.headers()['content-disposition']).toContain('traspaso-helper.zip');
});
