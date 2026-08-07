import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

test('las páginas visitadas siguen abriendo en modo avión', async ({ page, context }) => {
  await loginAs(page, 'admin');
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
    timeout: 20_000
  });

  await page.goto(`/h/${HOUSEHOLD}/emergency`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await context.setOffline(true);
  try {
    await page.goto(`/h/${HOUSEHOLD}/emergency`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('body')).toContainText('112');
  } finally {
    await context.setOffline(false);
  }
});

test('una ruta nunca visitada cae al aviso offline en vez de romper', async ({ page, context }) => {
  await loginAs(page, 'family');
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
    timeout: 20_000
  });

  await context.setOffline(true);
  try {
    await page.goto(`/h/${HOUSEHOLD}/recipes`);
    await expect(page.locator('body')).toContainText(/sin conexión|offline/i);
  } finally {
    await context.setOffline(false);
  }
});
