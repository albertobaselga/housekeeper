import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// Flujo laboral de la FAMILIA (Alberto, family_admin) contra Postgres real
// (config playwright.db.config.ts, `pnpm test:e2e:db`): acepta y resuelve las
// jornadas extra sembradas, aprueba el gasto pendiente de Ana, lleva la
// liquidación del mes en curso de abierta a pagada y apunta una jornada nueva a
// nombre de la empleada eligiendo a cuál de las dos. Los tests son serializados
// porque cada paso construye sobre el estado que dejó el anterior.
//
// Con la sección en pestañas, el flujo navega como una persona: registrar y
// decidir en Conceptos, la cuenta y sus cifras en el Resumen, los pagos en
// Pagos. Cambiar de pestaña no cambia de empleada: `?empleada=` viaja en la
// barra.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

function euroToCents(label: string): bigint {
  const [units = '0', fraction = '00'] = label.replace(/\.|\s|€/g, '').split(',');
  return BigInt(units) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function centsToEuroInput(cents: bigint): string {
  const units = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${units},${(cents % 100n).toString().padStart(2, '0')}`;
}

// La página pinta el vencimiento en fecha humana (P3-2): "2026-08-31" → "31 ago 2026".
function dueDateLabel(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${day} ${months[month! - 1]} ${year}`;
}

/**
 * Primero la persona: `/employment` con dos empleadas es la PORTADA del hogar
 * (la cuenta total del mes y una tarjeta por persona). El flujo entra por ahí,
 * como entraría una persona, y abre el expediente de Ana.
 */
async function gotoEmployment(page: Page): Promise<void> {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/employment`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const fila = page
    .locator('[data-lista="principal"] > div')
    .filter({ hasText: 'Fixture Empleada Roble' })
    .first();
  await fila.getByRole('link', { name: 'Abrir su expediente' }).click();
  await expect(page.getByRole('navigation', { name: 'Secciones del contrato' })).toBeVisible();
}

/** Navegación de sección: la barra de pestañas, como la usaría una persona. */
async function gotoTab(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Secciones del contrato' })
    .getByRole('link', { name })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test('Alberto acepta la jornada solicitada y resuelve el festivo como descanso: el saldo permanente sube', async ({ page }) => {
  await gotoEmployment(page);

  // Estado sembrado: crédito permanente de partida (fixture), en el Resumen.
  const balanceCard = page.locator('article.card').filter({ hasText: 'Tiempo y compensación' });
  const balanceRow = balanceCard.locator('.balance-list > div').filter({ hasText: 'Descanso compensatorio' });
  await expect(balanceRow).toContainText('1 día');

  // Las decisiones viven en Conceptos.
  await gotoTab(page, 'Conceptos');
  const extrasCard = page.locator('article.card').filter({ hasText: 'Jornadas extra' });

  // 1) Acepta la jornada extra sembrada en estado requested.
  const requestedRow = extrasCard.locator('.ledger-list > div').filter({ hasText: 'Plancha del sábado E2E' });
  await expect(requestedRow).toContainText('Solicitada');
  await requestedRow.getByRole('button', { name: 'Aceptar' }).click();
  await expect(requestedRow).toContainText('Aceptada · sin realizar');

  // 2) Resuelve el festivo trabajado como compensación en descanso, con motivo.
  const resolvableRow = extrasCard.locator('.ledger-list > div').filter({ hasText: 'Festivo trabajado E2E' });
  await expect(resolvableRow).toContainText('Hecha sin acordarla antes');
  await resolvableRow.getByRole('button', { name: 'Decidir compensación' }).click();
  // El formulario de decidir, no el de apuntar: desde que quien administra
  // puede apuntar jornadas a nombre de otra persona, en la tarjeta conviven dos.
  const resolveForm = extrasCard.locator('form.action-form:not(.register-extra-form)');
  await expect(resolveForm).toBeVisible();
  await resolveForm.getByLabel('Compensación').selectOption('time_off');
  await resolveForm.getByLabel('Motivo').fill('Descanso pactado con Ana E2E');
  await resolveForm.getByRole('button', { name: 'Confirmar la decisión' }).click();

  // La jornada resuelta desaparece de pendientes y el crédito PERMANENTE sube
  // (worked_rest_day_credit_minutes = 1440 de la versión vigente: 1 día más),
  // visible de vuelta en el Resumen.
  await expect(resolvableRow).toHaveCount(0);
  await gotoTab(page, 'Resumen');
  await expect(balanceRow).toContainText('2 días');
});

test('Alberto aprueba el gasto pendiente de Ana con motivo y entra en el devengo', async ({ page }) => {
  await gotoEmployment(page);
  await gotoTab(page, 'Conceptos');

  const expensesCard = page.locator('article.card').filter({ hasText: 'Gastos pendientes' });
  const pendingRow = expensesCard.locator('.ledger-list > div').filter({ hasText: 'Farmacia E2E pendiente' });
  await expect(pendingRow).toContainText('21,75 €');
  await pendingRow.getByRole('button', { name: 'Revisar' }).click();

  const decideForm = expensesCard.locator('form.action-form');
  // Default sensato: el motivo llega prellenado («Aprobado») y editable.
  await expect(decideForm.getByLabel('Motivo de la decisión')).toHaveValue('Aprobado');
  await decideForm.getByLabel('Motivo de la decisión').fill('Justificante correcto E2E');
  await decideForm.getByRole('button', { name: 'Aprobar' }).click();

  // Aprobado: sale de pendientes y el devengo del mes lo proyecta como
  // reembolso, en la tira de cifras del Resumen.
  await expect(pendingRow).toHaveCount(0);
  await gotoTab(page, 'Resumen');
  await expect(page.locator('.summary-strip')).toContainText('21,75 €');
});

test('Alberto abre la liquidación del mes en curso con vencimiento, la cierra y la paga en dos plazos', async ({ page }) => {
  await gotoEmployment(page);
  // Todo el ciclo de la cuenta vive en Pagos.
  await gotoTab(page, 'Pagos');

  // 1) Abrir: el formulario propone el fin de mes como vencimiento. Abrir la
  // cuenta del mes es irreversible: vive plegada, no encima del historial.
  await page.locator('details.open-settlement > summary').click();
  const openForm = page.locator('form.open-settlement-form');
  await expect(openForm).toBeVisible();
  const dueOn = await openForm.getByLabel('¿Cuándo vence el pago?').inputValue();
  expect(dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await openForm.getByRole('button', { name: /Empezar la cuenta de/ }).click();

  // La cuenta nueva aparece como una fila más de la tabla, plegada: el
  // vencimiento se lee SIN desplegarla, y el botón de cierre espera dentro.
  const settlementsCard = page.locator('article.card').filter({ hasText: 'Historial con pagos' });
  await expect(settlementsCard).toContainText(`Vence el ${dueDateLabel(dueOn)}`);
  await expect(openForm).toHaveCount(0);
  await settlementsCard.locator('details.mes > summary').first().click();
  const closeButton = page.getByRole('button', { name: 'Cerrar el mes' });
  await expect(closeButton).toBeVisible();

  // 2) Cerrar: el servidor materializa las líneas desde los hechos del mes.
  await closeButton.click();
  const paymentForm = page.locator('form').filter({ hasText: 'Registrar pago' });
  await expect(paymentForm).toBeVisible();
  await expect(page.locator('.status-chip').filter({ hasText: 'Pendiente de pago' })).toBeVisible();

  // 3) Pago parcial: el importe llega PRELLENADO con todo el pendiente (default
  //    «pagar todo») pero sigue siendo editable para un pago parcial.
  const amountInput = paymentForm.getByLabel('Importe (€)');
  const totalLabel = await amountInput.inputValue();
  const totalCents = euroToCents(totalLabel);
  expect(totalCents).toBeGreaterThan(100000n);
  await expect(paymentForm.getByRole('button', { name: /Pagar todo/ })).toBeVisible();
  await amountInput.fill('1.000,00');
  await paymentForm.getByRole('button', { name: 'Registrar pago' }).click();
  await expect(page.locator('.status-chip').filter({ hasText: 'Pago parcial registrado' })).toBeVisible();

  const remainingCents = totalCents - 100000n;
  const remainingLabel = `${centsToEuroInput(remainingCents)} €`;
  await expect(settlementsCard).toContainText(remainingLabel);

  // 4) El resto: tras el pago parcial el campo vuelve a proponer exactamente el
  //    pendiente restante; con el default basta para dejarla pagada (el cobro
  //    lo confirma Ana aparte).
  const secondForm = page.locator('form').filter({ hasText: 'Registrar pago' });
  await expect(secondForm.getByLabel('Importe (€)')).toHaveValue(centsToEuroInput(remainingCents));
  await secondForm.getByRole('button', { name: 'Registrar pago' }).click();
  await expect(page.locator('.status-chip').filter({ hasText: 'Pagada · cobro sin confirmar' })).toBeVisible();

  // Y cada cuenta ofrece su documento de pago en PDF, generado bajo la sesión
  // de quien lo pide. En la fila sólo cabe «PDF»; el nombre accesible lleva el
  // mes, así que se busca por lo que no cambia.
  const documentLink = settlementsCard.getByRole('link', { name: /Descargar el documento de pago/ }).first();
  await expect(documentLink).toBeVisible();
  const href = await documentLink.getAttribute('href');
  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('application/pdf');
});

// Conceptos del catálogo de las fixtures (packages/db/fixtures): «Jornada
// extra» es del acuerdo de Ana y vale 50,00 € la jornada de 10 h; «Jornada
// completa» es del acuerdo de su compañera. Ninguno de los dos vale para el
// acuerdo del otro, y esa frontera la guarda el servidor.
const TYPE_JORNADA_EXTRA = '13000000-0000-4000-8000-000000000005';
const TYPE_JORNADA_COMPLETA = '13000000-0000-4000-8000-000000000008';
const AGREEMENT_SEGUNDA = '12000000-0000-4000-8000-000000000002';

test('Alberto apunta una jornada a nombre de Ana y la cierra en el acto, con el concepto del catálogo', async ({ page }) => {
  await gotoEmployment(page);
  await gotoTab(page, 'Conceptos');

  const extrasCard = page.locator('article.card').filter({ hasText: 'Jornadas extra' });
  const registerForm = extrasCard.locator('form.register-extra-form');
  // El formulario dice a nombre de QUIÉN se apunta: el hecho se queda en su
  // expediente, no en el de quien lo teclea.
  await expect(registerForm).toContainText('Apuntar una jornada a Fixture Empleada Roble');

  await registerForm.getByLabel('Tipo').selectOption(TYPE_JORNADA_EXTRA);
  // Un concepto por jornada no pregunta la duración: la trae pactada.
  await expect(registerForm).toContainText('jornada de 10 h');
  await expect(registerForm.getByLabel('Horas')).toHaveCount(0);
  await registerForm.getByLabel('Nota (opcional)').fill('Se quedó el sábado E2E');

  // Apuntar lo que ya ocurrió y decidir su compensación es un solo gesto.
  await registerForm.getByRole('checkbox', { name: 'Ya la hizo: decidir ahora la compensación' }).check();
  // Por rol: la casilla dice «…la compensación» y el desplegable se llama
  // igual, así que buscar por etiqueta a secas encontraría los dos.
  await registerForm.getByRole('combobox', { name: /^Compensación/ }).selectOption('money');
  await registerForm.getByLabel('Motivo').fill('Se le paga con este mes E2E');
  await registerForm.getByRole('button', { name: 'Apuntar la jornada' }).click();

  // Cerrada en el acto: no queda pendiente en Conceptos y entra en la cuenta
  // del mes del Resumen por los 50,00 € del concepto —nadie tecleó ese
  // importe— y diciendo quién la apuntó.
  await expect(extrasCard.locator('.ledger-list > div').filter({ hasText: 'Se quedó el sábado E2E' })).toHaveCount(0);
  await gotoTab(page, 'Resumen');
  const ledgerCard = page.locator('article.card').filter({ hasText: 'Lo que va sumando' });
  const ledgerRow = ledgerCard.locator('.ledger-list > div').filter({ hasText: 'Se quedó el sábado E2E' });
  await expect(ledgerRow).toContainText('+50,00 €');
  await expect(ledgerRow).toContainText('La apuntó la familia');
});

test('Alberto cambia de empleada por la portada y el expediente entero es el de la otra, pestaña a pestaña', async ({ page }) => {
  await gotoEmployment(page);

  // Dentro del expediente, la barra fija dice de quién es y «Cambiar» vuelve
  // a la portada del hogar: primero la persona, luego los detalles.
  const personBar = page.locator('.person-bar');
  await expect(personBar).toContainText('Fixture Empleada Roble');
  await personBar.getByRole('link', { name: 'Cambiar' }).click();

  // La portada: lo que se DEBE en la celda destacada —no lo que va sumando el
  // mes, que es previsión— y una línea por empleada. Sin deuda dice «Al día»,
  // que es la respuesta y no un «0,00 €».
  const tira = page.locator('.summary-strip');
  await expect(tira).toContainText('Va sumando este mes');
  await expect(tira).toContainText('Pendiente de pago');
  const tarjetas = page.locator('[data-lista="principal"] > div');
  await expect(tarjetas).toHaveCount(2);
  // Y el alta sale de aquí, que es de donde el propietario pidió que saliera.
  await expect(page.getByRole('link', { name: 'Añadir una persona' })).toBeVisible();
  await tarjetas
    .filter({ hasText: 'Fixture Segunda Empleada Roble' })
    .getByRole('link', { name: 'Abrir su expediente' })
    .click();
  await page.waitForURL(new RegExp(`/employment\\?empleada=${AGREEMENT_SEGUNDA}$`));
  await expect(page.locator('.person-bar')).toContainText('Fixture Segunda Empleada Roble');

  // Cambiar de pestaña no cambia de persona: la elección viaja en la barra.
  await gotoTab(page, 'Conceptos');
  await page.waitForURL(new RegExp(`/employment/conceptos\\?empleada=${AGREEMENT_SEGUNDA}$`));

  // Su expediente, no el de Ana: su catálogo en el formulario y ninguna de las
  // jornadas de su compañera.
  const extrasCard = page.locator('article.card').filter({ hasText: 'Jornadas extra' });
  const registerForm = extrasCard.locator('form.register-extra-form');
  await expect(registerForm).toContainText('Apuntar una jornada a Fixture Segunda Empleada Roble');
  await expect(registerForm.getByLabel('Tipo').locator('option')).toHaveText([
    'Jornada completa · 60,00 € por jornada',
    'Media jornada · 30,00 € por jornada'
  ]);
  // Y el desplegable señala uno de los suyos: sin salir de la página, el
  // catálogo cambió bajo los pies del formulario y no puede quedarse apuntando
  // a un concepto del contrato anterior.
  await expect(registerForm.getByLabel('Tipo')).toHaveValue(TYPE_JORNADA_COMPLETA);
  await expect(extrasCard).not.toContainText('Se quedó el sábado E2E');
});
