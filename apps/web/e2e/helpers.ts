import type { Page } from '@playwright/test';

export const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';

/**
 * Identificadores fijos de la siembra propia de la batería e2e sobre Postgres
 * (prefijos aa… para no chocar con las fixtures 1…/2… de @casa-clara/db ni con
 * la semilla 33… del editor de wiki). La siembra vive en db-global-setup.ts;
 * los specs .dbe2e.ts los usan para seleccionar entidades concretas.
 */
export const E2E_SEED = {
  memberships: {
    admin: '11000000-0000-4000-8000-000000000001',
    employee: '11000000-0000-4000-8000-000000000003'
  },
  agreement: '12000000-0000-4000-8000-000000000001',
  foods: {
    leche: 'aa100000-0000-4000-8000-000000000001',
    arroz: 'aa100000-0000-4000-8000-000000000002',
    pollo: 'aa100000-0000-4000-8000-000000000003',
    sinRevisar: 'aa100000-0000-4000-8000-000000000004'
  },
  diners: {
    marta: 'aa200000-0000-4000-8000-000000000001',
    leo: 'aa200000-0000-4000-8000-000000000002'
  },
  menuGroup: 'aa300000-0000-4000-8000-000000000001',
  wikiSpace: 'aa400000-0000-4000-8000-000000000001',
  recipePages: {
    /** «Arroz con leche (E2E)»: lleva leche → incompatible con Leo. */
    conLeche: 'aa410000-0000-4000-8000-000000000001',
    /** «Pollo asado (E2E)»: sin alérgenos declarados. */
    sinAlergenos: 'aa420000-0000-4000-8000-000000000001'
  },
  routines: {
    employee: 'aa500000-0000-4000-8000-000000000001',
    family: 'aa500000-0000-4000-8000-000000000002'
  },
  extras: {
    /** Jornada extra de Ana en estado requested (la acepta la familia). */
    requested: 'aa600000-0000-4000-8000-000000000001',
    /** Festivo trabajado sin aceptación previa: la familia lo resuelve. */
    porResolver: 'aa600000-0000-4000-8000-000000000002'
  },
  expensePending: 'aa700000-0000-4000-8000-000000000001'
} as const;

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
