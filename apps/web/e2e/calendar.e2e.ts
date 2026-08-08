import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// Modo demo (sin base de datos): el calendario conserva su maqueta con banda
// honesta, pero SIN el tecnicismo «conexión ICS» (P2-12 / Ola E).
test('el calendario de demostración avisa con honestidad y sin tecnicismos', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/calendar`);
  const note = page.locator('.demo-note');
  await expect(note).toContainText('Contenido de demostración: estos eventos no son de tu hogar.');
  await expect(page.locator('body')).not.toContainText('ICS');
  await expect(page.locator('body')).not.toContainText('El calendario real llegará');
  await expect(page.getByRole('heading', { name: 'Agenda compartida' })).toBeVisible();
});
