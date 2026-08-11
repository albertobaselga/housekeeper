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

  // Los controles de cada persona viven plegados bajo su fila: la lista sirve
  // para MIRAR quién entra, y cambiarlo se pide.
  await lucia.locator('summary').click();
  await lucia.getByLabel('Fecha límite del acceso').fill('2031-12-31T10:00');
  await lucia.getByRole('button', { name: 'Poner fecha límite' }).click();

  await expect(lucia.locator('.status-chip').filter({ hasText: 'Con fecha límite' })).toBeVisible();
  await expect(lucia).toContainText('puede entrar hasta el');
});

test('Alberto quita el acceso a Diego escribiendo QUITAR y la base de datos le niega el hogar (F4-03)', async ({ page, browser }) => {
  await gotoSettings(page);

  const diego = memberItem(page, 'Fixture Visor Roble');
  await diego.locator('summary').click();
  // La destructiva nombra a su sujeto en el propio botón: en una lista de seis
  // personas, «Quitar el acceso» a secas no dice a quién.
  await diego.getByRole('button', { name: 'Quitar el acceso a Fixture Visor Roble', exact: true }).click();

  // La confirmación exige escribir la palabra exacta; hasta entonces, deshabilitado.
  const confirmButton = diego.getByRole('button', { name: 'Quitar el acceso a Fixture Visor Roble ahora' });
  await expect(confirmButton).toBeDisabled();
  await diego.getByLabel('Confirmación').fill('QUITAR');
  await confirmButton.click();

  await expect(diego.locator('.status-chip').filter({ hasText: 'Sin acceso' })).toBeVisible();
  await expect(diego).toContainText('sin acceso desde el');

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

test('sin base de datos de identidad no se ofrece reponer ni cambiar contraseñas', async ({ page }) => {
  await gotoSettings(page);

  // Esta instalación tiene DATABASE_URL pero no DATABASE_AUTH_URL: hay accesos
  // que gobernar, pero ninguna contraseña que tocar. Ofrecer los botones sería
  // prometer algo que el entorno no puede cumplir.
  await expect(page.getByRole('button', { name: 'Poner una contraseña nueva' })).toHaveCount(0);
  // «Tu cuenta» sí sigue en la navegación aunque no haya contraseñas que tocar:
  // ahí vive además el interruptor de los avisos, que no depende de la identidad.
  // Lo que no puede haber es un formulario de contraseña (se comprueba abajo).
  await expect(page.getByRole('link', { name: 'Tu cuenta' })).not.toHaveCount(0);

  // El envío sale del propio documento para que lleve `Origin` y no lo pare
  // antes la protección CSRF de SvelteKit.
  const denied = await page.evaluate(async () => {
    const body = new URLSearchParams({
      membershipId: 'da-igual',
      newPassword: 'otra-cosa-2026',
      repeatPassword: 'otra-cosa-2026',
      confirm: 'REPONER'
    });
    const response = await fetch(`${location.pathname}?/resetMemberPassword`, { method: 'POST', body });
    return response.status;
  });
  expect(denied).toBe(404);

  // «Tu acceso» sí existe para cualquier rol, pero dice la verdad: aquí no hay
  // contraseña que cambiar.
  await page.goto(`/h/${HOUSEHOLD}/account`);
  await expect(page.getByText('Esta instalación no usa contraseñas.')).toBeVisible();
  await expect(page.locator('input[name="currentPassword"]')).toHaveCount(0);
});

test('la empleada alcanza «Tu acceso» aunque Ajustes sea de la familia', async ({ page }) => {
  await loginAs(page, 'employee');
  // Ajustes le está vedado (access.manage)…
  expect((await page.goto(`/h/${HOUSEHOLD}/settings`))?.status()).toBe(403);
  // …pero su propia contraseña es suya: la puerta de «Tu acceso» se abre.
  expect((await page.goto(`/h/${HOUSEHOLD}/account`))?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Cambiar tu contraseña' })).toBeVisible();
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
