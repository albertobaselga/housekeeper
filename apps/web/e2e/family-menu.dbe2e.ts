import { expect, test, type Page } from '@playwright/test';

import { E2E_SEED, HOUSEHOLD, loginAs } from './helpers';

// Menú y compra de la FAMILIA (Marta, family_member) contra Postgres real:
// bloqueo de alérgenos con reconocimiento explícito (AC-21), confirmación
// bloqueante del hueco compatible, duplicado de semana (AC-23) y añadido
// manual marcado en la lista de la compra (AC-24 básico).
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

// Hoy en la zona del hogar y su etiqueta de pestaña ("7 ago"), igual que las
// pinta la página (Intl es-ES sobre la fecha ISO en UTC).
const MADRID_TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const TODAY_TAB_LABEL = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  .format(new Date(`${MADRID_TODAY}T00:00:00Z`));

async function gotoMenu(page: Page): Promise<void> {
  await loginAs(page, 'family');
  await page.goto(`/h/${HOUSEHOLD}/menu`);
  await expect(page.getByRole('heading', { name: 'Menú de la casa' })).toBeVisible();
}

test('Marta asigna la receta con leche al grupo Casa: bloqueo de alérgenos y reconocimiento explícito (AC-21)', async ({ page }) => {
  await gotoMenu(page);

  // Default sensato: el menú abre con la pestaña de HOY activa, no el lunes.
  const activeDay = page.locator('.day-tabs button.active');
  await expect(activeDay).toHaveAttribute('aria-selected', 'true');
  await expect(activeDay).toContainText(TODAY_TAB_LABEL);

  const groupCard = page.locator('section.menu-group-card').filter({ hasText: 'Casa' });
  await expect(groupCard).toContainText('Leo (comensal E2E)');

  // Hueco «Comida» de hoy (pestaña por defecto) del grupo sembrado.
  const comidaRow = groupCard.locator('.menu-slot-row').filter({ hasText: 'Comida' });
  await comidaRow.getByRole('button', { name: 'Asignar' }).click();

  const editor = groupCard.locator('form.menu-slot-editor');
  await editor.getByLabel('Receta del hogar').selectOption(E2E_SEED.recipePages.conLeche);

  // El bloqueo aparece con el comensal afectado y el guardado queda inhabilitado.
  const block = editor.locator('.allergen-block');
  await expect(block).toContainText('Bloqueado por incompatibilidad de alérgenos');
  await expect(block).toContainText('Leche y derivados (lactosa) — afecta a Leo (comensal E2E)');
  await expect(editor.getByRole('button', { name: 'Guardar hueco' })).toBeDisabled();

  // Reconocimiento explícito → guardar. El hueco queda con la alerta visible.
  await block.getByRole('checkbox', { name: /asumo la decisión/ }).check();
  await editor.getByRole('button', { name: 'Guardar hueco' }).click();
  await expect(comidaRow.getByRole('link', { name: 'Arroz con leche (E2E)' })).toBeVisible();
  await expect(comidaRow.getByRole('alert')).toContainText('Incompatibilidad de alérgenos');
  await expect(comidaRow.getByRole('alert')).toContainText('Leo (comensal E2E)');
});

test('Marta asigna la receta compatible y confirma el hueco', async ({ page }) => {
  await gotoMenu(page);

  const groupCard = page.locator('section.menu-group-card').filter({ hasText: 'Casa' });
  const cenaRow = groupCard.locator('.menu-slot-row').filter({ hasText: 'Cena' });
  await cenaRow.getByRole('button', { name: 'Asignar' }).click();

  const editor = groupCard.locator('form.menu-slot-editor');
  await editor.getByLabel('Receta del hogar').selectOption(E2E_SEED.recipePages.sinAlergenos);
  await expect(editor.locator('.allergen-block')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Guardar hueco' }).click();
  await expect(cenaRow.getByRole('link', { name: 'Pollo asado (E2E)' })).toBeVisible();

  // Confirmación bloqueante ligada al hash del contenido leído en esta carga.
  await cenaRow.getByRole('button', { name: 'Confirmar' }).click();
  await expect(cenaRow.locator('.status-chip').filter({ hasText: 'Confirmado' })).toBeVisible();
});

test('Marta duplica la semana en la siguiente (AC-23)', async ({ page }) => {
  await gotoMenu(page);

  await page.getByRole('button', { name: 'Duplicar en la semana siguiente' }).click();

  // Feedback visible del resultado, sin tener que navegar a comprobarlo.
  await expect(page.locator('.success-message').filter({ hasText: 'copiada a la del' })).toBeVisible();

  await page.getByRole('link', { name: 'Semana siguiente →' }).click();

  // El mismo día de la semana siguiente (la navegación conserva el día activo)
  // replica los dos huecos asignados.
  const groupCard = page.locator('section.menu-group-card').filter({ hasText: 'Casa' });
  await expect(groupCard.getByRole('link', { name: 'Arroz con leche (E2E)' })).toBeVisible();
  await expect(groupCard.getByRole('link', { name: 'Pollo asado (E2E)' })).toBeVisible();
});

test('Marta añade un artículo manual a la compra y lo marca (AC-24)', async ({ page }) => {
  await gotoMenu(page);
  await page.getByRole('button', { name: 'Lista de la compra' }).click();

  // La parte derivada del menú de esta semana ya está presente.
  await expect(page.locator('.ingredient-list li').filter({ hasText: 'Leche entera E2E' })).toContainText('del menú');

  const addForm = page.locator('form.action-form').filter({ hasText: 'Nombre libre' });
  await addForm.getByRole('textbox', { name: 'Nombre libre' }).fill('Servilletas E2E');
  await addForm.getByLabel('Cantidad').fill('2');
  await addForm.getByLabel('Unidad').fill('paquetes');
  await addForm.getByLabel('Sección').fill('hogar');
  await addForm.getByRole('button', { name: 'Añadir a la compra' }).click();

  const item = page.locator('.ingredient-list li').filter({ hasText: 'Servilletas E2E' });
  await expect(item).toBeVisible();
  await item.getByRole('checkbox').check();
  await expect(item.getByRole('checkbox')).toBeChecked();
  await expect(item).toHaveClass(/checked/);
});
