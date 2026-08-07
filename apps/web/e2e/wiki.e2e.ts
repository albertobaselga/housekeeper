import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// El servidor de Playwright arranca SIN base de datos: la wiki queda en modo
// fixture (solo lectura) y ninguna acción de escritura debe aparecer, ni
// siquiera para el administrador.
const WRITE_ACTION_LABELS = [
  'Editar',
  'Crear página',
  'Crear espacio',
  'Publicar',
  'Fijar',
  'Desfijar',
  'Guardar cambios'
];

test('admin en modo fixture: la wiki renderiza pero sin acciones de escritura', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/wiki`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Wiki de la casa');
  // La lectura fixture sigue renderizando lista y artículo.
  await expect(page.locator('.wiki-list')).toBeVisible();
  await expect(page.locator('.wiki-article')).toContainText('programa Mixto 40°');
  for (const label of WRITE_ACTION_LABELS) {
    await expect(page.getByRole('button', { name: label })).toHaveCount(0);
  }
  await expect(page.locator('.editor-panel')).toHaveCount(0);
});
