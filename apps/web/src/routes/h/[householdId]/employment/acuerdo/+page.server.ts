import { error, fail } from '@sveltejs/kit';

import type {
  AgreementTermsInputV1,
  ExtraWorkTypeInputV1,
  RecurringSupplementInputV1
} from '@casa-clara/contracts';
import { agreementCreateInputSchema, agreementTermsInputSchema } from '@casa-clara/contracts/schemas';

import { parseEuroInput } from '$lib/employment/commands';
import { PAYER_CHOICES } from '$lib/employment/payer';
import {
  createAgreement,
  loadAgreementAdmin,
  stackAgreementVersion
} from '$lib/server/agreement-terms.server';
import type { Actions, PageServerLoad } from './$types';

/**
 * Administración del acuerdo: alta y edición de las condiciones.
 *
 * Form actions, no cola offline. Pactar condiciones laborales es un acto
 * deliberado que se hace contra el servidor o no se hace, igual que el cambio
 * de contraseña de Ajustes. Además mantiene esta pantalla fuera del grafo de
 * JavaScript inicial: es una ruta propia, con su propio trozo, que Hoy no
 * importa nunca.
 */
export const load: PageServerLoad = async ({ locals, params, depends }) => {
  depends('cc:agreement-terms');
  const admin = locals.user
    ? await loadAgreementAdmin({ id: locals.user.id }, params.householdId)
    : null;
  // `admin === null` significa las dos cosas a la vez —sin base de datos o sin
  // ser quien administra— y la página dice esa verdad sin distinguirlas.
  return { admin };
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

function readTerms(form: FormData): AgreementTermsInputV1 | { message: string } {
  const salary = parseEuroInput(text(form, 'monthlySalary'));
  if (salary === null) return { message: 'El salario mensual no es un importe válido.' };
  const types = readExtraWorkTypes(form);
  if ('message' in types) return types;
  const supplements = readSupplements(form);
  if ('message' in supplements) return supplements;

  const candidate = {
    effectiveFrom: text(form, 'effectiveFrom'),
    monthlySalaryCents: salary,
    contractedWeeklyMinutes: integer(form, 'contractedWeeklyMinutes'),
    annualVacationDays: integer(form, 'annualVacationDays'),
    reason: text(form, 'reason'),
    extraWorkTypes: types,
    supplements
  };
  const parsed = agreementTermsInputSchema.safeParse(candidate);
  if (!parsed.success) {
    return { message: parsed.error.issues[0]?.message ?? 'Revisa las condiciones.' };
  }
  return parsed.data as AgreementTermsInputV1;
}

export const actions: Actions = {
  /** Alta del acuerdo con su primera versión. */
  create: async ({ locals, params, request }) => {
    if (!locals.user) error(401, 'Necesitas haber entrado');
    const form = await request.formData();
    const terms = readTerms(form);
    if ('message' in terms) return fail(400, { createError: terms.message });

    const parsed = agreementCreateInputSchema.safeParse({
      employeeMembershipId: text(form, 'employeeMembershipId'),
      startsOn: text(form, 'startsOn'),
      terms
    });
    if (!parsed.success) {
      return fail(400, { createError: parsed.error.issues[0]?.message ?? 'Revisa los datos del alta.' });
    }

    const result = await createAgreement(
      { id: locals.user.id },
      params.householdId,
      parsed.data as never
    );
    if (!result.ok) return fail(400, { createError: result.message });
    return { created: true };
  },

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
