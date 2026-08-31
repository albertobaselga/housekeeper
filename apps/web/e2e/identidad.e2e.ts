import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// Qué nombre anuncia la aplicación, y cuándo. Ni «Casa Clara» (el nombre
// anterior del proyecto) ni «Housekeeper» (el actual) deben aparecer en
// ninguna de las dos situaciones: el nombre del proyecto nunca se muestra.
// Sin sesión manda el producto genérico; con sesión, el hogar al que se ha
// entrado.
//
// La batería fixture corre sin base de datos, así que el hogar es el sintético
// («Casa Roble»). La misma comprobación contra Postgres vive en
// identidad.dbe2e.ts, donde el nombre sale de app.households.

const GENERICO = 'Aplicación para la gestión del personal doméstico';

test('sin sesión, la pestaña y la cabecera dicen el producto, no una casa', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveTitle(GENERICO);
  await expect(page.locator('.login-brand')).toContainText(GENERICO);
  await expect(page.locator('body')).not.toContainText('Casa Clara');
  await expect(page.locator('body')).not.toContainText(/Housekeeper/i);
});

test('sin conexión también se anuncia en genérico', async ({ page }) => {
  await page.goto('/offline');
  await expect(page).toHaveTitle(`Sin conexión · ${GENERICO}`);
  await expect(page.locator('body')).not.toContainText('Casa Clara');
  await expect(page.locator('body')).not.toContainText(/Housekeeper/i);
});

test('con sesión, la pestaña y la cabecera dicen el hogar en cada sección', async ({ page }) => {
  await loginAs(page, 'admin');
  await expect(page).toHaveTitle('Hoy · Casa Roble');
  // Barra lateral (escritorio) y cabecera móvil llevan el mismo nombre.
  await expect(page.locator('.sidebar .brand')).toContainText('Casa Roble');
  await expect(page.locator('.mobile-brand')).toContainText('Casa Roble');

  // El título lo pone una sola fuente: cambiar de sección lo cambia sin que la
  // página nueva tenga que declararlo.
  await page.goto(`/h/${HOUSEHOLD}/menu`);
  await expect(page).toHaveTitle('Menú · Casa Roble');
  await page.goto(`/h/${HOUSEHOLD}/wiki`);
  await expect(page).toHaveTitle('Guía de la casa · Casa Roble');
  await page.goto(`/h/${HOUSEHOLD}/emergency`);
  await expect(page).toHaveTitle('Emergencias · Casa Roble');

  // Y hay exactamente un <title> en el documento: layout y página no compiten.
  expect(await page.locator('head > title').count()).toBe(1);
});

test('una sección fuera del acceso se titula por el error, no por la sección', async ({ page }) => {
  await loginAs(page, 'viewer');
  await page.goto(`/h/${HOUSEHOLD}/employment`);
  // El 403 lo lanza el layout del hogar, así que la página de error se dibuja
  // sin su armazón: no hay cabecera de casa, y la pestaña tampoco la nombra.
  // Lo que no puede pasar es que se titule «Contrato», como si hubiera entrado.
  await expect(page).toHaveTitle(`Sección no incluida en tu acceso · ${GENERICO}`);
});
