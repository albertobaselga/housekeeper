import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// P2-2: contactos REALES del hogar. Marta (family_member) añade un contacto
// destacado desde el directorio y este aparece en Emergencias (destacados de
// la DB, no la fixture) y en la búsqueda global accionable (tel:).
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

test('Marta añade un contacto y aparece en Emergencias y en la búsqueda', async ({ page }) => {
  await loginAs(page, 'family');

  await page.goto(`/h/${HOUSEHOLD}/contacts`);
  // El directorio real muestra los contactos sembrados agrupados por tipo.
  await expect(page.locator('body')).toContainText('Centro Pediátrico Olmo');

  await page.getByRole('button', { name: 'Añadir contacto' }).click();
  const form = page.locator('form.action-form');
  await form.getByLabel('Nombre').fill('Abuela Rosa E2E');
  await form.getByLabel('Rol o relación').fill('Familia cercana');
  await form.getByLabel('Teléfono').fill('600 123 123');
  await form.getByLabel('Tipo').selectOption('emergency');
  await form.getByRole('checkbox', { name: /Destacado/ }).check();
  await form.getByRole('button', { name: 'Crear contacto' }).click();

  // Ack real del servidor y recarga de datos: el contacto entra en su grupo.
  await expect(page.locator('.success-message')).toContainText('sincronizado');
  const card = page.locator('.contact-card').filter({ hasText: 'Abuela Rosa E2E' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('link', { name: 'Llamar a Abuela Rosa E2E' })).toHaveAttribute(
    'href',
    'tel:600123123'
  );

  // Emergencias: los destacados salen de app.contacts, con el 112 fijo.
  await page.goto(`/h/${HOUSEHOLD}/emergency`);
  await expect(page.getByRole('link', { name: 'Llamar al 112' })).toBeVisible();
  await expect(page.locator('.emergency-contacts')).toContainText('Abuela Rosa E2E');
  await expect(page.locator('.emergency-contacts')).toContainText('Centro Pediátrico Olmo');

  // Búsqueda global: resultado de contacto accionable con enlace tel:.
  await page.goto(`/h/${HOUSEHOLD}/search?q=Abuela`);
  const result = page.locator('.search-results a').filter({ hasText: 'Abuela Rosa E2E' });
  await expect(result).toBeVisible();
  await expect(result).toHaveAttribute('href', 'tel:600123123');
});

test('el acceso fijo desde Hoy lleva a Emergencias en un tap', async ({ page }) => {
  await loginAs(page, 'employee');
  await page.locator('a.today-emergency-link').click();
  await page.waitForURL(`**/h/${HOUSEHOLD}/emergency`);
  await expect(page.getByRole('link', { name: 'Llamar al 112' })).toBeVisible();
});
