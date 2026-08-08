import { expect, test, type Page } from '@playwright/test';

import { E2E_SEED, HOUSEHOLD, loginAs } from './helpers';

// Ola B (comida) contra Postgres real: lo que la revisión de intuitividad
// señaló como estructural y no se arreglaba con literales.
//
//  · P2-4 — casilla también en los artículos «del menú», fusión de un añadido
//    a mano con lo derivado en UNA línea con el origen a la vista, y redondeo a
//    medidas de compra cuando el alimento declara su tamaño de paquete.
//  · Anexo H — sección «Personal» de la persona interna: la ve ella (y la
//    administración), y para el apoyo no existe (RLS real, no filtro de UI).
//  · P1-7 — alta de comensal progresiva: primero solo el nombre y la matriz de
//    alérgenos únicamente si se abre el desplegable.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

// Semana propia, lejos de las que usan family-menu (actual y +1) y
// family-menu-plus (+3 y +5).
const MADRID_TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

function mondayPlus(weeks: number): string {
  const base = new Date(`${MADRID_TODAY}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - ((base.getUTCDay() + 6) % 7) + weeks * 7);
  return base.toISOString().slice(0, 10);
}

const WEEK = mondayPlus(9);
const DINER_NAME = 'Nieta sin alergias E2E';

async function gotoShopping(page: Page, account: 'family' | 'employee' | 'helper'): Promise<void> {
  await loginAs(page, account);
  await page.goto(`/h/${HOUSEHOLD}/menu?week=${WEEK}`);
  await page.getByRole('button', { name: 'Lista de la compra' }).click();
}

test('Marta planifica la semana y marca como comprado un artículo «del menú» (P2-4)', async ({ page }) => {
  await loginAs(page, 'family');
  await page.goto(`/h/${HOUSEHOLD}/menu?week=${WEEK}`);
  await expect(page.getByRole('heading', { name: 'Menú de la casa' })).toBeVisible();

  // El arroz con leche choca con Leo (lácteos): hay que reconocerlo (AC-21).
  const groupCard = page.locator('section.menu-group-card').filter({ hasText: 'Casa' });
  const comidaRow = groupCard.locator('.menu-slot-row').filter({ hasText: 'Comida' });
  await comidaRow.getByRole('button', { name: 'Asignar' }).click();
  const editor = groupCard.locator('form.menu-slot-editor');
  await editor.getByLabel('Receta del hogar').selectOption(E2E_SEED.recipePages.conLeche);
  await editor.getByLabel('Lo sé y aun así quiero apuntarlo').check();
  await editor.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(comidaRow.getByRole('link', { name: 'Arroz con leche (E2E)' })).toBeVisible();

  await page.getByRole('button', { name: 'Lista de la compra' }).click();

  // Antes, lo derivado del menú NO tenía casilla: no se podía marcar.
  const arroz = page.locator('.ingredient-list li').filter({ hasText: 'Arroz redondo E2E' });
  await expect(arroz).toContainText('del menú');
  // 0,25 kg × 2 comensales / 4 raciones base = 0,125 kg → un paquete de 500 g.
  await expect(arroz).toContainText('1 paquete de 500 g');

  await arroz.getByRole('checkbox').check();
  await expect(arroz).toHaveClass(/checked/);

  // Y sigue marcado tras recargar: el hecho se persiste por semana + línea.
  await page.reload();
  await page.getByRole('button', { name: 'Lista de la compra' }).click();
  await expect(
    page.locator('.ingredient-list li').filter({ hasText: 'Arroz redondo E2E' }).getByRole('checkbox')
  ).toBeChecked();
});

test('un añadido a mano del mismo alimento se fusiona con lo del menú en una línea (P2-4)', async ({ page }) => {
  await gotoShopping(page, 'family');

  const addForm = page.locator('form.action-form').filter({ hasText: '¿Qué es? (elige o escríbelo)' });
  await addForm.getByLabel('¿Qué es? (elige o escríbelo)').selectOption({ label: 'Arroz redondo E2E' });
  await addForm.getByLabel('Cantidad').fill('1');
  await addForm.getByLabel('Unidad').fill('kg');
  await addForm.getByRole('button', { name: 'Añadir a la compra' }).click();

  const arroz = page.locator('.ingredient-list li').filter({ hasText: 'Arroz redondo E2E' });
  // UNA sola línea, no dos: la de antes «del menú» y la recién añadida.
  await expect(arroz).toHaveCount(1);
  // Con el origen a la vista y el total redondeado a paquetes de compra.
  await expect(arroz).toContainText('del menú +');
  await expect(arroz).toContainText('añadido');
  await expect(arroz).toContainText('3 paquetes de 500 g');
});

test('la sección «Personal» es de la interna: Ana la usa y para el apoyo no existe (Anexo H)', async ({ page }) => {
  await gotoShopping(page, 'employee');

  const personal = page.locator('section.card').filter({ hasText: 'Personal' }).first();
  await expect(personal).toBeVisible();

  const addForm = page.locator('form.action-form').filter({ hasText: '¿A qué lista?' });
  await addForm.getByRole('radio', { name: 'La lista personal' }).check();
  await addForm.getByLabel('Escríbelo aquí').fill('Champú de Ana E2E');
  await addForm.getByLabel('Cantidad').fill('1');
  await addForm.getByLabel('Unidad').fill('ud');
  await addForm.getByRole('button', { name: 'Añadir a la lista personal' }).click();

  const item = personal.locator('.ingredient-list li').filter({ hasText: 'Champú de Ana E2E' });
  await expect(item).toBeVisible();
  await item.getByRole('checkbox').check();
  await expect(item).toHaveClass(/checked/);
});

test('para el apoyo la lista «Personal» no existe, pero la de casa sí (Anexo H)', async ({ page }) => {
  // La RLS no le entrega ni una fila personal: no es que la interfaz la
  // esconda. Y la compra de la casa la sigue leyendo, como siempre.
  await gotoShopping(page, 'helper');
  await expect(page.getByRole('heading', { name: 'Personal' })).toHaveCount(0);
  await expect(page.getByText('Champú de Ana E2E')).toHaveCount(0);
  await expect(page.locator('.ingredient-list li').filter({ hasText: 'Arroz redondo E2E' })).toBeVisible();
});

test('apuntar un comensal pide solo el nombre; los alérgenos, si se abren (P1-7)', async ({ page }) => {
  await loginAs(page, 'family');
  await page.goto(`/h/${HOUSEHOLD}/recipes`);

  const dinersCard = page.locator('section.card').filter({ hasText: 'Comensales y restricciones' });
  const form = dinersCard.locator('form.action-form');

  // La matriz de 14 alérgenos está plegada: el alta normal es un solo campo.
  await expect(form.getByText('¿Tiene alergias o restricciones?')).toBeVisible();
  await expect(form.getByRole('group', { name: 'Qué evita y con cuánta gravedad' })).toBeHidden();

  await form.getByLabel('Nombre').fill(DINER_NAME);
  await form.getByRole('button', { name: 'Apuntar comensal' }).click();
  await expect(dinersCard.locator('li').filter({ hasText: DINER_NAME })).toContainText('Sin restricciones');

  // Al abrir el desplegable sí aparece la matriz, y cada restricción marcada
  // abre su propia nota (hueco de la Oleada 4).
  await form.getByText('¿Tiene alergias o restricciones?').click();
  await expect(form.getByRole('group', { name: 'Qué evita y con cuánta gravedad' })).toBeVisible();

  await dinersCard.locator('li').filter({ hasText: DINER_NAME }).getByRole('button', { name: 'Editar' }).click();
  await form.getByText('¿Tiene alergias o restricciones?').click();
  await form.getByLabel('Huevos').selectOption('medium');
  await form.getByLabel('Nota sobre huevos').fill('Solo el huevo crudo E2E');
  await form.getByRole('button', { name: 'Guardar comensal' }).click();

  await expect(dinersCard.locator('li').filter({ hasText: DINER_NAME })).toContainText(
    'Solo el huevo crudo E2E'
  );
});

test('archivar un alimento lo retira del catálogo y se recupera desde la lista plegada', async ({ page }) => {
  await loginAs(page, 'family');
  await page.goto(`/h/${HOUSEHOLD}/recipes`);

  const foodsCard = page.locator('section.card').filter({ hasText: 'Alimentos y alérgenos' });
  const row = foodsCard.locator('li').filter({ hasText: 'Pan de espelta E2E' });
  await row.getByRole('button', { name: 'Archivar' }).click();
  await row.getByRole('button', { name: 'Sí, archivar «Pan de espelta E2E»' }).click();

  await expect(foodsCard.locator('li').filter({ hasText: 'Pan de espelta E2E' })).toHaveCount(1);
  const archived = foodsCard.locator('details.archived-block');
  await expect(archived).toContainText('Alimentos archivados (1)');

  await archived.click();
  await archived.locator('li').filter({ hasText: 'Pan de espelta E2E' }).getByRole('button', { name: 'Recuperar' }).click();
  await expect(foodsCard.locator('details.archived-block')).toHaveCount(0);
});
