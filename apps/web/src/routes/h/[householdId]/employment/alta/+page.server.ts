import { error, fail, redirect } from '@sveltejs/kit';

import { agreementCreateInputSchema } from '@housekeeper/contracts/schemas';

import { employmentTabHref } from '$lib/employment/model';
import {
  createAgreement,
  explainTermsIssue,
  loadHireContext
} from '$lib/server/agreement-terms.server';
import { getAuth } from '$lib/server/auth.server';
import {
  hireFromForm,
  readHireAgreementTerms,
  validateHireInput,
  type HireableRole
} from '$lib/server/staff-hire.server';
import type { Actions, PageServerLoad } from './$types';

/**
 * Añadir una persona a la casa, EN DOS ETAPAS: primero quién es y cómo entra,
 * después sus condiciones.
 *
 * Por qué una ruta y no una tarjeta más: dar de alta a alguien es una operación
 * de la casa, no una operación dentro del expediente de otra persona, que es
 * donde vivía y por lo que no se entendía. Ruta propia además significa trozo
 * de JavaScript propio, que el arranque de Hoy no ve nunca.
 *
 * Por qué la ETAPA 1 NO ESCRIBE NADA. La action `?/persona` sólo valida y
 * devuelve; sin JavaScript, SvelteKit sirve la respuesta del POST
 * re-renderizando la página con `form` puesto, y eso ES la etapa 2. No hace
 * falta `enhance`, ni estado de cliente, ni un byte más en el arranque.
 *
 * Por qué el estado viaja en el cuerpo y no en la URL: el nombre, el usuario y
 * el correo son datos de una persona; en la query acabarían en el historial del
 * navegador y en los registros del servidor, y esta casa es explícita en que el
 * correo «sólo identifica la cuenta».
 *
 * Por qué la escritura sigue siendo un solo acto al final: si la etapa 1
 * escribiera la identidad, la contraseña provisional tendría que viajar en una
 * redirección, y se rompería la compensación que documenta `staff-hire.server`
 * (identidad → transacción de la app → borrado de la identidad si falla).
 *
 * Con `?persona=<membershipId>` se entra DIRECTAMENTE a la etapa 2: esa persona
 * ya está en la casa y lo único que falta es pactar su contrato. Ahí no hay
 * identidad que crear ni contraseña que entregar, así que al terminar se
 * redirige a su expediente.
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
  const pedida = url.searchParams.get('persona');
  const contexto = locals.user
    ? await loadHireContext({ id: locals.user.id }, params.householdId)
    : null;
  const persona = pedida
    ? (contexto?.candidates.find((candidate) => candidate.membershipId === pedida) ?? null)
    : null;
  return {
    householdId: params.householdId,
    // Para las fechas por omisión. Vacío sin base de datos: los campos salen en
    // blanco en vez de proponer una fecha inventada.
    today: contexto?.today ?? '',
    persona,
    /** Se pidió una persona concreta y no está entre las que faltan por pactar. */
    personaNoEncontrada: pedida !== null && persona === null,
    // Sin identidad real no hay cuentas que crear: la pantalla lo dice en vez de
    // ofrecer un alta imposible (mismo criterio que Personal).
    canHire: Boolean(getAuth())
  };
};

function text(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

export const actions: Actions = {
  /**
   * Etapa 1 → etapa 2. NO escribe: valida la parte de la persona con las mismas
   * reglas que el alta de verdad y devuelve lo tecleado para que la etapa 2 lo
   * lleve en campos ocultos. Que la validación sea la misma función es lo que
   * evita que la etapa 1 dé por bueno algo que la 2 rechazará al final.
   */
  persona: async ({ locals, request }) => {
    if (!locals.user) error(401, 'Necesitas haber entrado');
    const form = await request.formData();
    const draft = {
      displayName: text(form, 'displayName'),
      username: text(form, 'username').toLowerCase(),
      email: text(form, 'email').toLowerCase(),
      role: text(form, 'role')
    };
    const invalid = validateHireInput({
      ...draft,
      role: draft.role as HireableRole,
      agreement: null
    });
    if (invalid) return fail(400, { hireError: invalid, draft });
    return { paso: 'contrato' as const, persona: draft };
  },

  /**
   * Etapa 2 de una persona nueva: identidad, acceso y —si se pactan aquí—
   * contrato, todo en el mismo acto. `hireFromForm` lee exactamente los mismos
   * nombres de campo que antes, así que los ocultos de la etapa 1 le valen tal
   * cual.
   */
  hire: async ({ locals, params, request }) => {
    if (!locals.user) error(401, 'Necesitas haber entrado');
    const result = await hireFromForm(
      { id: locals.user.id },
      params.householdId,
      await request.formData(),
      request.headers
    );
    if (!result.ok) {
      /*
       * `persona` es lo que mantiene la pantalla EN LA ETAPA 2. Sin ella, un
       * fallo aquí devolvía a la etapa 1 y borraba el contrato recién tecleado:
       * fecha de inicio, salario, jornada, vacaciones, motivo, tarifa y
       * caducidad. Y el fallo más probable es justo el que la etapa 1 no puede
       * detectar porque no toca la base de identidad —«ya hay una cuenta con ese
       * correo», «ese usuario está cogido»—, así que la pérdida caía sobre quien
       * no había hecho nada mal. De propina, un salario mal tecleado pintaba «El
       * salario mensual no es un importe válido» sobre un formulario que no
       * tiene campo de salario.
       */
      return fail(400, {
        hireError: result.message,
        draft: result.draft,
        persona: result.draft
      });
    }
    // Sin redirección a propósito: la contraseña provisional se enseña UNA vez
    // y hay que leerla en voz alta. La entrada al expediente recién creado es el
    // botón principal de esa misma respuesta.
    return { hired: result.hired };
  },

  /**
   * Etapa 2 de alguien que YA está en la casa: sólo el contrato. Aquí no hay
   * contraseña que entregar, así que al terminar se entra directamente en el
   * expediente recién creado, que es lo que se ha venido a hacer.
   */
  contrato: async ({ locals, params, request }) => {
    if (!locals.user) error(401, 'Necesitas haber entrado');
    const form = await request.formData();
    const employeeMembershipId = text(form, 'employeeMembershipId');
    const startsOn = text(form, 'startsOn');

    /*
     * El identificador llega en un campo OCULTO, así que no vale fiarse de él:
     * se contrasta contra la misma lista de candidatas que valida el `load`.
     * `readEmployeeCandidates` sólo devuelve empleadas internas no revocadas y
     * sin contrato activo, de modo que esto cierra de una vez tres cosas: un
     * apoyo del hogar o un visor colados a mano, alguien de otro hogar, y una
     * segunda pulsación que crearía un contrato duplicado. `createAgreement`
     * vuelve a comprobar el papel por su cuenta bajo RLS: esto es la puerta,
     * aquélla es la cerradura.
     */
    const contexto = await loadHireContext({ id: locals.user.id }, params.householdId);
    const candidata = contexto?.candidates.find(
      (candidate) => candidate.membershipId === employeeMembershipId
    );
    if (!candidata) {
      return fail(400, {
        createError:
          'Esa persona no está entre las que tienen acceso y les falta contrato. Vuelve a la lista de personas y elígela de nuevo.',
        employeeMembershipId
      });
    }

    const terms = readHireAgreementTerms(form, startsOn);
    if (!terms.ok) return fail(400, { createError: terms.message, employeeMembershipId });

    const parsed = agreementCreateInputSchema.safeParse({
      employeeMembershipId,
      startsOn,
      terms: terms.terms
    });
    if (!parsed.success) {
      return fail(400, {
        createError: explainTermsIssue(parsed.error.issues[0]),
        employeeMembershipId
      });
    }

    const result = await createAgreement(
      { id: locals.user.id },
      params.householdId,
      parsed.data as never
    );
    if (!result.ok) return fail(400, { createError: result.message, employeeMembershipId });
    redirect(303, employmentTabHref(params.householdId, 'resumen', result.agreementId));
  }
};
