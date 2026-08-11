import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

/**
 * La otra mitad de `avisos.e2e.ts`: **con** canal configurado.
 *
 * Aquella batería corre sobre la maqueta, sin claves, y comprueba que no se
 * dibuje un interruptor que fallaría al tocarlo. Perfecto, pero era la ÚNICA:
 * nadie probaba la rama con claves puestas. El resultado fue que los avisos se
 * desplegaron a producción sin las variables de entorno, la pantalla decía
 * «esta instalación no manda avisos al móvil» —el mensaje correcto para una
 * instalación mal configurada— y todas las suites seguían en verde, porque
 * verde era exactamente lo que esperaban.
 *
 * Esta suite arranca con VAPID de juguete (ver `playwright.db.config.ts`) para
 * que la rama existente se ejerza al menos una vez. No manda ningún aviso: solo
 * exige que, cuando hay canal, la persona encuentre el interruptor.
 */
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

/**
 * Alcance honesto de esta suite: llega hasta donde llega el navegador.
 *
 * Chromium sin cabeza deniega los avisos de fábrica —`Notification.permission`
 * es `denied` incluso concediendo el permiso desde Playwright—, así que la rama
 * del interruptor no se puede ejercer aquí. Da igual: **el fallo de producción
 * no estaba ahí**. Estaba un paso antes, en el servidor, que sin las tres
 * variables no entregaba clave alguna y mandaba pintar «esta instalación no
 * manda avisos al móvil» para todo el mundo. Eso sí se comprueba, y es lo único
 * que hacía falta para haberlo cazado a tiempo.
 */

test('con canal configurado, el servidor deja de decir que no hay canal', async ({ page }) => {
  await loginAs(page, 'employee');
  const response = await page.goto(`/h/${HOUSEHOLD}/account`);
  expect(response?.status()).toBe(200);

  await expect(page.getByRole('heading', { name: 'Tus avisos en este teléfono' })).toBeVisible();

  // La aserción que habría cazado el fallo: con las tres claves puestas, este
  // mensaje no puede seguir apareciendo.
  await expect(page.getByText('Esta instalación no manda avisos al móvil.')).toHaveCount(0);

  // Y lo que se ve en su lugar es una razón del NAVEGADOR, no de la instalación:
  // el permiso, o la falta de soporte. Cualquiera de las dos significa que la clave
  // llegó.
  await expect(
    page.getByText(
      /avisos bloqueados para esta aplicación|Este navegador no sabe mandar avisos|Avisarme en este teléfono|Dejar de avisarme|solo funcionan si abres la aplicación/
    )
  ).toBeVisible();

  // La promesa sigue en pie, que es lo que hace aceptable el interruptor.
  await expect(page.getByRole('heading', { name: 'Lo que nunca te vamos a mandar' })).toBeVisible();
});

test('quien administra ve su propio canal, y el de nadie más', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/account`);

  await expect(page.getByRole('heading', { name: 'Tus avisos en este teléfono' })).toBeVisible();
  await expect(page.getByText('Esta instalación no manda avisos al móvil.')).toHaveCount(0);

  // Desde Ajustes del hogar no se ve ni se toca el canal de nadie: la RLS lo
  // impide en la base (packages/db/tests/170) y aquí se comprueba que tampoco
  // hay puerta en la interfaz.
  await page.goto(`/h/${HOUSEHOLD}/settings`);
  await expect(page.getByText('avisos en este teléfono')).toHaveCount(0);
});
