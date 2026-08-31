import {
  employmentHrefBases,
  loadEmploymentOverview,
  loadEmploymentPortada
} from '$lib/server/employment.server';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { getEmploymentFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url, depends }) => {
  // Patrón wiki (latencia): `invalidate('cc:employment')` re-ejecuta solo este load.
  depends('cc:employment');
  // De quién es el expediente que se está mirando. Va en la URL para que se
  // pueda compartir y volver atrás, y para que este load se repita al cambiar
  // de persona sin recargar la página entera. No es una reja: la lista de
  // acuerdos la filtra la RLS y pedir el de otra cae en el propio.
  const selectedAgreementId = url.searchParams.get('empleada');
  const overview = locals.user
    ? await loadEmploymentOverview(
        { id: locals.user.id },
        params.householdId,
        undefined,
        undefined,
        selectedAgreementId,
        employmentHrefBases(locals.user, params.householdId, selectedAgreementId)
      )
    : null;
  // Primero la persona, luego su expediente: con varias empleadas y sin
  // elección en la URL, la entrada es la portada del hogar (cuánto cuesta la
  // casa este mes y cómo va cada una). Con una sola —o para la empleada, a
  // quien la RLS solo le enseña la suya— se aterriza directo en el Resumen.
  if (overview && !selectedAgreementId && overview.agreements.length > 1 && locals.user) {
    const portada = await loadEmploymentPortada({ id: locals.user.id }, params.householdId);
    if (portada) return { portada, overview: null, employment: null };
  }
  if (overview) return { portada: null, overview, employment: null };
  // Con base de datos configurada aquí no hay maqueta que servir: 503 honesto
  // y registrado (data-source.server.ts). Sin base, la demostración sigue.
  return demoOrUnavailable(() => ({ portada: null, overview: null, employment: getEmploymentFixture() }));
};
