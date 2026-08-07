import type { Page } from '@playwright/test';

export const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';

export const ACCOUNT_EMAILS = {
  admin: 'alberto.admin@casaclara.demo',
  family: 'marta.familia@casaclara.demo',
  employee: 'ana.empleada@casaclara.demo',
  helper: 'lucia.apoyo@casaclara.demo',
  viewer: 'diego.canguro@casaclara.demo'
} as const;

export async function loginAs(page: Page, account: keyof typeof ACCOUNT_EMAILS): Promise<void> {
  await page.goto('/login');
  await page
    .locator('button.account-card', { hasText: ACCOUNT_EMAILS[account] })
    .click();
  await page.waitForURL(`**/h/${HOUSEHOLD}/today`);
}
