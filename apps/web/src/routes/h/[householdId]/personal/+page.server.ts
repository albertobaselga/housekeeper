import { error, fail } from '@sveltejs/kit';

import { agreementTermsInputSchema } from '@casa-clara/contracts/schemas';

import { parseEuroInput } from '$lib/employment/commands';
import { getAuth } from '$lib/server/auth.server';
import { hireHouseholdMember, type HireInput, type HireableRole } from '$lib/server/staff-hire.server';
import { loadStaffOverview } from '$lib/server/staff.server';
import type { Actions, PageServerLoad } from './$types';

/**
 * Personal de la casa. La ruta ya exige `access.manage` (routing.ts), así que
 * aquí solo llega quien administra; `loadStaffOverview` vuelve a comprobarlo
 * contra la membresía real bajo RLS, que es la comprobación que cuenta.
 *
 * `staff === null` significa las dos cosas a la vez —sin base de datos o sin
 * ser quien administra— y la página dice esa verdad sin distinguirlas. No hay
 * fixture de reserva: una lista de personal inventada en una pantalla que
 * decide sobre contratos sería peor que una pantalla vacía.
 */
export const load: PageServerLoad = async ({ locals, params, depends }) => {
  depends('cc:staff');
  const staff = locals.user
    ? await loadStaffOverview({ id: locals.user.id }, params.householdId)
    : null;
  return {
    staff,
    // Sin identidad real no hay cuentas que crear: la página enseña el
    // personal y calla el formulario, en vez de ofrecer un alta imposible.
    canHire: Boolean(getAuth())
  };
};

function text(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

/**
 * El alta es una `form action`, no un comando de la cola offline. Dar acceso a
 * una persona es un acto deliberado que se hace contra el servidor o no se
 * hace: no puede quedarse esperando red y aplicarse media hora más tarde sobre
 * un hogar distinto. Es la misma decisión que tomaron el cambio de contraseña
 * y el pacto de condiciones.
 */
export const actions: Actions = {
  hire: async ({ locals, params, request }) => {
    if (!locals.user) error(401, 'Necesitas haber entrado');
    const form = await request.formData();

    const draft = {
      displayName: text(form, 'displayName'),
      username: text(form, 'username').toLowerCase(),
      email: text(form, 'email').toLowerCase(),
      role: text(form, 'role')
    };

    let agreement: HireInput['agreement'] = null;
    if (form.get('withAgreement') === 'on') {
      const salary = parseEuroInput(text(form, 'monthlySalary'));
      if (salary === null) {
        return fail(400, { hireError: 'El salario mensual no es un importe válido.', draft });
      }
      const startsOn = text(form, 'startsOn');
      const parsed = agreementTermsInputSchema.safeParse({
        // La primera versión entra en vigor el día que empieza el contrato: en
        // un alta no hay historia previa que respetar, y pedir dos fechas para
        // decir lo mismo solo invita a teclear una mal.
        effectiveFrom: startsOn,
        monthlySalaryCents: salary,
        contractedWeeklyMinutes: Number.parseInt(text(form, 'contractedWeeklyMinutes'), 10),
        annualVacationDays: Number.parseInt(text(form, 'annualVacationDays'), 10),
        reason: text(form, 'reason') || 'Alta desde la aplicación',
        // El catálogo de trabajo extra y los complementos se pactan después,
        // en El acuerdo, apilando una versión. Aquí se registra lo básico.
        extraWorkTypes: [],
        supplements: []
      });
      if (!parsed.success) {
        return fail(400, {
          hireError: parsed.error.issues[0]?.message ?? 'Revisa las condiciones del contrato.',
          draft
        });
      }
      agreement = { startsOn, terms: parsed.data as never };
    }

    const result = await hireHouseholdMember(
      { id: locals.user.id },
      params.householdId,
      { ...draft, role: draft.role as HireableRole, agreement },
      request.headers
    );
    if (!result.ok) return fail(400, { hireError: result.message, draft });

    // La contraseña viaja UNA vez, a la pantalla de quien acaba de darla de
    // alta, para leerla en voz alta. No se guarda en ninguna parte y no vuelve
    // a poder verse: si se pierde, se repone desde Ajustes.
    return {
      hired: {
        name: result.name,
        username: result.username,
        password: result.password,
        withAgreement: result.agreementId !== null
      }
    };
  }
};
