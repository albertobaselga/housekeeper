import { error, fail } from '@sveltejs/kit';

import { getAuth } from '$lib/server/auth.server';
import { hireFromForm } from '$lib/server/staff-hire.server';
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

/**
 * El alta es una `form action`, no un comando de la cola offline. Dar acceso a
 * una persona es un acto deliberado que se hace contra el servidor o no se
 * hace: no puede quedarse esperando red y aplicarse media hora más tarde sobre
 * un hogar distinto. Es la misma decisión que tomaron el cambio de contraseña
 * y el pacto de condiciones. La lectura del formulario vive con
 * `hireHouseholdMember` (`hireFromForm`), compartida con la pestaña Contrato:
 * un campo nuevo se lee una vez o no se lee en ninguna parte.
 */
export const actions: Actions = {
  hire: async ({ locals, params, request }) => {
    if (!locals.user) error(401, 'Necesitas haber entrado');
    const result = await hireFromForm(
      { id: locals.user.id },
      params.householdId,
      await request.formData(),
      request.headers
    );
    if (!result.ok) return fail(400, { hireError: result.message, draft: result.draft });
    return { hired: result.hired };
  }
};
