import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// dims=cat,prov: con las dims por defecto (cat,sub) la maqueta no tiene
// subcategorías y el proveedor no llegaría a pintarse nunca.
// from/to explícitos (F6-M4): la maqueta ya anuncia el rango de la URL, y sin
// fijarlo el rótulo de «meses completos» dependería del reloj de la máquina
// (por defecto parseFilters da el año hasta hoy).
const ANALITICA = `/h/${HOUSEHOLD}/finanzas/analitica?dims=cat,prov&from=2026-01-01&to=2026-03-31`;

test.beforeEach(async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(ANALITICA);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Analítica');
});

test('la Analítica de la maqueta pinta KPIs, medias, partidas, gráfica y resumen', async ({ page }) => {
  await expect(page.getByTestId('kpi-analitica')).toContainText('Tasa ahorro bruta');
  await expect(page.getByTestId('kpi-analitica')).toContainText('Free cash flow');
  await expect(page.getByText('Media mensual · 3 meses completos')).toBeVisible();
  await expect(page.getByTestId('partidas-tabla')).toContainText('Semana Santa 2026');
  await expect(page.getByTestId('resumen-mensual')).toContainText('Ahorro bruto');
});

test('el pivot muestra las cinco bandas y el TOTAL NETO', async ({ page }) => {
  for (const banda of ['ingresos', 'gastos', 'eventos', 'internas', 'inversion']) {
    await expect(page.getByTestId(`pivot-banda-${banda}`)).toBeVisible();
  }
  // El testid cuelga de la fila REAL del total, así que es visible y tiene cifra.
  await expect(page.getByTestId('pivot-total-neto')).toBeVisible();
  await expect(page.getByTestId('pivot-total-neto')).toContainText('TOTAL NETO');
  // El subtotal de internas de la maqueta suma 0: sin aviso ⚠.
  await expect(page.getByTestId('pivot-table').getByText('Subtotal internas ⚠')).toHaveCount(0);
});

test('expandir un nodo enseña sus hijos y la selección levanta la barra de acciones', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  await expect(tabla).not.toContainText('Mercadona');
  await tabla.getByText('Supermercado', { exact: false }).first().click();
  await expect(tabla).toContainText('Mercadona');
  const fila = tabla.locator('tr', { hasText: 'Mercadona' }).first();
  await fila.getByRole('checkbox').click();
  const barra = page.getByTestId('pivot-actionbar');
  await expect(barra).toBeVisible();
  await expect(barra).toContainText('1 concepto');
});

test('mover a evento por la barra da un acuse honesto en modo fixture (sin base de datos)', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  await tabla.getByText('Supermercado', { exact: false }).first().click();
  await tabla.locator('tr', { hasText: 'Mercadona' }).first().getByRole('checkbox').click();
  const barra = page.getByTestId('pivot-actionbar');
  await barra.getByText('Mover a evento ▾').click();
  await barra.getByRole('button', { name: 'Semana Santa 2026' }).click();
  // Sin base de datos el sync no confirma: el comando queda en cola y se dice.
  await expect(page.getByTestId('pivot-toast')).toContainText('Guardado en este dispositivo');
});

test('el atajo «/» enfoca el buscador y un chip filtra el pivot expandiéndolo', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  // «Viajes» (Vueling) va etiquetado con el evento «Semana Santa 2026»: por
  // defecto (dupev vacío) el dominio lo rutea SOLO a EVENTOS, no a GASTOS —
  // hay que expandir el evento para que pinte antes de poder afirmar que el
  // filtro lo saca de verdad (si no, el aserto negativo de después no muerde:
  // nunca se habría pintado).
  await tabla.getByText('Semana Santa 2026', { exact: false }).first().click();
  await expect(tabla).toContainText('Viajes'); // antes del filtro sí está
  await page.keyboard.press('/');
  // `exact: true`: sin acotar, «Buscar» también casa por subcadena con el
  // botón de la lupa global de la cabecera («Buscar en toda la casa»), igual
  // que ya cubre finanzas.e2e.ts para el mismo choque de nombre.
  const buscador = page.getByLabel('Buscar', { exact: true });
  await expect(buscador).toBeFocused();
  await buscador.fill('merca');
  // Las sugerencias son <button role="option">: el `role` explícito manda
  // sobre el rol nativo del elemento (PivotSearch.svelte), así que el locator
  // real es por 'option', no por 'button' como asumía el brief.
  await page.getByRole('option', { name: /Mercadona/ }).first().click();
  await expect(page.getByText('🔍 Proveedor: Mercadona')).toBeVisible();
  await expect(tabla).toContainText('Mercadona'); // búsqueda activa fuerza expansión
  // El aserto negativo muerde: «Viajes» se pintaba y el chip lo saca del árbol.
  await expect(tabla).not.toContainText('Viajes');
});

test('las dims son reordenables y persisten en la URL', async ({ page }) => {
  await page.getByRole('button', { name: 'Naturaleza' }).click(); // añade la dim nat
  await expect(page).toHaveURL(/dims=cat%2Cprov%2Cnat|dims=cat,prov,nat/);
  await page.getByRole('button', { name: 'mover Naturaleza antes' }).click();
  await expect(page).toHaveURL(/nat%2Cprov|nat,prov/);
});

test('el árbol se despliega con teclado (camino accesible equivalente)', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  const disparador = tabla.getByRole('button', { name: 'desplegar Supermercado' });
  await expect(disparador).toHaveAttribute('aria-expanded', 'false');
  await disparador.focus();
  await page.keyboard.press('Enter');
  await expect(disparador).toHaveAttribute('aria-expanded', 'true');
  await expect(tabla).toContainText('Mercadona');
});

// Misma forma que «la empleada no alcanza Finanzas» de finanzas.e2e.ts: la
// Analítica es una ruta hija más y hereda la misma declaración de capacidad,
// pero al vivir en su propio fichero de fixture (T14) le falta cobertura
// directa — el `beforeEach` de este fichero entra como admin, así que aquí se
// vuelve a entrar como empleada antes de pedir la ruta.
test('la empleada no alcanza la Analítica: 403 en ruta declarada sin capacidad', async ({ page }) => {
  // El `beforeEach` de este fichero entra como admin: sin limpiar cookies,
  // `/login` redirige (303) a Hoy porque ya hay sesión y nunca enseña el
  // selector de cuentas que `loginAs` necesita (mismo patrón que
  // mobile-densidad.dbe2e.ts al cambiar de cuenta a mitad de test).
  await page.context().clearCookies();
  await loginAs(page, 'employee');
  const response = await page.goto(`/h/${HOUSEHOLD}/finanzas/analitica`);
  expect(response?.status()).toBe(403);
  // T16-M2: el código por sí solo no distingue un 403 del guard de ruta de un
  // 403 de cualquier otra capa. El cuerpo sí, y es el mismo que ya afirma
  // finanzas.e2e.ts para el Dashboard.
  await expect(page.locator('body')).toContainText('no está incluida en tu acceso');
});
