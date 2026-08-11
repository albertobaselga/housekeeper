import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

/**
 * La promesa escrita, comprobada en la pantalla de verdad.
 *
 * `docs/notificaciones.md` §4.4 dice que si se escribe la frase «la aplicación
 * no sabe hacerlo», tiene que haber prueba automatizada que la sostenga —mismo
 * trato que se le dio al AC-26—. Hay tres, y esta es la de arriba del todo: que
 * la persona la LEA. Las otras dos están en `apps/worker/src/push.test.ts` (el
 * catálogo de avisos, cerrado, que rechaza cualquier tópico de tarea, recuento,
 * presencia o ausencia de acción) y en `packages/db/tests/170_*.sql` (la RLS que
 * impide ver el canal de otra persona).
 *
 * Esta batería corre sobre la maqueta, sin base de datos y sin claves VAPID, que
 * es justamente el entorno donde el canal NO existe: comprueba lo que se dice
 * cuando no se puede encender nada, que es lo que ve cualquiera que abra la
 * demostración.
 */

test('la empleada alcanza «Tu cuenta» y lee lo que nunca se le va a mandar', async ({ page }) => {
  await loginAs(page, 'employee');
  const response = await page.goto(`/h/${HOUSEHOLD}/account`);
  expect(response?.status()).toBe(200);

  await expect(page.getByRole('heading', { name: 'Lo que nunca te vamos a mandar' })).toBeVisible();
  const promise = page.locator('.promise').first();
  await expect(promise).toContainText('Recordatorios de tareas o de rutinas');
  await expect(promise).toContainText('Cuentas de lo que llevas hecho');
  await expect(promise).toContainText('ni los domingos, ni mientras estés de vacaciones');
  await expect(promise).toContainText('la aplicación no sabe hacerlo');

  // La otra mitad, y la que hace defendible la regla: la simetría.
  await expect(page.locator('.promise').nth(1)).toContainText(
    'nadie de la casa puede ver si tienes los avisos encendidos'
  );
});

test('sin claves del canal no se ofrece un interruptor que no puede funcionar', async ({ page }) => {
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/account`);

  // La maqueta no tiene VAPID. Se dice, en vez de dibujar un botón que fallaría
  // al tocarlo, y se dice que no se pierde nada.
  await expect(page.getByText('Esta instalación no manda avisos al móvil.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Avisarme en este teléfono' })).toHaveCount(0);
});

test('el permiso no se pide en ninguna otra pantalla: no hay dónde mendigarlo', async ({ page }) => {
  await loginAs(page, 'employee');

  // El ofrecimiento contextual se descartó a propósito: en esta casa aparecería
  // sobre todo a quien menos margen tiene para ignorarlo. Queda el interruptor,
  // en reposo, en la pantalla que es suya. Ninguna otra menciona los avisos.
  for (const module of ['today', 'employment', 'routines', 'menu']) {
    await page.goto(`/h/${HOUSEHOLD}/${module}`);
    await expect(page.getByText(/activar los avisos|permitir notificaciones|avísame en este teléfono/i))
      .toHaveCount(0);
  }
});

test('quien administra tampoco ve el canal de nadie desde Ajustes del hogar', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/settings`);

  // El estado de notificaciones de una persona es presencia. Que Ajustes no lo
  // enseñe no es una omisión de la interfaz —lo impide la RLS— pero conviene que
  // tampoco haya sitio donde alguien sienta la tentación de ponerlo.
  await expect(page.getByText(/avisos activos|notificaciones de|recibe avisos/i)).toHaveCount(0);
});
