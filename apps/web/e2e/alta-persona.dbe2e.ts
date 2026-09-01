import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

/*
 * El alta de una persona, que se mudó del expediente de otra a su propia ruta.
 *
 * Lo que se comprueba aquí y en ningún otro sitio:
 *   1. Que el camino empieza en la portada del hogar —donde el propietario pidió
 *      el botón— y no al final del contrato de una tercera.
 *   2. Que la ruta EXISTE. `employment/alta` es una ruta anidada y `guardForPath`
 *      falla cerrado con todo lo que no esté declarado en
 *      `NESTED_ROUTE_CAPABILITY`: sin la declaración esto sería un 403 y la
 *      pantalla no existiría para nadie. Es la trampa que el plan señalaba, y
 *      sólo un navegador de verdad la caza.
 *   3. Que sin identidad real la pantalla lo DICE en vez de ofrecer un alta
 *      imposible. Esta batería corre con base de datos y con el login por
 *      selector, sin `DATABASE_AUTH_URL`: es exactamente ese caso.
 *   4. Que pedir el contrato de alguien que no está esperando contrato responde
 *      con una frase, no con un formulario vacío.
 *
 * La mecánica de las dos etapas y lo que escribe cada una viven donde se pueden
 * probar de verdad: `hire-form.test.ts` (la lectura del formulario) y
 * `staff-hire.integration.test.ts` (la escritura, contra Postgres).
 */
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

test('el alta sale de la lista de personas, y la ruta existe porque está declarada', async ({
  page
}) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/employment`);

  await page.getByRole('link', { name: 'Añadir una persona' }).click();
  await page.waitForURL(/\/employment\/alta$/);
  await expect(page.getByRole('heading', { name: 'Añadir una persona a la casa' })).toBeVisible();

  // Sin identidad real no hay cuentas que crear, y se dice con esas palabras.
  await expect(page.locator('#main-content')).toContainText(
    'no gestiona cuentas de acceso'
  );
});

test('pedir el contrato de quien no lo está esperando responde con una frase', async ({ page }) => {
  await loginAs(page, 'admin');
  // Una membresía que existe pero tiene contrato activo: no es candidata.
  const respuesta = await page.goto(
    `/h/${HOUSEHOLD}/employment/alta?persona=11000000-0000-4000-8000-000000000003`
  );
  expect(respuesta?.status()).toBe(200);
  await expect(page.locator('#main-content')).toContainText(
    'no está entre las que tienen acceso y les falta contrato'
  );
});
