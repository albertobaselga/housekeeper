import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// UX-P1-5 / I-03: Emergencias debe abrir sin conexión también por el camino
// REAL — navegar por la SPA sin haber visitado nunca la página. El layout del
// hogar calienta la caché del service worker al montarse (una petición con el
// header x-casa-clara-warm-page que el SW guarda como página navegable); si la
// caché faltara, el fallback /offline pinta 112 y contactos desde el
// CriticalSnapshot de IndexedDB. Cualquiera de los dos caminos debe enseñar
// el 112 y algún contacto prioritario.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

test('Ana abre Emergencias offline sin haberla visitado: 112 y contactos visibles', async ({ page, context }) => {
  await loginAs(page, 'employee');

  // El SW controla la página y el layout de Hoy ha calentado la caché de la
  // ruta de emergencias (la marca de sesión se escribe tras el 200 del warm).
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
    timeout: 20_000
  });
  await page.waitForFunction(
    (householdId) => sessionStorage.getItem(`casa-clara-warmed-emergency:${householdId}`) !== null,
    HOUSEHOLD,
    { timeout: 20_000 }
  );

  await context.setOffline(true);
  try {
    // Camino SPA: un tap en «Ayuda»/Emergencias desde Hoy, sin visita previa.
    await page.locator(`a[href="/h/${HOUSEHOLD}/emergency"]`).first().click();

    await expect(page.locator('body')).toContainText('112', { timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Llamar al 112' })).toBeVisible();
    // Contacto prioritario del hogar (fixture del snapshot/página de emergencias).
    await expect(page.locator('body')).toContainText('Centro Pediátrico Olmo');
  } finally {
    await context.setOffline(false);
  }
});
