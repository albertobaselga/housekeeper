import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { E2E_SEED, HOUSEHOLD, loginAs } from './helpers';

// Calendario unificado contra Postgres: vacío honesto sin fuentes, alta de un
// calendario enlazado en lenguaje llano, eventos «sincronizados» (la función
// definer del worker) junto a las RUTINAS en los tres alcances (enmienda E1),
// el pasado con su autoría (E2) y la prueba negativa de quién ve qué (E3).
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

const SOURCE_LABEL = 'Cole de los niños (E2E)';
const SOURCE_URL = 'https://calendario.example.com/cole-e2e.ics';

// La misma fecha civil de Madrid que usan los loads de Calendario y Hoy.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
// Día 1 del mes en curso: SIEMPRE dentro de la rejilla de seis semanas que
// descarga el calendario, mientras que «ayer» se sale de ella cuando hoy es día
// 1 de un mes que empieza en lunes.
const MONTH_START = `${TODAY.slice(0, 8)}01`;
const YEAR_START = `${TODAY.slice(0, 4)}-01-01`;
/** Posición del día 1 en la rejilla: empieza en el lunes de su propia semana. */
const MONTH_START_CELL = (new Date(`${MONTH_START}T00:00:00Z`).getUTCDay() + 6) % 7;

const ADMIN_MEMBERSHIP = E2E_SEED.memberships.admin;
const EMPLOYEE_MEMBERSHIP = E2E_SEED.memberships.employee;

// Ids propios de esta batería (prefijo cc…, sin choque con aa…/1…/3…).
const DAILY_ROUTINE = 'cc500000-0000-4000-8000-000000000001';
const SEASONAL_ROUTINE = 'cc500000-0000-4000-8000-000000000002';
const PRIVATE_ROUTINE = 'cc500000-0000-4000-8000-000000000003';
// La ocurrencia YA marcada de la enmienda E2 vive en su PROPIA rutina. Si
// compartiera rutina con la diaria, el día 1 de mes —cuando MONTH_START es
// justamente hoy— la dejaría marcada por adelantado: la de hoy pasaría a
// «Hecha · la marcó …» y se quedaría sin su cadencia a la vista ni casilla que
// tocar. Separarlas hace la prueba cierta los 31 días del mes.
const MARKED_ROUTINE = 'cc500000-0000-4000-8000-000000000004';

// Título y detalle SIN acentos a propósito para la prueba negativa de E3: el
// payload de la página viaja con escapes unicode, así que buscar «Revisión» en
// el HTML podría no encontrar nada aunque el dato SÍ estuviera viajando.
const PRIVATE_TITLE = 'Solo de la familia E2E';
const PRIVATE_DETAILS = 'Nadie mas debe leer esto E2E';

async function withAdminDb<T>(operation: (client: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await admin.connect();
  try {
    return await operation(admin);
  } finally {
    await admin.end();
  }
}

/** El calendario, en el alcance pedido. */
async function openCalendar(page: Page, scope?: 'Semana' | 'Mes' | 'Año'): Promise<void> {
  await page.goto(`/h/${HOUSEHOLD}/calendar`);
  if (scope && scope !== 'Semana') await page.getByRole('button', { name: scope, exact: true }).click();
}

/** Celdas de día de la rejilla del mes, con sus cuentas en el nombre accesible. */
const monthCells = (page: Page) => page.locator('table.month-grid button');

test('sin calendarios enlazados, el vacío es honesto y el alta habla llano', async ({ page }) => {
  await loginAs(page, 'admin');
  await openCalendar(page);
  await expect(page.getByRole('heading', { name: 'Ningún calendario enlazado todavía' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('demostración');

  // El formulario explica el alta sin tecnicismos por delante.
  await page.getByRole('button', { name: 'Enlazar un calendario' }).first().click();
  await expect(page.getByText('Pega el enlace de tu calendario')).toBeVisible();

  // Y en Hoy no hay bloque de agenda que finja eventos.
  await page.goto(`/h/${HOUSEHOLD}/today`);
  await expect(page.locator('body')).not.toContainText('Hoy en el calendario');
});

test('la familia enlaza un calendario desde la página y queda listado', async ({ page }) => {
  await loginAs(page, 'admin');
  await openCalendar(page);
  await page.getByRole('button', { name: 'Enlazar un calendario' }).first().click();
  await page.getByLabel('¿De quién es este calendario?').fill(SOURCE_LABEL);
  await page.getByLabel('Enlace del calendario').fill(SOURCE_URL);
  await page.getByRole('button', { name: 'Enlazar el calendario' }).click();

  await expect(page.getByRole('heading', { name: 'Calendarios enlazados' })).toBeVisible();
  await expect(page.getByText(SOURCE_LABEL)).toBeVisible();
  await expect(page.getByText('Pendiente de la primera lectura')).toBeVisible();

  // El alta encoló la sincronización real con la URL en el payload.
  const job = await withAdminDb((admin) =>
    admin.query(
      `select payload from app_private.job_queue
        where household_id = $1 and job_type = 'ics.sync_source'
        order by created_at desc limit 1`,
      [HOUSEHOLD]
    )
  );
  expect(job.rows[0]?.payload).toEqual({ url: SOURCE_URL, sourceId: expect.any(String) });
});

test('los eventos sincronizados se ven en el Calendario y en Hoy', async ({ page }) => {
  // El «worker» de esta batería: la función definer de la 0015 persiste las
  // ocurrencias como lo haría ics.sync_source tras descargar la fuente.
  await withAdminDb(async (admin) => {
    const source = await admin.query(
      `select id from app.ics_sources where household_id = $1 and label = $2`,
      [HOUSEHOLD, SOURCE_LABEL]
    );
    const sourceId = source.rows[0]?.id as string;
    expect(sourceId).toBeTruthy();
    await admin.query('select app_private.replace_ics_source_events($1, $2, $3::jsonb)', [
      HOUSEHOLD,
      sourceId,
      JSON.stringify([
        {
          uid: 'natacion-e2e@example.com',
          startsAt: `${TODAY}T10:00:00Z`,
          endsAt: `${TODAY}T11:00:00Z`,
          allDay: false,
          summary: 'Natación (E2E)',
          location: 'Piscina municipal',
          contentHash: 'a'.repeat(64)
        },
        {
          uid: 'excursion-e2e@example.com',
          startsAt: `${TODAY}T05:00:00Z`,
          endsAt: null,
          allDay: true,
          summary: 'Excursión del cole (E2E)',
          location: null,
          contentHash: 'b'.repeat(64)
        }
      ])
    ]);
    await admin.query("select app_private.record_ics_sync($1, $2, '')", [HOUSEHOLD, sourceId]);
  });

  await loginAs(page, 'admin');
  await openCalendar(page);
  await expect(page.getByText('Natación (E2E)')).toBeVisible();
  await expect(page.getByText('Excursión del cole (E2E)')).toBeVisible();
  await expect(page.getByText('Todo el día').first()).toBeVisible();
  await expect(page.getByText(SOURCE_LABEL).first()).toBeVisible();
  await expect(page.getByText('Al día (leído el').first()).toBeVisible();

  // Y el bloque de agenda real de Hoy lista los eventos del día.
  await page.goto(`/h/${HOUSEHOLD}/today`);
  await expect(page.getByRole('heading', { name: 'Hoy en el calendario' })).toBeVisible();
  await expect(page.getByText('Natación (E2E)')).toBeVisible();
});

test('el visor ve la agenda del hogar pero no la gestión de calendarios', async ({ page }) => {
  await loginAs(page, 'viewer');
  await openCalendar(page);
  await expect(page.getByText('Natación (E2E)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enlazar un calendario' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Calendarios enlazados');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rutinas en el calendario (enmiendas E1, E2 y E3)
// ─────────────────────────────────────────────────────────────────────────────

test('siembra: una rutina diaria, una estacional y una privada de la familia', async () => {
  await withAdminDb(async (admin) => {
    await admin.query(
      `insert into app.routines (id, household_id, title, details, audience,
                                 next_due_hint, created_by_membership_id,
                                 pattern, anchor_on, repeat_every, months, month_day, overdue_policy)
       values
         ($1, $4, 'Limpieza de baños (E2E)', 'Sin lejía en el mármol', 'all',
          $5::date, $8, 'every_n_days', $6::date, 1, null, null, 'skip'),
         ($2, $4, 'Cambio de armarios (E2E)', '', 'all',
          $5::date, $8, 'months_of_year', $7::date, null,
          array[6,12]::smallint[], 1, 'carry'),
         ($3, $4, '${PRIVATE_TITLE}', '${PRIVATE_DETAILS}', 'family',
          $5::date, $8, 'every_n_days', $6::date, 1, null, null, 'skip'),
         ($9, $4, 'Riego de las plantas (E2E)', '', 'all',
          $5::date, $8, 'every_n_days', $6::date, 1, null, null, 'skip')`,
      [
        DAILY_ROUTINE,
        SEASONAL_ROUTINE,
        PRIVATE_ROUTINE,
        HOUSEHOLD,
        TODAY,
        MONTH_START,
        YEAR_START,
        ADMIN_MEMBERSHIP,
        MARKED_ROUTINE
      ]
    );
    // Una ocurrencia pasada YA marcada por la empleada: es lo que hace visible
    // el «quién lo marcó» de la enmienda E2.
    await admin.query(
      `insert into app.routine_completions (household_id, routine_id, due_on, completed_by_membership_id)
       values ($1, $2, $3::date, $4)`,
      [HOUSEHOLD, MARKED_ROUTINE, MONTH_START, EMPLOYEE_MEMBERSHIP]
    );
  });
});

test('la semana separa rutinas y eventos por forma y posición, no por color', async ({ page }) => {
  await loginAs(page, 'admin');
  await openCalendar(page);

  // Dos bloques etiquetados dentro del día, no una lista revuelta.
  await expect(page.locator('p.block-label', { hasText: 'Rutinas' }).first()).toBeVisible();
  await expect(page.locator('p.block-label', { hasText: 'En el calendario' }).first()).toBeVisible();
  // La rutina dice su cadencia y su audiencia; el evento, su hora y su fuente.
  await expect(page.getByText('todos los días · Toda la casa').first()).toBeVisible();

  // La forma es la promesa: SOLO lo de hoy lleva casilla que se pueda marcar.
  await expect(page.getByRole('button', { name: 'Marcar hecha: Limpieza de baños (E2E)' })).toHaveCount(1);

  // El detalle se abre al tocar el título, sin salir de la pantalla ni pedir red.
  await page.getByText('Limpieza de baños (E2E)').first().click();
  await expect(page.getByText('Sin lejía en el mármol').first()).toBeVisible();

  // La semana siguiente es toda futuro: se ve lo que toca y no se marca nada.
  await page.getByRole('button', { name: 'Semana siguiente' }).click();
  await expect(page.getByText('Toca este día').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Marcar hecha:/ })).toHaveCount(0);
});

test('el pasado se ve con quién lo marcó, y sin ninguna nota (E2)', async ({ page }) => {
  await loginAs(page, 'admin');
  await openCalendar(page, 'Mes');

  await monthCells(page).nth(MONTH_START_CELL).click();
  await expect(page.getByText('la marcó Fixture Empleada Roble').first()).toBeVisible();

  // Ni una cifra que puntúe a nadie, en ninguna parte de la pantalla.
  const body = (await page.locator('body').innerText()).toLowerCase();
  expect(body).not.toMatch(/\d\s?%/);
  for (const forbidden of ['racha', 'porcentaje', 'cumplimiento', 'media de', 'ranking']) {
    expect(body, `la pantalla habla de «${forbidden}»`).not.toContain(forbidden);
  }
});

test('la empleada no recibe una rutina de la familia ni en el HTML ni en el JSON (E3)', async ({ page }) => {
  await loginAs(page, 'employee');
  await openCalendar(page);

  // Lo suyo, sí.
  await expect(page.getByText('Limpieza de baños (E2E)').first()).toBeVisible();

  // Lo de la familia, ni pintado ni viajando: `page.content()` trae el HTML
  // servido Y el payload que SvelteKit serializa para hidratar. Se comprueban
  // el título, el detalle y los identificadores, que son ASCII puro y no pueden
  // colarse escapados.
  const content = await page.content();
  expect(content).not.toContain(PRIVATE_TITLE);
  expect(content).not.toContain(PRIVATE_DETAILS);
  expect(content).not.toContain(PRIVATE_ROUTINE);
  expect(content).not.toContain(E2E_SEED.routines.family);

  // Y en los tres alcances, porque los tres se pintan del mismo payload.
  for (const scope of ['Mes', 'Año'] as const) {
    await page.getByRole('button', { name: scope, exact: true }).click();
    expect(await page.content()).not.toContain(PRIVATE_TITLE);
    expect(await page.content()).not.toContain(PRIVATE_ROUTINE);
  }
});

test('el mes es una rejilla con datos y el año contesta «¿cuándo toca lo estacional?»', async ({ page }) => {
  await loginAs(page, 'admin');
  await openCalendar(page, 'Mes');

  // Seis semanas completas, y cada celda dice sus cuentas exactas en su nombre
  // accesible: la marca de color es decoración.
  await expect(monthCells(page)).toHaveCount(42);
  await expect(page.getByRole('button', { name: /, \d+ rutinas?/ }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Año', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Junio', exact: true })).toBeVisible();
  // Lo señalado: la rutina estacional sale en junio y en diciembre. La diaria
  // NO, porque a escala de año repetirla 365 veces no informa de nada.
  await expect(page.getByText('Cambio de armarios (E2E)').first()).toBeVisible();
  await expect(page.getByText('Limpieza de baños (E2E)')).toHaveCount(0);
  // El año enseña lo previsto: nunca dice quién hizo qué.
  await expect(page.locator('body')).not.toContainText('la marcó');

  // Y desde el año se salta al mes.
  await page.getByRole('button', { name: 'Junio', exact: true }).click();
  await expect(monthCells(page)).toHaveCount(42);
});

test('marcar hecha desde el calendario solo alcanza a hoy', async ({ page }) => {
  await loginAs(page, 'employee');
  await openCalendar(page);

  await page.getByRole('button', { name: 'Marcar hecha: Limpieza de baños (E2E)' }).click();
  // El chip aparece ANTES de que el comando viaje (pintado optimista): no vale
  // como prueba de que se haya guardado. Lo que se comprueba es la fila.
  await expect(page.getByText('Hecha ✓').first()).toBeVisible();
  await expect
    .poll(
      async () => {
        const done = await withAdminDb((admin) =>
          admin.query<{ by: string }>(
            `select completed_by_membership_id as by from app.routine_completions
              where household_id = $1 and routine_id = $2 and due_on = $3::date`,
            [HOUSEHOLD, DAILY_ROUTINE, TODAY]
          )
        );
        return done.rows[0]?.by ?? null;
      },
      { timeout: 15_000 }
    )
    .toBe(EMPLOYEE_MEMBERSHIP);

  // Ya marcada, la casilla desaparece: desde la pantalla no hay doble marcado,
  // y el hecho queda con su autoría.
  await openCalendar(page);
  await expect(page.getByRole('button', { name: 'Marcar hecha: Limpieza de baños (E2E)' })).toHaveCount(0);
  await expect(page.getByText('la marcó Fixture Empleada Roble').first()).toBeVisible();
});

test('los tres alcances pasan axe a 390 px, que es donde más duele', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, 'admin');
  for (const scope of ['Semana', 'Mes', 'Año'] as const) {
    await openCalendar(page, scope);
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? '')
    );
    const detail = serious
      .flatMap((violation) => violation.nodes.map((node) => `${violation.id}: ${node.html}`))
      .join('\n');
    expect(serious.map((violation) => violation.id), `axe se queja en «${scope}»:\n${detail}`).toEqual([]);
  }
});

test('sin conexión se siguen calculando las rutinas y se dice qué falta', async ({ page, context }) => {
  await loginAs(page, 'employee');
  // Primero el control del service worker y DESPUÉS la visita: una navegación
  // anterior al `claim()` no pasa por su `fetch` y no se guarda en la caché de
  // páginas, así que el `reload` sin red caería en el fallback /offline.
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
    timeout: 20_000
  });
  await openCalendar(page);
  await expect(page.getByText('Limpieza de baños (E2E)').first()).toBeVisible();

  await context.setOffline(true);
  try {
    // La página sigue abriendo: la sirve el service worker desde su caché.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Calendario' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Limpieza de baños (E2E)').first()).toBeVisible();

    // Y un mes que NUNCA se ha descargado también se pinta: las rutinas se
    // expanden aquí, en el navegador, a partir de sus reglas. La banda dice a
    // cambio qué no se puede saber, que es lo que impide leer un día pasado sin
    // datos como un día en que no se hizo nada.
    await page.getByRole('button', { name: 'Mes', exact: true }).click();
    await page.getByRole('button', { name: 'Mes siguiente' }).click();
    await expect(page.getByText('Fuera de lo descargado')).toBeVisible();
    await expect(page.getByRole('button', { name: /, \d+ rutinas?/ }).first()).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  // La banda de «Sin conexión» NO se comprueba aquí a propósito: depende de
  // `navigator.onLine`, y `context.setOffline` de Playwright corta la red sin
  // tocar esa propiedad (se ha medido: sigue en `true`). Su texto se prueba en
  // `tests/calendar-view.test.ts` sobre `calendarNotices`, que es puro.
});
