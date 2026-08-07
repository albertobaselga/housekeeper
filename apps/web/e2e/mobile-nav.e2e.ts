import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// Navegación móvil completa (UX-P1-3 · H-02 · I-05): la bottom-nav lleva 4
// destinos por rol + «Más», la píldora de sync sobrevive al breakpoint y la
// búsqueda es un overlay global. Corre en modo fixture con viewport de móvil.
test.use({ viewport: { width: 390, height: 844 } });

test('la hoja «Más» expone para Marta el resto de módulos y Salir, sin Recetas', async ({ page }) => {
  await loginAs(page, 'family');

  const bottomNav = page.getByRole('navigation', { name: 'Navegación móvil' });
  await expect(bottomNav).toBeVisible();
  // Recetas deja de ser destino de primer nivel (sigue accesible por URL).
  await expect(bottomNav.getByRole('link', { name: 'Recetas' })).toHaveCount(0);

  await bottomNav.getByRole('button', { name: 'Más' }).click();
  const sheet = page.getByRole('dialog', { name: 'Más opciones' });
  await expect(sheet).toBeVisible();

  await expect(sheet.getByRole('link', { name: 'Wiki de la casa' })).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Rutinas' })).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Contactos' })).toBeVisible();
  await expect(sheet.getByRole('link', { name: /Emergencias/ })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Salir/ })).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Recetas' })).toHaveCount(0);
  // Marta (family_member) no gestiona accesos: Ajustes no debe ofrecerse.
  await expect(sheet.getByRole('link', { name: 'Ajustes del hogar' })).toHaveCount(0);

  // Escape cierra y devuelve el foco al disparador.
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(bottomNav.getByRole('button', { name: 'Más' })).toBeFocused();
});

test('Ajustes aparece en la hoja para quien gestiona accesos y navega', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.getByRole('button', { name: 'Más' }).click();
  const settings = page
    .getByRole('dialog', { name: 'Más opciones' })
    .getByRole('link', { name: 'Ajustes del hogar' });
  await expect(settings).toBeVisible();
  await settings.click();
  await expect(page).toHaveURL(`/h/${HOUSEHOLD}/settings`);
  // Al navegar la hoja se cierra sola.
  await expect(page.getByRole('dialog', { name: 'Más opciones' })).toHaveCount(0);
});

test('Rutinas queda a ≤2 taps desde Hoy para Marta', async ({ page }) => {
  await loginAs(page, 'family');
  await page.getByRole('button', { name: 'Más' }).click(); // tap 1
  await page.getByRole('dialog', { name: 'Más opciones' }).getByRole('link', { name: 'Rutinas' }).click(); // tap 2
  await expect(page).toHaveURL(`/h/${HOUSEHOLD}/routines`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Rutinas');
});

test('para la empleada interna Rutinas es un slot principal (1 tap)', async ({ page }) => {
  await loginAs(page, 'employee');
  const bottomNav = page.getByRole('navigation', { name: 'Navegación móvil' });
  await bottomNav.getByRole('link', { name: 'Rutinas' }).click(); // 1 tap
  await expect(page).toHaveURL(`/h/${HOUSEHOLD}/routines`);
});

test('la píldora de sync es visible en móvil y no tapa la navegación', async ({ page }) => {
  await loginAs(page, 'employee');
  const pill = page.locator('.sync-pill');
  await expect(pill).toBeVisible();
  const box = await pill.boundingBox();
  expect(box).not.toBeNull();
  // Vive en el topbar: no invade la bottom-nav ni el contenido inferior.
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThan(80);
});

test('la búsqueda abre como overlay desde el icono y navega con la consulta', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.getByRole('button', { name: 'Buscar en toda la casa' }).click();
  const overlay = page.getByRole('dialog', { name: 'Buscar en toda la casa' });
  await expect(overlay).toBeVisible();
  const input = overlay.getByRole('searchbox', { name: 'Texto a buscar' });
  await expect(input).toBeFocused();
  await input.fill('lavadora');
  await input.press('Enter');
  await expect(page).toHaveURL(`/h/${HOUSEHOLD}/search?q=lavadora`);
  await expect(page.getByRole('dialog', { name: 'Buscar en toda la casa' })).toHaveCount(0);
});

test('⌘K abre el overlay de búsqueda y Escape lo cierra', async ({ page }) => {
  await loginAs(page, 'family');
  await page.keyboard.press('ControlOrMeta+k');
  const overlay = page.getByRole('dialog', { name: 'Buscar en toda la casa' });
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole('searchbox', { name: 'Texto a buscar' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
});
