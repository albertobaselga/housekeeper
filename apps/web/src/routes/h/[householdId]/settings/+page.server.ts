import { error, fail } from '@sveltejs/kit';

import { loadAccessOverview, resolveMembershipIdentity } from '$lib/server/access.server';
import { getAuth } from '$lib/server/auth.server';
import { MIN_PASSWORD_LENGTH } from '$lib/server/auth-core';
import { getSettingsFixture } from '$lib/server/fixtures.server';
import { canDownloadHandover } from '$lib/server/handover.server';
import type { Actions, PageServerLoad } from './$types';

/** Palabra de confirmación de la reposición, en la línea de «QUITAR». */
export const RESET_CONFIRM_WORD = 'REPONER';

const TOO_SHORT = `La contraseña nueva debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
const MISMATCH = 'Las dos contraseñas nuevas no coinciden.';

function readPasswordPair(formData: FormData): { value: string } | { message: string } {
  const next = String(formData.get('newPassword') ?? '');
  const repeat = String(formData.get('repeatPassword') ?? '');
  if (next.length < MIN_PASSWORD_LENGTH) return { message: TOO_SHORT };
  if (next !== repeat) return { message: MISMATCH };
  return { value: next };
}

export const load: PageServerLoad = async ({ locals, params, depends }) => {
  // Patrón wiki (latencia): `invalidate('cc:settings')` re-ejecuta solo este load.
  depends('cc:settings');
  // Ambas secciones reales (accesos y traspaso) solo existen para el
  // family_admin con base de datos; en cualquier otro caso son null/false y la
  // página conserva únicamente la maqueta de demostración.
  const access = locals.user
    ? await loadAccessOverview({ id: locals.user.id }, params.householdId)
    : null;
  const canHandover = locals.user
    ? await canDownloadHandover({ id: locals.user.id }, params.householdId)
    : false;
  return {
    settings: getSettingsFixture(),
    access,
    handover: canHandover ? { householdId: params.householdId } : null,
    // Sin instalación real de identidad no hay contraseñas que cambiar: la demo
    // por fixtures no muestra ninguna de las dos tarjetas.
    passwordAuth: Boolean(getAuth()),
    minPasswordLength: MIN_PASSWORD_LENGTH,
    resetConfirmWord: RESET_CONFIRM_WORD
  };
};

export const actions: Actions = {
  /** Cambiar la contraseña propia. Cierra el resto de sesiones abiertas. */
  changePassword: async ({ locals, request }) => {
    const auth = getAuth();
    if (!auth) error(404, 'Este entorno no gestiona contraseñas');
    if (!locals.user) error(401, 'Necesitas haber entrado');
    const formData = await request.formData();
    const currentPassword = String(formData.get('currentPassword') ?? '');
    const candidate = readPasswordPair(formData);
    if ('message' in candidate) return fail(400, { passwordError: candidate.message });

    try {
      await auth.api.changePassword({
        body: {
          currentPassword,
          newPassword: candidate.value,
          // Cambiar la contraseña cierra la sesión en los demás dispositivos:
          // si alguien la conocía, deja de entrar en el momento.
          revokeOtherSessions: true
        },
        headers: request.headers
      });
    } catch {
      return fail(400, {
        passwordError: 'No hemos podido cambiarla. Comprueba que la contraseña actual es la correcta.'
      });
    }
    return { passwordChanged: true };
  },

  /**
   * Reponer la contraseña de otra persona del hogar. La autorización de verdad
   * la da la membresía `family_admin` bajo RLS (resolveMembershipIdentity); la
   * llamada al plugin admin de Better Auth es la segunda reja.
   */
  resetMemberPassword: async ({ locals, params, request }) => {
    const auth = getAuth();
    if (!auth) error(404, 'Este entorno no gestiona contraseñas');
    if (!locals.user) error(401, 'Necesitas haber entrado');
    const formData = await request.formData();
    const membershipId = String(formData.get('membershipId') ?? '');
    const confirmation = String(formData.get('confirm') ?? '')
      .trim()
      .toLocaleUpperCase('es');
    if (confirmation !== RESET_CONFIRM_WORD) {
      return fail(400, { resetError: `Escribe ${RESET_CONFIRM_WORD} para confirmar.`, resetMembershipId: membershipId });
    }
    const candidate = readPasswordPair(formData);
    if ('message' in candidate) {
      return fail(400, { resetError: candidate.message, resetMembershipId: membershipId });
    }

    const target = await resolveMembershipIdentity({ id: locals.user.id }, params.householdId, membershipId);
    if (!target) {
      return fail(403, {
        resetError: 'No puedes cambiar ese acceso.',
        resetMembershipId: membershipId
      });
    }

    try {
      await auth.api.setUserPassword({
        body: { userId: target.userId, newPassword: candidate.value },
        headers: request.headers
      });
      // Reponer una contraseña deja fuera todas las sesiones anteriores de esa
      // persona: si alguien había entrado con la vieja, deja de estar dentro.
      await auth.api.revokeUserSessions({ body: { userId: target.userId }, headers: request.headers });
    } catch {
      return fail(400, {
        resetError:
          'No hemos podido reponerla. Tu cuenta necesita ser administradora también en el sistema de acceso; revisa docs/despliegue/acceso-produccion.md.',
        resetMembershipId: membershipId
      });
    }
    return { resetDone: target.name };
  }
};
