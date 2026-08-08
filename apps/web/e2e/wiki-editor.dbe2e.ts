import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// e2e del editor visual contra Postgres real (config playwright.db.config.ts,
// `pnpm test:e2e:db`). Con DATABASE_URL y sin DATABASE_AUTH_URL el login sigue
// siendo el selector demo, pero la guía lee y escribe datos reales bajo RLS.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

test('Marta edita en el editor visual y persiste Markdown canónico (versión 2)', async ({ page }) => {
  await loginAs(page, 'family');
  await page.goto(`/h/${HOUSEHOLD}/wiki/lavadora`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lavadora · programa corto');

  // El editor es route-lazy: solo se carga al pulsar Editar; abre en visual.
  await page.getByRole('button', { name: 'Editar' }).click();
  const surface = page.locator('.milkdown-surface .ProseMirror');
  await expect(surface).toBeVisible();
  await expect(surface).toContainText('Usa el programa Mixto 40°');

  // Reemplaza el contenido con el teclado: encabezado (regla de entrada `# `)
  // y negrita (Ctrl+B del preset commonmark).
  await surface.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('# Programa nuevo');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('Importante');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type(': revisar el filtro cada mes.');

  // «Escribir en Markdown» vive en Opciones avanzadas y enseña el MISMO
  // estado, ya serializado a Markdown.
  await page.locator('.wiki-advanced summary').click();
  await page.getByRole('button', { name: 'Escribir en Markdown' }).click();
  const textarea = page.locator('#wiki-body');
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue(/# Programa nuevo/);
  await expect(textarea).toHaveValue(/\*\*Importante\*\*/);

  // De vuelta al editor con formato, rehidrata el Markdown canónico y se guarda.
  await page.getByRole('button', { name: 'Volver al editor con formato' }).click();
  await expect(surface).toBeVisible();
  await expect(surface).toContainText('Programa nuevo');
  await page.getByLabel('Qué has cambiado (opcional)').fill('Probando el editor visual');
  await page.getByRole('button', { name: 'Guardar cambios' }).click();

  // El envelope edit con baseRevision=1 crea la revisión 2 y la nota nueva.
  await expect(page.locator('.success-message')).toContainText('sincronizado');
  await expect(page.getByRole('heading', { name: 'Programa nuevo' })).toBeVisible();
  await expect(page.locator('.wiki-article')).toContainText('Importante');
  await expect(page.locator('.wiki-history summary')).toContainText('Cambios anteriores (2)');
  await expect(page.locator('.wiki-revisions')).toContainText('Versión 2');
});
