import { error, fail } from '@sveltejs/kit';

import type {
  AgreementScheduleInputV1,
  AgreementTermsInputV1,
  ExtraWorkTypeInputV1,
  RecurringSupplementInputV1,
  ScheduleDayInputV1,
  WeekdayV1
} from '@casa-clara/contracts';
import { agreementTermsInputSchema } from '@casa-clara/contracts/schemas';

import { parseEuroInput } from '$lib/employment/commands';
import { PAYER_CHOICES } from '$lib/employment/payer';
import {
  explainTermsIssue,
  loadAgreementAdmin,
  stackAgreementVersion
} from '$lib/server/agreement-terms.server';
import type { Actions, PageServerLoad } from './$types';

/**
 * Las condiciones de UNA persona: lo que rige hoy, cómo se cambia y el
 * historial. Nada más.
 *
 * Antes esta pestaña enseñaba los contratos de TODO el hogar dentro del
 * expediente de una, más el alta de contrato de una tercera, más el alta de una
 * persona que aún no existía. El parámetro `empleada` viajaba pero no mandaba, y
 * por eso no se entendía de quién era lo que se estaba mirando. Ahora manda:
 * elegir no es una reja —la RLS ya filtra y pedir el acuerdo de otra cae en el
 * primero visible—, es decir de quién es la pantalla.
 *
 * El alta de personas se fue a `employment/alta`, en dos etapas y desde la
 * portada del hogar: dar de alta a alguien no es una operación dentro del
 * expediente de otra persona.
 *
 * Form actions, no cola offline. Pactar condiciones laborales es un acto
 * deliberado que se hace contra el servidor o no se hace, igual que el cambio
 * de contraseña de Ajustes. Además mantiene esta pantalla fuera del grafo de
 * JavaScript inicial: es una ruta propia, con su propio trozo, que Hoy no
 * importa nunca.
 */
export const load: PageServerLoad = async ({ locals, params, url, depends }) => {
  depends('cc:agreement-terms');
  const admin = locals.user
    ? await loadAgreementAdmin({ id: locals.user.id }, params.householdId)
    : null;
  const empleada = url.searchParams.get('empleada');
  const agreement =
    admin?.agreements.find((candidate) => candidate.id === empleada) ??
    admin?.agreements[0] ??
    null;
  // `admin === null` significa las dos cosas a la vez —sin base de datos o sin
  // ser quien administra— y la página dice esa verdad sin distinguirlas.
  return {
    agreement,
    today: admin?.today ?? '',
    hayAdministracion: admin !== null,
    householdId: params.householdId,
    empleada
  };
};

/** Un campo de texto del formulario, sin espacios de cortesía. */
function text(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

function optionalDate(form: FormData, name: string): string | null {
  const value = text(form, name);
  return value === '' ? null : value;
}

/**
 * Importe en euros escrito por una persona («1.521,75») a céntimos. Devuelve
 * null para el campo vacío, que es un dato legítimo: un concepto puede quedar
 * pactado sin tarifa, y entonces la empleada no lo ve.
 */
function optionalCents(form: FormData, name: string): string | null | undefined {
  const raw = text(form, name);
  if (raw === '') return null;
  return parseEuroInput(raw) ?? undefined;
}

function integer(form: FormData, name: string): number {
  return Number.parseInt(text(form, name), 10);
}

/**
 * Las filas del catálogo llegan como campos indexados (`type.0.code`,
 * `type.0.name`, …) para que el formulario funcione sin JavaScript: es una
 * pantalla de administración, y tiene que poder usarse con el navegador que
 * haya delante.
 */
function readExtraWorkTypes(form: FormData): ExtraWorkTypeInputV1[] | { message: string } {
  const types: ExtraWorkTypeInputV1[] = [];
  for (let index = 0; form.has(`type.${index}.code`); index += 1) {
    const code = text(form, `type.${index}.code`);
    if (code === '') continue;
    const rateCents = optionalCents(form, `type.${index}.rate`);
    if (rateCents === undefined) {
      return { message: `La tarifa de «${text(form, `type.${index}.name`) || code}» no es un importe válido.` };
    }
    const referenceRaw = text(form, `type.${index}.referenceMinutes`);
    types.push({
      code,
      name: text(form, `type.${index}.name`),
      unit: text(form, `type.${index}.unit`) as ExtraWorkTypeInputV1['unit'],
      rateCents,
      referenceMinutes: referenceRaw === '' ? null : Number.parseInt(referenceRaw, 10),
      active: form.get(`type.${index}.active`) === 'on'
    });
  }
  return types;
}

function readSupplements(form: FormData): RecurringSupplementInputV1[] | { message: string } {
  const supplements: RecurringSupplementInputV1[] = [];
  for (let index = 0; form.has(`supplement.${index}.code`); index += 1) {
    const code = text(form, `supplement.${index}.code`);
    if (code === '') continue;
    const amountCents = optionalCents(form, `supplement.${index}.amount`);
    if (amountCents === undefined) {
      return {
        message: `El importe de «${text(form, `supplement.${index}.name`) || code}» no es válido.`
      };
    }
    // Sin valor por defecto a propósito: quien pacta un complemento tiene que
    // decir explícitamente si es dinero para ella o gasto de la casa. Un
    // defecto silencioso aquí es una transferencia inflada o mermada, y como la
    // fila es inmutable el error solo se corrige apilando otra versión. Por eso
    // cualquier valor que no sea uno de los dos es un ERROR y no un `false`: si
    // el formulario y este lector vuelven a dejar de entenderse, se verá.
    const payer = text(form, `supplement.${index}.addsToPay`);
    if (payer !== PAYER_CHOICES.addsToPay && payer !== PAYER_CHOICES.paidByHousehold) {
      return {
        message: `Di quién cobra «${text(form, `supplement.${index}.name`) || code}»: si suma a su transferencia o lo paga la casa aparte.`
      };
    }
    supplements.push({
      code,
      name: text(form, `supplement.${index}.name`),
      amountCents,
      periodicity: 'monthly',
      addsToPay: payer === PAYER_CHOICES.addsToPay,
      startsOn: optionalDate(form, `supplement.${index}.startsOn`),
      endsOn: optionalDate(form, `supplement.${index}.endsOn`),
      active: form.get(`supplement.${index}.active`) === 'on'
    });
  }
  return supplements;
}

/**
 * El horario del formulario.
 *
 * La casilla `schedule.declared` es la que decide si este contrato declara
 * horario o no. Sin marcar, se devuelve `null` y no se escribe ninguna fila:
 * ese null es el «si aplica» del encargo, y por eso es una decisión explícita
 * de quien administra y no el efecto colateral de dejar dos campos vacíos.
 *
 * Los siete días llegan siempre en el formulario —es la única forma de que un
 * `<select>` por día funcione sin JavaScript— y aquí se DESCARTAN los que
 * trabajan la jornada tipo sin cambiar nada. Lo que se guarda es solo lo que se
 * desvía, que es lo que dice la tabla.
 */
function readSchedule(form: FormData): AgreementScheduleInputV1 | null | { message: string } {
  if (form.get('schedule.declared') !== 'on') return null;

  const startsAt = text(form, 'schedule.startsAt');
  const endsAt = text(form, 'schedule.endsAt');
  if (startsAt === '' || endsAt === '') {
    return { message: 'El horario necesita hora de entrada y hora de salida, o desmarca la casilla.' };
  }
  const breakRaw = text(form, 'schedule.longBreakMinutes');
  const longBreakMinutes = breakRaw === '' ? 0 : Number.parseInt(breakRaw, 10);
  if (!Number.isInteger(longBreakMinutes)) {
    return { message: 'Los minutos de descanso tienen que ser un número entero.' };
  }

  const days: ScheduleDayInputV1[] = [];
  for (let weekday = 1 as WeekdayV1; weekday <= 7; weekday = (weekday + 1) as WeekdayV1) {
    const mode = text(form, `schedule.day.${weekday}.mode`);
    const note = text(form, `schedule.day.${weekday}.note`);
    if (mode === 'libra') {
      days.push({ weekday, works: false, startsAt: null, endsAt: null, longBreakMinutes: null, note });
      continue;
    }
    const dayEnds = text(form, `schedule.day.${weekday}.endsAt`);
    const dayStarts = text(form, `schedule.day.${weekday}.startsAt`);
    const dayBreakRaw = text(form, `schedule.day.${weekday}.longBreakMinutes`);
    const dayBreak = dayBreakRaw === '' ? null : Number.parseInt(dayBreakRaw, 10);
    if (dayBreak !== null && !Number.isInteger(dayBreak)) {
      return { message: 'Los minutos de descanso de un día tienen que ser un número entero.' };
    }
    // Un día que no cambia nada y no explica nada no se guarda: la tabla lo
    // rechazaría, y con razón (sería una fila que repite la jornada tipo).
    const changes =
      (dayStarts !== '' && dayStarts !== startsAt) ||
      (dayEnds !== '' && dayEnds !== endsAt) ||
      (dayBreak !== null && dayBreak !== longBreakMinutes);
    if (!changes && note === '') continue;
    days.push({
      weekday,
      works: true,
      startsAt: dayStarts === '' || dayStarts === startsAt ? null : dayStarts,
      endsAt: dayEnds === '' || dayEnds === endsAt ? null : dayEnds,
      longBreakMinutes: dayBreak === null || dayBreak === longBreakMinutes ? null : dayBreak,
      note
    });
  }

  return { startsAt, endsAt, longBreakMinutes, note: text(form, 'schedule.note'), days };
}

function readTerms(form: FormData): AgreementTermsInputV1 | { message: string } {
  const salary = parseEuroInput(text(form, 'monthlySalary'));
  if (salary === null) return { message: 'El salario mensual no es un importe válido.' };
  const types = readExtraWorkTypes(form);
  if ('message' in types) return types;
  const supplements = readSupplements(form);
  if ('message' in supplements) return supplements;
  const schedule = readSchedule(form);
  if (schedule !== null && 'message' in schedule) return schedule;

  // Las dos condiciones de vacaciones que estrenó la 0034. Aquí SIEMPRE se
  // preguntan, porque cambiar las condiciones es el acto en el que se sabe todo;
  // en el alta son opcionales. La tarifa vacía se guarda como null —«no se
  // pactó»— y nunca como cero: la fila es inmutable y ese cero diría para
  // siempre que se acordó pagar cero euros por día.
  const unusedVacationDayRateCents = optionalCents(form, 'unusedVacationDayRate');
  if (unusedVacationDayRateCents === undefined) {
    return { message: 'El precio del día de vacaciones no disfrutado no es un importe válido.' };
  }
  const expiryMode = text(form, 'carryoverExpiryMode');
  const vacationCarryoverExpiry =
    expiryMode === 'never'
      ? { mode: 'never' }
      : expiryMode === 'months'
        ? { mode: 'months', months: integer(form, 'carryoverExpiryMonths') }
        : undefined;

  const candidate = {
    effectiveFrom: text(form, 'effectiveFrom'),
    monthlySalaryCents: salary,
    contractedWeeklyMinutes: integer(form, 'contractedWeeklyMinutes'),
    annualVacationDays: integer(form, 'annualVacationDays'),
    unusedVacationDayRateCents,
    vacationCarryoverExpiry,
    reason: text(form, 'reason'),
    extraWorkTypes: types,
    supplements,
    schedule
  };
  const parsed = agreementTermsInputSchema.safeParse(candidate);
  if (!parsed.success) {
    // En castellano y diciendo qué campo: ver `explainTermsIssue`.
    return { message: explainTermsIssue(parsed.error.issues[0]) };
  }
  return parsed.data as AgreementTermsInputV1;
}

export const actions: Actions = {
  /**
   * Nueva versión sobre un acuerdo existente. Nunca edita la vigente: el
   * nombre de la acción es literal, se apila.
   */
  stackVersion: async ({ locals, params, request }) => {
    if (!locals.user) error(401, 'Necesitas haber entrado');
    const form = await request.formData();
    const agreementId = text(form, 'agreementId');
    const terms = readTerms(form);
    if ('message' in terms) return fail(400, { stackError: terms.message, agreementId });

    const result = await stackAgreementVersion(
      { id: locals.user.id },
      params.householdId,
      agreementId,
      terms
    );
    if (!result.ok) return fail(400, { stackError: result.message, agreementId });
    return { stacked: true, agreementId };
  }
};
