import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// Ninguna pantalla puede desbordar en horizontal en un móvil estrecho: a 320 px
// (el mínimo razonable, iPhone SE 1.ª gen / plegable cerrado) el documento debe
// caber entero. El síntoma que motivó este spec: Contrato tenía un ancho mínimo de
// contenido muy por encima del viewport, así que Chromium ensanchaba el
// viewport de maquetación y recortaba etiquetas y botones de las tarjetas.
//
// La comprobación es la del navegador, no una aproximación: scrollWidth del
// documento contra su clientWidth. Cuando falla, el mensaje nombra los
// elementos que se salen del borde derecho para que el arreglo no sea a ciegas.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

/** Anchos de móvil que la app debe soportar sin scroll horizontal. */
const WIDTHS = [320, 390] as const;

interface OverflowRoute {
  path: string;
  label: string;
  as: 'admin' | 'employee';
  /** Pasos extra para llegar a una vista que no tiene URL propia (pestañas). */
  reveal?: (page: Page) => Promise<void>;
}

const ROUTES: readonly OverflowRoute[] = [
  { path: 'today', label: 'Hoy', as: 'admin' },
  // Contrato se mira con los dos roles: la familia ve las tarjetas de decisión y
  // el historial de liquidaciones; la empleada, el parte semanal y su alta de
  // gastos. Son maquetaciones distintas y ambas desbordaban.
  { path: 'employment', label: 'Contrato (familia)', as: 'admin' },
  { path: 'employment', label: 'Contrato (empleada)', as: 'employee' },
  { path: 'menu', label: 'Menú', as: 'admin' },
  {
    path: 'menu',
    label: 'Compra',
    as: 'admin',
    reveal: async (page) => {
      await page.getByRole('button', { name: 'Lista de la compra' }).click();
      await expect(page.getByRole('heading', { name: 'Lista de la compra' })).toBeVisible();
    }
  },
  { path: 'recipes', label: 'Recetas', as: 'admin' },
  { path: 'routines', label: 'Rutinas', as: 'admin' },
  { path: 'wiki', label: 'Guía de la casa', as: 'admin' },
  {
    path: 'wiki/lavadora',
    label: 'Guía · una nota',
    as: 'admin',
    reveal: async (page) => {
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
  },
  { path: 'calendar', label: 'Calendario', as: 'admin' },
  { path: 'contacts', label: 'Contactos', as: 'admin' },
  { path: 'settings', label: 'Ajustes', as: 'admin' },
  { path: 'emergency', label: 'Emergencias', as: 'admin' }
];

/**
 * Diagnóstico dentro del navegador: además de la medida global devuelve los
 * elementos cuyo borde derecho se sale del documento, que son los que hay que
 * arreglar. Se recorta a los diez primeros para que el mensaje sea legible.
 */
async function measureOverflow(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const limit = root.clientWidth;
    const offenders: string[] = [];
    for (const element of Array.from(document.body.querySelectorAll('*'))) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (getComputedStyle(element).position === 'fixed') continue;
      if (box.right <= limit + 1) continue;
      const id = element.id ? `#${element.id}` : '';
      const raw = typeof element.className === 'string' ? element.className.trim() : '';
      const cls = raw ? `.${raw.split(/\s+/).join('.')}` : '';
      offenders.push(`${element.tagName.toLowerCase()}${id}${cls} → ${Math.round(box.right)}px`);
    }
    return { scrollWidth: root.scrollWidth, clientWidth: limit, offenders: offenders.slice(0, 10) };
  });
}

for (const width of WIDTHS) {
  test.describe(`a ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });

    for (const route of ROUTES) {
      test(`${route.label} cabe sin scroll horizontal`, async ({ page }) => {
        await loginAs(page, route.as);
        await page.goto(`/h/${HOUSEHOLD}/${route.path}`);
        await page.waitForLoadState('networkidle');
        if (route.reveal) await route.reveal(page);

        const measured = await measureOverflow(page);
        expect(
          measured.scrollWidth,
          `${route.label} desborda a ${width} px (${measured.scrollWidth} > ${measured.clientWidth}). Se salen: ${measured.offenders.join(' | ') || 'ninguno identificado'}`
        ).toBeLessThanOrEqual(measured.clientWidth);
      });
    }
  });
}
