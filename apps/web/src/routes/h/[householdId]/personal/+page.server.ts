import { loadStaffOverview } from '$lib/server/staff.server';
import type { PageServerLoad } from './$types';

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
  return { staff };
};

/*
 * Aquí vivía la action `hire`, y con ella el segundo formulario de alta de la
 * aplicación. Se va entera: el alta tiene ahora un solo sitio (`employment/alta`,
 * en dos etapas) y una acción de escritura sin ninguna pantalla que la use es un
 * camino abierto que nadie recuerda cerrar. Personal enseña el expediente del
 * personal y enlaza al alta; no la ejecuta.
 */
