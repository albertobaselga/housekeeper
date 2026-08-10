import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// La Guía de la casa como manual de acogida, contra Postgres real:
//   1. quien no administra no ve NI UN control de escritura;
//   2. el modo libro marca leída la nota al pasar de página;
//   3. la administración ve quién la ha completado y qué le falta, y NO un
//      rastro de a qué hora leyó cada cual qué nota.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

/** Todo lo que significa «escribir la Guía». Ninguno debe existir sin permiso. */
const WRITE_CONTROLS = [
  'Editar',
  'Escribir una instrucción',
  'Publicar',
  'Destacar',
  'Quitar de destacados',
  'Crear apartado',
  'Guardar y publicar',
  'Usar como modelo (avanzado)'
];

async function expectNoWriteControls(page: Page): Promise<void> {
  for (const label of WRITE_CONTROLS) {
    await expect(
      page.getByRole('button', { name: label }),
      `«${label}» no debería dibujarse para quien no escribe la Guía`
    ).toHaveCount(0);
  }
  // El panel de mantenimiento entero (modelos, huecos de búsqueda) tampoco.
  await expect(page.locator('.wiki-maintenance')).toHaveCount(0);
  await expect(page.locator('.wiki-composer')).toHaveCount(0);
}

test('la interna lee la Guía y no encuentra ni un control de escritura', async ({ page }) => {
  await loginAs(page, 'employee');

  await page.goto(`/h/${HOUSEHOLD}/wiki`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Guía de la casa');
  await expectNoWriteControls(page);

  // Ni en la portada ni dentro de una nota.
  await page.goto(`/h/${HOUSEHOLD}/wiki/lavadora`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lavadora');
  await expectNoWriteControls(page);

  // Consultar sigue funcionando exactamente igual: es el propósito de la Guía.
  await expect(page.locator('.wiki-article')).toContainText('Mixto 40°');
});

test('la familiar no administradora tampoco escribe la Guía', async ({ page }) => {
  await loginAs(page, 'family');
  await page.goto(`/h/${HOUSEHOLD}/wiki`);
  await expectNoWriteControls(page);
});

test('la administradora sí escribe, y su portada lo dice', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/wiki`);
  await expect(page.getByRole('button', { name: 'Escribir una instrucción' })).toBeVisible();
  await expect(page.locator('.wiki-maintenance')).toHaveCount(1);
});

test('el modo libro pasa de página y deja la anterior marcada como leída', async ({ page }) => {
  await loginAs(page, 'employee');

  await page.goto(`/h/${HOUSEHOLD}/wiki`);
  // La portada invita a leerla entera sin esconder la consulta suelta.
  await page.getByRole('link', { name: /Empezar a leer|Seguir leyendo/ }).click();

  // El libro abre por la primera nota pendiente, en orden de capítulo.
  await expect(page).toHaveURL(new RegExp(`/wiki/libro/`));
  const first = page.getByRole('heading', { level: 1 });
  await expect(first).toContainText('Principios de la casa');
  await expect(page.locator('.book-progress')).toContainText('Nota 1 de 3');

  // La regla de lectura pide llegar al final y un mínimo de permanencia: pasar
  // de página al instante no cuenta, así que aquí se lee de verdad.
  await page.locator('.book-end').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2_200);
  await page.getByRole('button', { name: /Siguiente/ }).click();

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Jornada y descansos');
  await expect(page.locator('.book-progress')).toContainText('has leído 1');

  // Al volver atrás, la anterior consta como leída.
  await page.getByRole('link', { name: /Anterior/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Principios de la casa');
  await expect(page.locator('.book-flag')).toContainText('Leída');

  // Y el progreso propio lo confirma.
  await page.goto(`/h/${HOUSEHOLD}/wiki/progreso`);
  await expect(page.locator('.card').first()).toContainText('Llevas 1 de 3 notas');
});

test('el modo libro se lee y se navega con el teclado', async ({ page }) => {
  await loginAs(page, 'helper');
  await page.goto(`/h/${HOUSEHOLD}/wiki/libro/principios-de-la-casa`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Principios de la casa');

  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Jornada y descansos');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Principios de la casa');
});

test('el modo libro cabe y se maneja en un móvil de 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/wiki/libro/principios-de-la-casa`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  // El botón de pasar de página queda al alcance del pulgar sin buscarlo.
  const next = page.getByRole('button', { name: /Siguiente/ });
  await expect(next).toBeInViewport();
});

test('la administración ve quién ha completado y qué falta, no un rastro por horas', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/wiki/progreso`);

  const casa = page.locator('.card', { hasText: 'Quién se ha leído la guía' });
  await expect(casa).toBeVisible();
  // Cuentas por apartado: cuánto lleva cada cual y cuánto le falta.
  await expect(casa).toContainText('Le faltan');
  await expect(casa.locator('.guide-chapter-count').first()).toContainText('de');

  // Y NADA que reconstruya un rastro: ni horas, ni fechas, ni qué nota abrió.
  const shown = (await casa.innerText()).toLowerCase();
  expect(shown).not.toMatch(/\d{1,2}:\d{2}/);
  expect(shown).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(shown).not.toContain('principios de la casa');
  expect(shown).not.toContain('jornada y descansos');
  expect(shown).not.toContain('lavadora');
  // La pantalla lo dice con todas las letras, que es parte del trato.
  expect(shown).toContain('no hay horas');
});
