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

  await expect(sheet.getByRole('link', { name: 'Guía de la casa' })).toBeVisible();
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

test('en móvil no se pinta cabecera ni píldora cuando todo está guardado', async ({ page }) => {
  await loginAs(page, 'employee');
  // El topbar se va entero por debajo de 52rem: sus 64 px eran el nombre del
  // hogar en el que ya se sabe que se está, un icono de búsqueda que ahora vive
  // en «Más» y un punto verde que decía «todo bien».
  await expect(page.locator('header.topbar')).toBeHidden();
  await expect(page.locator('.sync-pill')).toBeHidden();
  // Y con ello el primer píxel del documento es ya contenido: el h1.
  const heading = page.getByRole('heading', { level: 1 });
  const box = await heading.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.y ?? 999).toBeLessThan(40);
});

test('la búsqueda vive en la hoja «Más» y lleva a su propia ruta', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.getByRole('button', { name: 'Más' }).click();
  const sheet = page.getByRole('dialog', { name: 'Más opciones' });
  await sheet.getByRole('link', { name: 'Buscar en toda la casa' }).click();
  await expect(page).toHaveURL(`/h/${HOUSEHOLD}/search`);
  await expect(page.getByRole('searchbox')).toBeVisible();
});

test('la hoja «Más» no tapa la barra: la pestaña activa sigue viéndose', async ({ page }) => {
  await loginAs(page, 'employee');
  await page.getByRole('button', { name: 'Más' }).click();
  const sheet = page.getByRole('dialog', { name: 'Más opciones' });
  await expect(sheet).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Navegación móvil' });
  const navBox = await nav.boundingBox();
  const sheetBox = await sheet.boundingBox();
  expect(navBox).not.toBeNull();
  expect(sheetBox).not.toBeNull();
  // La hoja se posa POR ENCIMA de la barra, no sobre ella.
  expect((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0)).toBeLessThanOrEqual((navBox?.y ?? 0) + 1);
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
