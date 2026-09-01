import { expect, test } from '@playwright/test';

import { loginAs } from './helpers';

/**
 * El ofrecimiento de instalar la aplicación en la pantalla de inicio.
 *
 * Se prueba en un navegador de verdad porque el defecto que esta batería
 * existe para impedir NO se ve en una prueba unitaria: Chromium dispara
 * `beforeinstallprompt` UNA sola vez y a menudo antes de que termine de
 * cargarse un módulo diferido. Con el listener registrado tarde, la decisión
 * pura seguiría siendo correcta —y sus pruebas, verdes— mientras el botón
 * «Instalar» no aparecía jamás en la mitad Chromium del público.
 *
 * Por eso aquí se dispara el evento DESPUÉS de que la página esté montada: si
 * el banner reacciona, es que alguien lo estaba escuchando desde el arranque.
 *
 * `(pointer: coarse)` se finge en vez de emular un dispositivo entero porque
 * es la única condición del entorno que un Chromium de escritorio no cumple, y
 * fingirla deja el resto de la decisión —instalada o no, evento capturado o
 * no, descartada o no— corriendo de verdad.
 */
test.use({ viewport: { width: 390, height: 844 } });

/** El evento que emite Chromium cuando la aplicación es instalable. */
async function ofreceInstalar(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) =>
      query === '(pointer: coarse)'
        ? ({
            matches: true,
            media: query,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => false
          } as unknown as MediaQueryList)
        : real(query)) as typeof window.matchMedia;

    const evento = new Event('beforeinstallprompt') as Event & {
      prompt?: () => Promise<unknown>;
    };
    evento.prompt = async () => {
      (window as unknown as { __instalacionPedida?: boolean }).__instalacionPedida = true;
      return { outcome: 'accepted' };
    };
    window.dispatchEvent(evento);
  });
}

const banner = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'Instalar la aplicación' });

test('cuando el navegador ofrece instalar, la aplicación lo propone y el botón llama al navegador', async ({
  page
}) => {
  await loginAs(page, 'admin');

  // Antes del ofrecimiento no hay nada: no se molesta a nadie por si acaso.
  await expect(banner(page)).toHaveCount(0);

  await ofreceInstalar(page);
  await expect(banner(page)).toBeVisible();

  await banner(page).getByRole('button', { name: 'Instalar' }).click();
  // La prueba de que el botón hace lo único que puede hacer: devolverle la
  // pregunta al navegador. Quien decide instalar es la persona, en el diálogo
  // del sistema, no esta pantalla.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __instalacionPedida?: boolean }).__instalacionPedida))
    .toBe(true);
});

test('se puede cerrar, no vuelve en esta visita, y vuelve en la siguiente', async ({ page }) => {
  await loginAs(page, 'admin');
  await ofreceInstalar(page);
  await expect(banner(page)).toBeVisible();

  await banner(page).getByRole('button', { name: 'Ahora no' }).click();
  await expect(banner(page)).toHaveCount(0);

  // Dentro de la misma visita sigue callado aunque el navegador vuelva a
  // ofrecerlo: cerrar tiene que significar algo.
  await ofreceInstalar(page);
  await expect(banner(page)).toHaveCount(0);

  // Y el descarte vive en `sessionStorage`, no en `localStorage`: es una
  // decisión para hoy, no para siempre. Quien lo cerró sin pensar vuelve a
  // tener la oferta mañana.
  expect(await page.evaluate(() => localStorage.getItem('housekeeper-install-dismissed'))).toBeNull();
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();

  // Se reintenta el ofrecimiento hasta que la página recargada está viva, que
  // es exactamente lo que hace el navegador de verdad: no emite el evento en
  // un momento pactado, sino cuando termina de comprobar la instalabilidad.
  await expect
    .poll(async () => {
      await ofreceInstalar(page);
      return banner(page).count();
    })
    .toBeGreaterThan(0);
});

test('entrando ya desde la pantalla de inicio no se ofrece instalar nada', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.evaluate(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) =>
      query === '(display-mode: standalone)' || query === '(pointer: coarse)'
        ? ({
            matches: true,
            media: query,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => false
          } as unknown as MediaQueryList)
        : real(query)) as typeof window.matchMedia;
    const evento = new Event('beforeinstallprompt') as Event & { prompt?: () => Promise<unknown> };
    evento.prompt = async () => ({ outcome: 'accepted' });
    window.dispatchEvent(evento);
  });

  await expect(banner(page)).toHaveCount(0);
});
