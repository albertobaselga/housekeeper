import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { E2E_SEED, HOUSEHOLD, loginAs } from './helpers';

/*
 * La cartera de cupones CON datos de verdad, en el móvil estrecho: lo que la
 * maqueta (`cupones.e2e.ts`) no puede enseñar porque es de solo lectura
 * —«Usar» en cada fila, «Añadir», «Deshacer» y «Anular este uso»—.
 *
 * Siembra: `E2E_SEED.coupons` (db-global-setup.ts), diez cupones disponibles
 * del roble ordenados por caducidad; `varios` el primero, `ultimo` el último.
 *
 * Esta batería no tiene almacén de ficheros: la subida de la foto se sustituye
 * en el navegador (`fakeUpload`) y devuelve un objeto que existe
 * (`fotoLibre`) o uno inventado, que el servidor rechaza como
 * `coupon_photo_invalid`. Todo lo demás —comandos, RLS, recarga— es de verdad.
 */
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.use({ viewport: { width: 320, height: 568 } });
test.describe.configure({ mode: 'serial' });

const CUPONES = `/h/${HOUSEHOLD}/cupones`;
const ULTIMO = { name: 'Usar el cupón de Comercio E2E 10: Oferta de prueba número 10' };
const VARIOS = { name: 'Usar el cupón de Comercio E2E 1: Varios usos de prueba' };

async function openWallet(page: Page, search = ''): Promise<void> {
  await loginAs(page, 'admin');
  await page.goto(`${CUPONES}${search}`);
  // Un toque antes de hidratar se pierde: con SSR, se espera a la red.
  await page.waitForLoadState('networkidle');
}

/** Alto útil de la ventana: lo que no tapa la barra inferior. */
async function usefulHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const nav = document.querySelector('nav.bottom-nav');
    const navHeight = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect().height : 0;
    return window.innerHeight - navHeight;
  });
}

/** Lo que de verdad recibe un toque en el centro del botón: él, y no un aviso encima. */
async function expectReachable(target: Locator, what: string): Promise<void> {
  await expect(target).toBeVisible();
  const hit = await target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const found = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    if (found === node || (found && node.contains(found))) return 'el propio botón';
    return found ? `${found.tagName.toLowerCase()}.${String(found.className).split(' ').join('.')}` : 'nada (fuera de la pantalla)';
  });
  expect(hit, `${what}: el toque cae en ${hit}`).toBe('el propio botón');
}

/** Todo el elemento dentro de la ventana útil (ni arriba ni bajo la barra). */
async function expectInUsefulWindow(page: Page, target: Locator, what: string): Promise<void> {
  const useful = await usefulHeight(page);
  const box = await target.boundingBox();
  expect(box, `${what} no está en la página`).not.toBeNull();
  expect(box!.y, `${what} queda por encima de la pantalla`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${what} queda fuera de la pantalla o bajo la barra`).toBeLessThanOrEqual(useful + 1);
}

/** La subida de la foto, sustituida: devuelve el objeto que diga `nextId`, tras un rato. */
async function fakeUpload(page: Page, nextId: () => string, delayMs = 700): Promise<void> {
  await page.route('**/api/v1/households/*/attachments', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ storageObjectId: nextId() })
    });
  });
}

/** Un vale de mentira dibujado en un lienzo: nunca una foto real. */
async function syntheticPhoto(page: Page, label: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const base64 = await page.evaluate((text) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fafafa';
    context.fillRect(0, 0, 1200, 800);
    context.fillStyle = '#222222';
    context.font = 'bold 80px sans-serif';
    context.fillText(text, 80, 200);
    context.font = '48px monospace';
    context.fillText('CODIGO: PRUEBA-0000', 80, 340);
    for (let bar = 0; bar < 60; bar += 1) context.fillRect(100 + bar * 16, 480, (bar % 3) + 2, 240);
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, label);
  return { name: 'vale.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

async function withAdmin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await admin.connect();
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

test('con «Usar» en cada fila, el título cabe en una línea y se ven tres cupones (A6)', async ({ page }) => {
  await openWallet(page);
  await expect(page.getByRole('button', { name: 'Añadir un cupón' })).toBeVisible();
  await expect(page.getByRole('button', VARIOS)).toBeVisible();
  const m = await page.evaluate(() => {
    const h1 = document.querySelector('#main-content h1')!;
    const style = getComputedStyle(h1);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    const nav = document.querySelector('nav.bottom-nav');
    const useful = window.innerHeight - (nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect().height : 0);
    const rows = Array.from(document.querySelectorAll('[data-lista="principal"] > li')).map((row) => row.getBoundingClientRect());
    return {
      h1Lines: Math.round(h1.getBoundingClientRect().height / line),
      visible: rows.filter((box) => box.top >= -1 && box.bottom <= useful + 1).length
    };
  });
  expect(m.h1Lines, 'el título «Cupones · N disponibles» se parte en dos líneas').toBe(1);
  expect(m.visible, `solo ${m.visible} cupones caben en la primera pantalla`).toBeGreaterThanOrEqual(3);
  // Control de la prueba de la empleada (más abajo): la familia SÍ tiene la entrada.
  await expect(page.locator(`a[href$="/h/${HOUSEHOLD}/cupones"]`).first()).toBeAttached();
});

test('usar un cupón que está abajo: el aviso se ve, «Deshacer» lo devuelve y el aviso se va solo', async ({ page }) => {
  // Con la lista desplazada, el acuse insertado arriba no se veía: la fila
  // desaparecía (pasa a «Usados») sin aviso y el foco caía a `<body>`
  // (revisión UX de la fase 2, I3).
  await openWallet(page);
  // La región que anuncia los avisos está SIEMPRE: una que nace ya con su
  // texto no siempre se anuncia (revisión UX, ronda 2, m2).
  const notes = page.locator('.coupon-notes');
  await expect(notes).toHaveAttribute('role', 'status');

  const use = page.getByRole('button', ULTIMO);
  await use.scrollIntoViewIfNeeded();
  await use.focus();
  await page.keyboard.press('Enter');

  const note = page.locator('.use-note');
  await expect(note).toContainText('Uso apuntado ✓ · Comercio E2E 10');
  await expectInUsefulWindow(page, note, 'el aviso');
  // El texto, del tono del aviso, no el gris de cualquier `p` (revisión UX, ronda 2, m3).
  const [noteColor, textColor] = await note.evaluate((box) => [
    getComputedStyle(box).color,
    getComputedStyle(box.querySelector('p')!).color
  ]);
  expect(textColor).toBe(noteColor);

  // La fila se ha ido con el foco dentro: el foco va a «Deshacer», que dice
  // de qué cupón es.
  const undo = note.getByRole('button', { name: 'Deshacer el uso de Comercio E2E 10' });
  await expect(undo).toBeFocused();
  await expect(page.getByRole('button', ULTIMO)).toHaveCount(0);

  // Deshecho, el cupón vuelve y el foco vuelve a SU «Usar»: no se queda en
  // un aviso que entonces ya no se cerraba nunca (revisión UX, ronda 2, I1).
  await page.keyboard.press('Enter');
  await expect(note).toContainText('Uso anulado ✓ · Comercio E2E 10');
  await expect(page.getByRole('button', ULTIMO)).toBeFocused();
  await expect(note).toHaveCount(0, { timeout: 12_000 });
});

test('el aviso de «Usar» no empuja la lista', async ({ page }) => {
  await openWallet(page);
  const list = page.locator('ul.coupon-list');
  const before = await list.boundingBox();
  await page.getByRole('button', VARIOS).click();
  await expect(page.locator('.use-note')).toContainText('Uso apuntado ✓ · Comercio E2E 1');
  const after = await list.boundingBox();
  expect(after?.y).toBe(before?.y);
  // Se deja como estaba para las pruebas siguientes.
  await page.locator('.use-note').getByRole('button', { name: /^Deshacer/ }).click();
  await expect(page.locator('.use-note')).toContainText('Uso anulado ✓');
});

test('con un aviso a la vista, la última fila de la lista se puede tocar', async ({ page }) => {
  // El aviso flotaba fijo sobre la barra y el final de la lista no le dejaba
  // hueco: el «Usar» de la última fila quedaba debajo 10 s, o sin fin con un
  // error (revisión UX, ronda 2, I1; integración, m-2).
  await openWallet(page);
  await page.getByRole('button', VARIOS).click();
  const note = page.locator('.use-note');
  await expect(note).toContainText('Uso apuntado ✓ · Comercio E2E 1');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expectReachable(page.getByRole('button', ULTIMO), 'el «Usar» de la última fila');
  await note.getByRole('button', { name: /^Deshacer/ }).click();
  await expect(note).toContainText('Uso anulado ✓');
});

test('en escritorio, el aviso se centra en la columna del contenido, no en la ventana', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWallet(page);
  await page.getByRole('button', VARIOS).click();
  const note = page.locator('.use-note');
  await expect(note).toContainText('Uso apuntado ✓ · Comercio E2E 1');
  const noteBox = (await note.boundingBox())!;
  const column = (await page.locator('.page-wrap').boundingBox())!;
  const off = noteBox.x + noteBox.width / 2 - (column.x + column.width / 2);
  expect(Math.abs(off), `el aviso está ${Math.round(off)} px fuera del centro de la columna`).toBeLessThan(2);
  await note.getByRole('button', { name: /^Deshacer/ }).click();
  await expect(note).toContainText('Uso anulado ✓');
});

test('en la ficha, «Usar» va justo debajo del código y cabe en la primera pantalla', async ({ page }) => {
  await openWallet(page, `?cupon=${E2E_SEED.coupons.varios}`);
  const sheet = page.getByRole('dialog', { name: 'Comercio E2E 1' });
  await expect(sheet).toBeVisible();
  const order = await sheet.evaluate((node) =>
    Array.from(node.children)
      .map((child) => child.className)
      .filter((name) => /coupon-code|coupon-sheet-actions|coupon-photo|coupon-facts/.test(name))
      .map((name) => name.split(' ').find((part) => part.startsWith('coupon-')))
  );
  expect(order.slice(0, 2)).toEqual(['coupon-code', 'coupon-sheet-actions']);
  const useButton = sheet.getByRole('button', { name: 'Usar', exact: true });
  const box = await useButton.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(568);
});

test('en la ficha, usar un cupón de un solo uso no mueve «Usar», que pasa a secundario', async ({ page }) => {
  // Aparecía el chip «Usado» en la cabecera y empujaba el código y el propio
  // botón 32 px; y «Usar» seguía primario en un cupón ya usado, invitando a
  // un segundo toque (revisión UX, ronda 2, m5).
  await openWallet(page, `?cupon=${E2E_SEED.coupons.ultimo}`);
  const sheet = page.getByRole('dialog', { name: 'Comercio E2E 10' });
  const useButton = sheet.getByRole('button', { name: 'Usar', exact: true });
  await expect(useButton).toHaveClass(/\bprimary\b/);
  const before = (await useButton.boundingBox())!;
  await useButton.click();
  await expect(sheet.locator('.use-note')).toContainText('Uso apuntado ✓ · Comercio E2E 10');
  await expect(sheet.locator('.status-chip', { hasText: 'Usado' })).toBeVisible();
  const after = (await useButton.boundingBox())!;
  expect(after.y, 'el chip «Usado» ha empujado el botón').toBe(before.y);
  await expect(useButton).toHaveClass(/\bsecondary\b/);
  await sheet.locator('.use-note').getByRole('button', { name: /^Deshacer/ }).click();
  await expect(sheet.locator('.use-note')).toContainText('Uso anulado ✓');
  await expect(useButton).toHaveClass(/\bprimary\b/);
});

test('en la ficha, con el aviso de «Usar» a la vista, «Descartar» se puede tocar', async ({ page }) => {
  await openWallet(page, `?cupon=${E2E_SEED.coupons.varios}`);
  const sheet = page.getByRole('dialog', { name: 'Comercio E2E 1' });
  await sheet.getByRole('button', { name: 'Usar', exact: true }).click();
  const note = sheet.locator('.use-note');
  await expect(note).toContainText('Uso apuntado ✓ · Comercio E2E 1');
  await sheet.evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await expectReachable(sheet.getByRole('button', { name: 'Descartar el cupón de Comercio E2E 1' }), '«Descartar…»');
  await note.getByRole('button', { name: /^Deshacer/ }).click();
  await expect(note).toContainText('Uso anulado ✓');
});

test('el aviso de un cupón no aparece en la ficha de otro', async ({ page }) => {
  // La ficha de la panadería pintaba «Uso anulado ✓ · Droguería Sol»
  // (revisión UX, ronda 2, m8).
  await openWallet(page);
  await page.getByRole('button', VARIOS).click();
  const pageNote = page.locator('.use-note');
  await pageNote.getByRole('button', { name: /^Deshacer/ }).click();
  await expect(pageNote).toContainText('Uso anulado ✓ · Comercio E2E 1');
  await page.locator(`a.coupon-open[href*="cupon=${E2E_SEED.coupons.ultimo}"]`).click();
  const sheet = page.getByRole('dialog', { name: 'Comercio E2E 10' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.use-note')).toHaveCount(0);
});

test('anular un uso pide un segundo toque: no tiene vuelta atrás', async ({ page }) => {
  await openWallet(page, `?cupon=${E2E_SEED.coupons.varios}`);
  const sheet = page.getByRole('dialog', { name: 'Comercio E2E 1' });
  await expect(sheet.getByRole('heading', { name: 'Usos apuntados (1)' })).toBeVisible();

  const arm = sheet.getByRole('button', { name: /^Anular este uso: Usado el/ });
  await arm.click();
  const confirm = sheet.getByRole('button', { name: /^Sí, anular este uso: Usado el .*No se puede deshacer\.$/ });
  await expect(confirm).toBeFocused();

  // «Cancelar» lo deja como estaba y devuelve el foco a su botón.
  await sheet.getByRole('button', { name: 'Cancelar' }).click();
  await expect(arm).toBeFocused();
  await expect(sheet.getByRole('heading', { name: 'Usos apuntados (1)' })).toBeVisible();

  await arm.click();
  await confirm.click();
  await expect(sheet.getByRole('heading', { name: 'Todavía no se ha usado' })).toBeVisible();
  // El foco no se ha caído de la hoja.
  await expect(sheet.getByRole('heading', { name: 'Todavía no se ha usado' })).toBeFocused();
  // Y el acuse dice lo que pasó, con el verbo del botón (revisión UX, ronda 2, m4).
  await expect(sheet.locator('.coupon-notes')).toContainText('Uso anulado ✓ · Comercio E2E 1');
});

test('en la edición, un rechazo no deja «Guardar» ni «Cancelar» bajo el aviso, y el aviso se cierra', async ({ page }) => {
  // Un objeto que no existe en la casa: el servidor rechaza la foto
  // (`coupon_photo_invalid`) y el formulario se queda abierto. El aviso rojo
  // no se cierra solo y tapaba sin fin los dos botones (revisión UX, ronda 2, I1).
  await fakeUpload(page, () => randomUUID());
  await openWallet(page, `?cupon=${E2E_SEED.coupons.ultimo}`);
  const sheet = page.getByRole('dialog', { name: 'Comercio E2E 10' });
  await sheet.getByRole('button', { name: 'Editar' }).click();
  await sheet.getByRole('button', { name: 'Cambiar la foto' }).click();
  await sheet.getByLabel('Elegir una foto guardada').setInputFiles(await syntheticPhoto(page, 'VALE NUEVO'));
  const save = sheet.getByRole('button', { name: 'Guardar los cambios' });
  await expect(save).toBeEnabled();
  await save.click();
  const rejection = sheet.locator('.coupon-notes').getByText('La foto no se ha podido unir al cupón');
  await expect(rejection).toBeVisible();

  await sheet.evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await expectReachable(save, '«Guardar los cambios»');
  await expectReachable(sheet.getByRole('button', { name: 'Cancelar', exact: true }), '«Cancelar»');

  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  expect(axe.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`)).toEqual([]);

  // El error se puede cerrar, y el foco no se cae de la hoja.
  await sheet.getByRole('button', { name: 'Cerrar el aviso' }).click();
  await expect(rejection).toHaveCount(0);
  await expect.poll(() => sheet.evaluate((node) => node.contains(document.activeElement))).toBe(true);
});

test('alta: tras elegir la foto se ve el paso siguiente, y plegar no tira lo escrito', async ({ page }) => {
  // A 320 la pantalla se quedaba igual que antes de elegir; a 390, con «Foto
  // guardada ✓» en verde y los campos fuera de la pantalla, parecía que ya
  // estaba (revisión UX, ronda 2, I2).
  await fakeUpload(page, () => E2E_SEED.coupons.fotoLibre, 1_200);
  await openWallet(page);
  // Un aviso de éxito de antes no se queda flotando encima de los campos.
  await page.getByRole('button', VARIOS).click();
  await page.locator('.use-note').getByRole('button', { name: /^Deshacer/ }).click();
  await expect(page.locator('.use-note')).toContainText('Uso anulado ✓');
  await page.getByRole('button', { name: 'Añadir un cupón' }).click();
  await expect(page.locator('.use-note')).toHaveCount(0);
  const form = page.locator('#coupon-create');
  // Los dos campos de la foto son botones en castellano de 44 px, sin el
  // «Choose File · No file chosen» nativo (sistema móvil §2.9; revisión UX, ronda 2, m7).
  const pickers = form.locator('label.photo-pick');
  await expect(pickers).toHaveText(['Elegir una foto guardada', 'Hacer la foto ahora']);
  for (const height of await pickers.evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().height))) {
    expect(height).toBeGreaterThanOrEqual(44);
  }
  await form.getByLabel('Elegir una foto guardada').setInputFiles(await syntheticPhoto(page, 'VALE DE PRUEBA'));

  const step2 = form.getByRole('heading', { name: 'Después, lo que pone el cupón' });
  const uploading = form.getByText('Guardando la foto…');
  await expect(uploading).toBeVisible();
  await expectInUsefulWindow(page, uploading, 'la fase de la foto');
  await expectInUsefulWindow(page, step2, 'el título del paso 2');

  const ready = form.getByText('Foto lista ✓ · Ahora, escribe dónde sirve y qué ofrece.');
  await expect(ready).toBeVisible();
  await expectInUsefulWindow(page, ready, 'la foto lista');
  await expectInUsefulWindow(page, step2, 'el título del paso 2');

  // Plegar con «Cerrar» no tira lo escrito (revisión UX, ronda 2, m9).
  await form.getByLabel('Comercio').fill('Ferretería Clavo');
  await page.getByRole('button', { name: 'Cerrar el formulario del cupón' }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: 'Añadir un cupón' }).click();
  await expect(form.getByLabel('Comercio')).toHaveValue('Ferretería Clavo');
  await expect(ready).toBeVisible();
  // «Cancelar», en cambio, sí lo tira.
  await form.getByRole('button', { name: 'Cancelar' }).click();
  await page.getByRole('button', { name: 'Añadir un cupón' }).click();
  await expect(form.getByLabel('Comercio')).toHaveCount(0);
});

test('los estados vivos nuevos no tienen incidencias de accesibilidad (axe)', async ({ page }) => {
  // Lo que la maqueta no pinta y la revisión de la fase 2 cambió: la barra con
  // «Añadir», el aviso flotante, la confirmación de anular y el error ligado
  // a su campo al editar.
  const violations = async (label: string) => {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
      .analyze();
    return results.violations.map((violation) => `${label} · ${violation.id}: ${violation.nodes.length}`);
  };
  const found: string[] = [];

  await openWallet(page);
  found.push(...(await violations('lista')));
  await page.getByRole('button', VARIOS).click();
  await expect(page.locator('.use-note')).toContainText('Uso apuntado ✓');
  found.push(...(await violations('aviso de «Usar»')));
  await page.locator('.use-note').getByRole('button', { name: /^Deshacer/ }).click();
  await expect(page.locator('.use-note')).toContainText('Uso anulado ✓');

  await page.getByRole('button', { name: 'Añadir un cupón' }).click();
  await expect(page.getByRole('heading', { name: 'Añadir un cupón' })).toBeVisible();
  found.push(...(await violations('alta abierta')));
  await page.getByRole('button', { name: 'Cerrar el formulario del cupón' }).click();

  await page.goto(`${CUPONES}?cupon=${E2E_SEED.coupons.ultimo}`);
  await page.waitForLoadState('networkidle');
  const sheet = page.getByRole('dialog', { name: 'Comercio E2E 10' });
  await sheet.getByRole('button', { name: 'Usar', exact: true }).click();
  await expect(sheet.locator('.use-note')).toContainText('Uso apuntado ✓');
  await sheet.getByRole('button', { name: /^Anular este uso: Usado el/ }).click();
  found.push(...(await violations('ficha, confirmar anulación')));
  await sheet.getByRole('button', { name: /^Sí, anular este uso/ }).click();

  await sheet.getByRole('button', { name: 'Editar' }).click();
  await sheet.getByLabel('Comercio').fill('');
  await sheet.getByRole('button', { name: 'Guardar los cambios' }).click();
  await expect(sheet.getByLabel('Comercio')).toHaveAttribute('aria-invalid', 'true');
  await expect(sheet.getByLabel('Comercio')).toHaveAttribute('aria-describedby', /cupon-editar-error/);
  found.push(...(await violations('edición con error')));

  expect(found).toEqual([]);
});

test('la empleada no tiene cartera: ni entrada en el menú, ni página (403), ni foto (404)', async ({ page }) => {
  // Con sesión de verdad y por HTTP (spec §9 y §10; revisión de seguridad,
  // ronda 2, m4). La RLS ya le da cero filas: esto es la otra reja.
  await loginAs(page, 'employee');
  await expect(page.locator(`a[href$="/h/${HOUSEHOLD}/cupones"]`)).toHaveCount(0);
  const response = await page.goto(CUPONES);
  expect(response?.status()).toBe(403);
  await expect(page.getByText('Esta parte la lleva la familia.')).toBeVisible();
  const photo = await page.request.get(`/api/v1/households/${HOUSEHOLD}/coupons/${E2E_SEED.coupons.varios}/photo`);
  expect(photo.status()).toBe(404);
});

test('cartera vacía: el alta abre con el foco dentro, un rechazo no borra lo escrito y el primero se guarda', async ({ page }) => {
  // El alta se pintaba en dos ramas de un `{#if}` según hubiera cupones: al
  // abrirla, el foco caía a <body>; al guardar el primero, el formulario se
  // volvía a montar vacío, y con un rechazo se perdían lo escrito y la foto
  // (revisión de integración, ronda 2, m-1; UX, m1). Se vacía la cartera del
  // roble y al final se deja como estaba.
  const saved = await withAdmin(async (admin) => {
    await admin.query('begin');
    try {
      await admin.query('set local row_security = off');
      const { rows } = await admin.query<{ coupons: string; uses: string }>(
        `select (select coalesce(json_agg(c), '[]'::json) from app.coupons c where c.household_id = $1)::text as coupons,
                (select coalesce(json_agg(u), '[]'::json) from app.coupon_uses u where u.household_id = $1)::text as uses`,
        [HOUSEHOLD]
      );
      await admin.query('delete from app.coupon_uses where household_id = $1', [HOUSEHOLD]);
      await admin.query('delete from app.coupons where household_id = $1', [HOUSEHOLD]);
      await admin.query('commit');
      return rows[0]!;
    } catch (cause) {
      await admin.query('rollback');
      throw cause;
    }
  });

  try {
    let uploads = 0;
    // La primera foto «no es de la casa» (se rechaza); la segunda, sí.
    await fakeUpload(page, () => (++uploads === 1 ? randomUUID() : E2E_SEED.coupons.fotoLibre));
    await openWallet(page);
    await expect(page.getByRole('heading', { name: 'Todavía no hay cupones' })).toBeVisible();
    await page.getByRole('button', { name: 'Añadir el primer cupón' }).click();
    await expect(page.getByRole('heading', { name: 'Añadir un cupón' })).toBeFocused();

    const form = page.locator('#coupon-create');
    const save = form.getByRole('button', { name: 'Guardar el cupón' });
    await form.getByLabel('Elegir una foto guardada').setInputFiles(await syntheticPhoto(page, 'VALE UNO'));
    await form.getByLabel('Comercio').fill('Ferretería Clavo');
    await form.getByLabel('Qué ofrece').fill('3 € de descuento');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator('.coupon-notes')).toContainText('La foto no se ha podido unir al cupón');
    await expect(form.getByLabel('Comercio')).toHaveValue('Ferretería Clavo');
    await expect(form.getByLabel('Qué ofrece')).toHaveValue('3 € de descuento');

    await form.getByLabel('Elegir una foto guardada').setInputFiles(await syntheticPhoto(page, 'VALE DOS'));
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator('.coupon-notes')).toContainText('Cupón guardado ✓ · Ferretería Clavo');
    await expect(form).toBeHidden();
    await expect(page.getByRole('button', { name: 'Añadir un cupón' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Usar el cupón de Ferretería Clavo: 3 € de descuento' })).toBeVisible();
  } finally {
    await withAdmin(async (admin) => {
      await admin.query('begin');
      await admin.query('set local row_security = off');
      await admin.query('delete from app.coupon_uses where household_id = $1', [HOUSEHOLD]);
      await admin.query('delete from app.coupons where household_id = $1', [HOUSEHOLD]);
      await admin.query('insert into app.coupons select * from json_populate_recordset(null::app.coupons, $1::json)', [saved.coupons]);
      await admin.query('insert into app.coupon_uses select * from json_populate_recordset(null::app.coupon_uses, $1::json)', [saved.uses]);
      await admin.query('commit');
    });
  }
});
