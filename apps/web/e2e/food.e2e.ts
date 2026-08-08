import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// El servidor de Playwright arranca SIN base de datos: menú, recetas y rutinas
// quedan en modo fixture (solo lectura) y ninguna de las acciones de escritura
// nuevas debe aparecer, ni siquiera para el administrador.
const FOOD_WRITE_ACTION_LABELS = [
  'Duplicar en la semana siguiente',
  'Asignar',
  'Cambiar',
  'Vaciar',
  'Confirmar',
  'Guardar',
  'Crear grupo',
  'Añadir a la compra',
  'Editar ingredientes',
  'Guardar receta',
  'Crear alimento',
  'Crear comensal',
  'Marcar hecha',
  'Crear rutina',
  'Guardar rutina'
];

test('admin en modo fixture: el menú renderiza sin acciones de escritura nuevas', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/menu`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Menú de la casa');
  // La lectura fixture sigue renderizando las pestañas de días y el plan.
  await expect(page.locator('.day-tabs')).toBeVisible();
  await expect(page.locator('.featured-day')).toContainText('Comidas previstas');
  for (const label of FOOD_WRITE_ACTION_LABELS) {
    await expect(page.getByRole('button', { name: label })).toHaveCount(0);
  }
  await expect(page.locator('.menu-slot-editor')).toHaveCount(0);
});

test('admin en modo fixture: las rutinas conservan el toggle demo y nada más', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/routines`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Rutinas');
  // El modo fixture mantiene su barra de progreso local de demostración.
  await expect(page.locator('.routine-progress')).toBeVisible();
  await expect(page.locator('.routine-columns')).toBeVisible();
  for (const label of ['Marcar hecha', 'Crear rutina', 'Guardar rutina', 'Editar']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }
});

test('admin en modo fixture: el recetario renderiza y escala en cliente sin escritura', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/recipes`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Recetario');
  await expect(page.locator('.recipe-gallery')).toBeVisible();
  await expect(page.locator('.recipe-detail')).toBeVisible();
  for (const label of ['Editar ingredientes', 'Guardar receta', 'Crear alimento', 'Crear comensal']) {
    await expect(page.getByRole('button', { name: label })).toHaveCount(0);
  }
});
