import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// Con Postgres detrás, el nombre que se lee sale de `app.households`, no de una
// constante del código: la fixture sintética llama «Casa Roble» a este mismo
// hogar y la base de datos «Fixture Casa Roble». Si la cabecera dijera «Casa
// Roble» aquí, el nombre no estaría viniendo del hogar.

test('la cabecera y la pestaña llevan el nombre que el hogar tiene en la base de datos', async ({ page }) => {
  await loginAs(page, 'admin');
  await expect(page).toHaveTitle('Hoy · Fixture Casa Roble');
  await expect(page.locator('.sidebar .brand')).toContainText('Fixture Casa Roble');

  await page.goto(`/h/${HOUSEHOLD}/routines`);
  await expect(page).toHaveTitle('Rutinas · Fixture Casa Roble');
  await expect(page.locator('body')).not.toContainText('Casa Clara');
});

test('una nota de la guía se titula con su propio nombre y el del hogar', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/wiki`);
  const primeraNota = page.locator('main a[href*="/wiki/"]').first();
  const nombre = (await primeraNota.innerText()).trim();
  await primeraNota.click();
  await page.waitForURL('**/wiki/**');
  await expect(page).toHaveTitle(`${nombre} · Fixture Casa Roble`);
});
