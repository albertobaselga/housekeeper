import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

/*
 * La cartera de cupones en la maqueta (sin base de datos), en el móvil
 * estrecho. La maqueta es de solo lectura —no pinta «Usar» ni «Añadir
 * cupón»—: lo que solo existe con datos de verdad lo mide
 * `cupones.dbe2e.ts`. Aquí, lo que se ve igual en los dos modos: la ficha, la
 * fila y el foco.
 *
 * Los identificadores son los de `getCouponsFixture()`.
 */
const FRUTERIA = 'f3000000-0000-4000-8000-000000000001'; // caduca pronto, un solo uso
const PANADERIA = 'f3000000-0000-4000-8000-000000000003'; // SIN código: se enseña la foto
const HELADERIA = 'f3000000-0000-4000-8000-000000000007'; // descartado

const CUPONES = `/h/${HOUSEHOLD}/cupones`;

test.use({ viewport: { width: 320, height: 568 } });

async function openPage(page: Page, search = ''): Promise<void> {
  await loginAs(page, 'family');
  await page.goto(`${CUPONES}${search}`);
  await page.waitForLoadState('networkidle');
}

test('la foto de la ficha se ve entera y la hoja se desplaza (320×568)', async ({ page }) => {
  // El cupón SIN código: la ficha dice «enseña la foto en caja», así que la
  // foto no puede quedarse en una tira de 8 px por no caber (revisión UX de la
  // fase 2, I1). Lo que no cabe, se desplaza.
  await openPage(page, `?cupon=${PANADERIA}`);
  const sheet = page.getByRole('dialog', { name: 'Panadería La Espiga' });
  await expect(sheet).toBeVisible();
  const photo = sheet.getByRole('button', { name: /Ver la foto del cupón/ });
  await expect(photo).toBeVisible();
  await expect
    .poll(() => photo.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);

  const sizes = await sheet.evaluate((node) => {
    const button = node.querySelector<HTMLElement>('.coupon-photo')!;
    const image = button.querySelector('img')!;
    return {
      button: button.getBoundingClientRect().height,
      image: image.getBoundingClientRect().height,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight
    };
  });
  // El botón mide lo que mide su foto (más el borde): nada la recorta.
  expect(sizes.image).toBeGreaterThan(150);
  expect(sizes.button).toBeGreaterThanOrEqual(sizes.image);
  // Y la hoja, más alta que la pantalla, se desplaza en vez de encoger.
  expect(sizes.scrollHeight).toBeGreaterThan(sizes.clientHeight);
});

test('en la lista se ven al menos tres cupones a 320×568 (A6)', async ({ page }) => {
  // «Caduca pronto» compartía el final de la fila con «Usar» y el nombre se
  // partía en cuatro o cinco líneas: solo cabían dos (revisión UX, I2).
  await openPage(page);
  const visible = await page.evaluate(() => {
    const nav = document.querySelector('nav.bottom-nav');
    const navHeight = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect().height : 0;
    const useful = window.innerHeight - navHeight;
    const list = document.querySelector('[data-lista="principal"]');
    let count = 0;
    let total = 0;
    for (const item of Array.from(list?.children ?? [])) {
      const box = item.getBoundingClientRect();
      if (box.height === 0) continue;
      total += 1;
      if (box.top >= -1 && box.bottom <= useful + 1) count += 1;
    }
    return { count, total };
  });
  expect(visible.total).toBeGreaterThanOrEqual(3);
  expect(visible.count, `solo ${visible.count} de ${visible.total} cupones caben en la primera pantalla`).toBeGreaterThanOrEqual(3);
});

test('tocar «Caduca pronto» abre la ficha, como el resto de la fila', async ({ page }) => {
  await openPage(page);
  const row = page.locator('.coupon-row', { has: page.locator(`a[href*="cupon=${FRUTERIA}"]`) });
  // Detrás del chip, la línea sigue la frase y no repite «Caduca» (revisión UX, ronda 2, m6).
  await expect(row.locator('a.coupon-open small')).toHaveText(/^Caduca pronto el \S+ \d+ \S+ · Un solo uso$/);
  await row.locator('.status-chip', { hasText: 'Caduca pronto' }).click();
  await expect(page.getByRole('dialog', { name: 'Frutería del Mercado' })).toBeVisible();
});

test('al cerrar una ficha abierta por enlace, el foco vuelve a su fila', async ({ page }) => {
  // El «Verlo» del aviso de Hoy llega con `?cupon=` ya puesto: no hay botón
  // que lo abriera, y el foco caía a `<body>` (revisión UX, m1).
  await openPage(page, `?cupon=${FRUTERIA}`);
  const sheet = page.getByRole('dialog', { name: 'Frutería del Mercado' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Cerrar el cupón' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator(`a.coupon-open[href*="cupon=${FRUTERIA}"]`)).toBeFocused();
});

test('si su fila no está en el filtro, el foco va al título de la página', async ({ page }) => {
  // Un cupón descartado abierto por enlace no tiene fila en «Disponibles».
  await openPage(page, `?cupon=${HELADERIA}`);
  const sheet = page.getByRole('dialog', { name: 'Heladería Polo' });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('#main-content h1')).toBeFocused();
});
