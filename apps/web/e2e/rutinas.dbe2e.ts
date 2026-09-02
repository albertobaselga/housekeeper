import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// La pantalla de Rutinas después de la ola de recurrencia (§4.1 de
// docs/rutinas-y-calendario.md): «¿Cuándo toca?» es UNA pregunta con revelado
// progresivo, la frase de vuelta dice en lengua de casa lo que se acaba de
// marcar, y la lista se agrupa por clase de ritmo.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

const phrase = (page: import('@playwright/test').Page) => page.locator('.cadence-phrase');

// La «próxima vez» de una rutina tiene que estar en el futuro cuando corra la
// prueba, o la lista dirá «vencía el …» con toda la razón. Una fecha escrita a
// mano caduca sin avisar (esta prueba estuvo un día entera en rojo por eso), así
// que se calcula desde el hoy de Madrid: el día 1 del mes que viene, para que la
// frase siga diciendo «el día 1». El nombre del día y del mes salen del mismo
// Intl en castellano que ya usan los demás e2e, en minúscula y sin coma, igual
// que `spanishDateLabel` del dominio.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const PROXIMA_DIA_1 = (() => {
  const date = new Date(`${TODAY}T00:00:00Z`);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
})();
const PROXIMA_LABEL = (() => {
  const date = new Date(`${PROXIMA_DIA_1}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat('es-ES', { weekday: 'long', timeZone: 'UTC' }).format(date);
  const month = new Intl.DateTimeFormat('es-ES', { month: 'long', timeZone: 'UTC' }).format(date);
  return `${weekday} 1 de ${month}`;
})();

test('el caso real de la casa: «limpieza a fondo de la cocina los lunes y los jueves»', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/routines`);

  await page.getByLabel('Título').fill('Limpieza a fondo de la cocina (E2E)');
  await page.getByRole('radio', { name: 'Días fijos de la semana' }).check();

  // Revelado progresivo: el subcontrol de días aparece, y solo ese.
  await expect(page.getByRole('button', { name: 'lunes', exact: true })).toBeVisible();
  await expect(page.getByLabel('¿Cuándo toca la próxima vez?')).toHaveCount(0);

  // Los botones son de multiselección y anuncian su estado, no su color.
  const lunes = page.getByRole('button', { name: 'lunes', exact: true });
  const jueves = page.getByRole('button', { name: 'jueves', exact: true });
  await lunes.click();
  await jueves.click();
  await expect(lunes).toHaveAttribute('aria-pressed', 'true');
  await expect(jueves).toHaveAttribute('aria-pressed', 'true');

  // La frase de vuelta, leída en voz alta por el lector de pantalla.
  await expect(phrase(page)).toHaveText('Toca los lunes y los jueves.');

  await page.getByRole('button', { name: 'Crear rutina' }).click();
  await expect(page.locator('.status-banner')).toHaveCount(0);

  // La lista la agrupa por su clase de ritmo y la segunda línea se lee igual
  // que la frase del formulario.
  const fila = page.locator('li').filter({ hasText: 'Limpieza a fondo de la cocina (E2E)' });
  await expect(fila).toBeVisible();
  await expect(fila.locator('small').first()).toContainText('los lunes y los jueves');
  await expect(page.getByRole('heading', { name: /^Días fijos de la semana · \d+$/ })).toBeVisible();
});

test('«Todavía no lo sabemos» se apunta aquí y no aparece en Hoy', async ({ page }) => {
  // §2.3: el desbloqueo de la ola. Una veintena de tareas del manual dicen
  // «pendiente de completar por la familia» y hasta ahora no cabían en el
  // sistema porque frequency y next_due_on eran NOT NULL (las retiró la 0033).
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/routines`);

  await page.getByLabel('Título').fill('Limpieza a fondo del garaje (E2E)');
  await page.getByRole('radio', { name: 'Todavía no lo sabemos' }).check();
  await expect(
    page.getByText('Quedará apuntada en esta página. No aparecerá en Hoy hasta que le pongáis día.')
  ).toBeVisible();
  await expect(phrase(page)).toHaveText('Sin día todavía. No aparecerá en Hoy.');

  await page.getByRole('button', { name: 'Crear rutina' }).click();
  await expect(page.locator('.status-banner')).toHaveCount(0);

  const fila = page.locator('li').filter({ hasText: 'Limpieza a fondo del garaje (E2E)' });
  await expect(fila).toBeVisible();
  await expect(fila.locator('small').first()).toContainText('sin día todavía');
  // No se puede completar lo que no tiene día: en su lugar, cómo ponérselo.
  await expect(fila.getByRole('button', { name: 'Marcar hecha' })).toHaveCount(0);
  await expect(fila.getByRole('link', { name: 'Ponerle día' })).toBeVisible();

  // Y jamás en Hoy: el prefiltro `next_due_hint <= hoy` excluye NULL.
  await page.goto(`/h/${HOUSEHOLD}/today`);
  await expect(page.getByText('Limpieza a fondo del garaje (E2E)')).toHaveCount(0);
});

test('«Cada cierto tiempo» pregunta la próxima vez y ya no habla de trimestres', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/routines`);

  await page.getByLabel('Título').fill('Revisión de la caldera (E2E)');
  await page.getByRole('radio', { name: 'Cada cierto tiempo' }).check();

  // «Trimestre» sale del vocabulario: «cada 3 meses» dice lo mismo en lengua
  // de casa y evita que la familia lea «cada 2 trimestres» para decir «medio
  // año». El desplegable solo ofrece día(s), semana(s) y mes(es).
  const unidad = page.getByLabel('Unidad de repetición');
  await expect(unidad).toHaveValue('weeks');
  await expect(unidad.locator('option')).toHaveText(['días', 'semanas', 'meses']);

  await unidad.selectOption('months');
  await page.getByLabel('Se repite cada cuántas').fill('3');
  await page.getByLabel('¿Cuándo toca la próxima vez?').fill(PROXIMA_DIA_1);
  await expect(phrase(page)).toHaveText(
    `Toca cada 3 meses, el día 1. La próxima, el ${PROXIMA_LABEL}.`
  );

  await page.getByRole('button', { name: 'Crear rutina' }).click();
  await expect(page.locator('.status-banner')).toHaveCount(0);
  const fila = page.locator('li').filter({ hasText: 'Revisión de la caldera (E2E)' });
  await expect(fila.locator('small').first()).toContainText(`la próxima, el ${PROXIMA_LABEL}`);
});

test('«Por temporada» habla de estaciones, no de «cada 2 trimestres»', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/routines`);

  await page.getByLabel('Título').fill('Cambio de ropa de armarios (E2E)');
  await page.getByRole('radio', { name: 'Por temporada' }).check();
  await expect(
    page.getByText('Te avisará el primer día de cada temporada que marques.')
  ).toBeVisible();

  await page.getByRole('button', { name: 'Verano' }).click();
  await page.getByRole('button', { name: 'Invierno' }).click();
  await expect(phrase(page)).toHaveText(
    'Toca al empezar el verano (1 de junio) y al empezar el invierno (1 de diciembre).'
  );

  await page.getByRole('button', { name: 'Crear rutina' }).click();
  await expect(page.locator('.status-banner')).toHaveCount(0);
  const fila = page.locator('li').filter({ hasText: 'Cambio de ropa de armarios (E2E)' });
  await expect(fila.locator('small').first()).toContainText('en verano y en invierno');
});

test('editar una rutina la lee igual en el formulario que en la lista', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/routines`);

  const fila = page.locator('li').filter({ hasText: 'Repaso del filtro del agua (E2E)' });
  const enLaLista = await fila.locator('small').first().innerText();

  await fila.getByRole('link', { name: 'Editar' }).click();
  await expect(page.getByRole('heading', { name: 'Editar rutina' })).toBeVisible();
  await expect(page.getByLabel('Título')).toHaveValue('Repaso del filtro del agua (E2E)');

  // La sembrada es `every_n_days` cada 7 días: el formulario la reconoce como
  // «Cada cierto tiempo», en semanas, y la frase repite lo que ya decía la
  // lista. Que las dos coincidan es el requisito, no una casualidad: la
  // cadencia y la fecha salen del mismo motor en los dos sitios.
  await expect(page.getByRole('radio', { name: 'Cada cierto tiempo' })).toBeChecked();
  await expect(page.getByLabel('Unidad de repetición')).toHaveValue('weeks');
  await expect(page.getByLabel('Se repite cada cuántas')).toHaveValue('1');

  const enElFormulario = await phrase(page).innerText();
  expect(enLaLista).toContain('cada semana');
  expect(enElFormulario).toContain('cada semana');

  // Y la MISMA próxima fecha, con las mismas palabras, en los dos sitios.
  const fecha = /la próxima, el (.+?)[.·]?$/i.exec(enLaLista.trim())?.[1];
  expect(fecha, `la lista debería nombrar la próxima fecha: ${enLaLista}`).toBeTruthy();
  expect(enElFormulario).toContain(`La próxima, el ${fecha}.`);
});

// `critical.a11y.ts` corre en modo maqueta, sin base de datos, así que allí
// /routines pinta la demostración y no este formulario. La revisión de axe del
// formulario de verdad tiene que vivir donde el formulario de verdad existe.
test('el formulario de cadencia pasa axe con cada subcontrol revelado', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/routines`);

  const serias = async (): Promise<string[]> => {
    const { violations } = await new AxeBuilder({ page }).analyze();
    return violations
      .filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))
      .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(' ')}`);
  };

  // Uno por uno: el revelado progresivo deja un solo subcontrol en el DOM cada
  // vez, así que una única pasada no llegaría a ver los otros.
  expect(await serias()).toEqual([]);

  await page.getByRole('radio', { name: 'Días fijos de la semana' }).check();
  await expect(page.getByRole('button', { name: 'lunes', exact: true })).toBeVisible();
  expect(await serias()).toEqual([]);

  await page.getByRole('radio', { name: 'Cada cierto tiempo' }).check();
  await expect(page.getByLabel('¿Cuándo toca la próxima vez?')).toBeVisible();
  expect(await serias()).toEqual([]);

  await page.getByRole('radio', { name: 'Por temporada' }).check();
  await expect(page.getByRole('button', { name: 'Primavera' })).toBeVisible();
  expect(await serias()).toEqual([]);
});
