import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// Menú de la FAMILIA contra Postgres real, segunda tanda: crear una receta
// nueva desde el propio hueco (sin pasar por el recetario) y las semanas
// plantilla con nombre (guardar, aplicar sobre una semana vacía, rechazo si el
// destino tiene contenido y borrado con confirmación ligera).
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

// Semanas propias, lejos de las que usa family-menu.dbe2e (semana actual y la
// siguiente): +21, +35 y +49 días sobre el lunes de la semana en curso.
const MADRID_TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

function mondayPlus(weeks: number): string {
  const base = new Date(`${MADRID_TODAY}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - ((base.getUTCDay() + 6) % 7) + weeks * 7);
  return base.toISOString().slice(0, 10);
}

const RECIPE_WEEK = mondayPlus(3);
const APPLY_WEEK = mondayPlus(5);
const TEMPLATE_NAME = 'Semana plantilla E2E';
const RECIPE_NAME = 'Croquetas de la casa E2E';

async function gotoMenuWeek(page: Page, week: string): Promise<void> {
  await loginAs(page, 'family');
  await page.goto(`/h/${HOUSEHOLD}/menu?week=${week}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test('Marta crea una receta nueva desde el hueco: se asigna y aparece en el recetario', async ({ page }) => {
  await gotoMenuWeek(page, RECIPE_WEEK);

  const groupCard = page.locator('section.menu-group-card').filter({ hasText: 'Casa' });
  const comidaRow = groupCard.locator('.menu-slot-row').filter({ hasText: 'Comida' });
  await comidaRow.getByRole('button', { name: 'Asignar' }).click();

  const editor = groupCard.locator('form.menu-slot-editor');
  await editor.getByRole('button', { name: 'Nueva receta' }).click();
  await editor.getByLabel('Nombre de la receta nueva').fill(RECIPE_NAME);
  await editor.getByLabel('Ingredientes o nota inicial (opcional)').fill('Bechamel, jamón y pan rallado');
  await editor.getByRole('button', { name: 'Guardar', exact: true }).click();

  // El hueco queda asignado a la receta REAL (enlace al recetario) y la línea
  // de raciones solo existe en el render del servidor: el comando llegó.
  await expect(comidaRow.getByRole('link', { name: RECIPE_NAME })).toBeVisible();
  await expect(comidaRow).toContainText('raciones (la receta original es para');

  // La receta existe en el recetario del hogar como cualquier otra.
  await page.goto(`/h/${HOUSEHOLD}/recipes`);
  await expect(page.getByRole('link', { name: new RegExp(RECIPE_NAME) })).toBeVisible();
});

test('Marta guarda la semana como plantilla y la aplica sobre una semana vacía', async ({ page }) => {
  await gotoMenuWeek(page, RECIPE_WEEK);

  await page.getByLabel('Guardar esta semana como plantilla').fill(TEMPLATE_NAME);
  await page.getByRole('button', { name: 'Guardar semana como plantilla' }).click();

  // La plantilla aparece listada con su semana de origen.
  const templatesCard = page.locator('section.card').filter({ hasText: 'Semanas plantilla' });
  await expect(templatesCard.locator('li').filter({ hasText: TEMPLATE_NAME })).toBeVisible();

  // Usar la plantilla sobre el lunes elegido (semana vacía).
  await templatesCard.getByLabel('Usar una plantilla').selectOption({ label: TEMPLATE_NAME });
  await templatesCard.getByLabel('Sobre el lunes').fill(APPLY_WEEK);
  await expect(templatesCard).toContainText('Se copiará sobre la semana del');
  await templatesCard.getByRole('button', { name: 'Usar plantilla' }).click();

  await expect(page.locator('.success-message').filter({ hasText: 'aplicada sobre la semana del' })).toBeVisible();

  // La semana destino replica el hueco (receta creada en el test anterior).
  await page.goto(`/h/${HOUSEHOLD}/menu?week=${APPLY_WEEK}`);
  const groupCard = page.locator('section.menu-group-card').filter({ hasText: 'Casa' });
  await expect(groupCard.getByRole('link', { name: RECIPE_NAME })).toBeVisible();
});

test('usar la plantilla sobre una semana con contenido muestra el rechazo veraz', async ({ page }) => {
  await gotoMenuWeek(page, RECIPE_WEEK);

  const templatesCard = page.locator('section.card').filter({ hasText: 'Semanas plantilla' });
  await templatesCard.getByLabel('Usar una plantilla').selectOption({ label: TEMPLATE_NAME });
  // La semana recién aplicada ya tiene contenido: el servidor rechaza.
  await templatesCard.getByLabel('Sobre el lunes').fill(APPLY_WEEK);
  await templatesCard.getByRole('button', { name: 'Usar plantilla' }).click();

  // Mensaje propio de esta acción (Ola C): más concreto que el genérico
  // «No se pudo guardar: la semana se solapa…» del diccionario compartido.
  await expect(page.locator('.form-error')).toContainText(
    'Esa semana ya tiene comidas: elige una semana vacía o quítalas antes.'
  );
});

test('Marta borra la plantilla con confirmación ligera', async ({ page }) => {
  await gotoMenuWeek(page, RECIPE_WEEK);

  const templatesCard = page.locator('section.card').filter({ hasText: 'Semanas plantilla' });
  const row = templatesCard.locator('li').filter({ hasText: TEMPLATE_NAME });
  await row.getByRole('button', { name: 'Borrar', exact: true }).click();
  await row.getByRole('button', { name: `Sí, borrar «${TEMPLATE_NAME}»` }).click();

  await expect(templatesCard.locator('li').filter({ hasText: TEMPLATE_NAME })).toHaveCount(0);
});
