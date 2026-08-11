import { error, fail } from '@sveltejs/kit';

import { clearPasswordChangeRequirement } from '$lib/server/access.server';
import { MIN_PASSWORD_LENGTH } from '$lib/server/auth-core';
import { getAuth } from '$lib/server/auth.server';
import { listOwnDevices, pushPublicKey } from '$lib/server/push.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends, locals }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  // Encender o apagar los avisos recarga solo esta lectura.
  depends('cc:push');
  return {
    // Sin instalación real de identidad no hay contraseña que cambiar: la
    // página lo dice en lugar de ofrecer un formulario que no puede cumplir.
    passwordAuth: Boolean(getAuth()),
    minPasswordLength: MIN_PASSWORD_LENGTH,
    // Entró con la provisional que le dieron en mano: hasta cambiarla, el hook
    // del servidor la devuelve aquí desde cualquier otra pantalla del hogar, y
    // la página tiene que explicar por qué en vez de dejarla dando vueltas.
    mustChangePassword: locals.user.mustChangePassword,
    // Sin claves VAPID no hay canal en esta instalación, y la sección lo dice en
    // vez de dibujar un interruptor que no puede funcionar.
    pushPublicKey: pushPublicKey(),
    // SOLO los suyos, y no porque esta consulta filtre: la RLS de la 0032 no
    // deja ver otra cosa. Quien administra el hogar no puede saber desde ninguna
    // pantalla si otra persona tiene los avisos encendidos.
    pushDevices: await listOwnDevices({ id: locals.user.id })
  };
};

export const actions: Actions = {
  /** Cambiar la contraseña propia. Cierra el resto de sesiones abiertas. */
  changePassword: async ({ locals, params, request }) => {
    const auth = getAuth();
    if (!auth) error(404, 'Este entorno no gestiona contraseñas');
    if (!locals.user) error(401, 'Necesitas haber entrado');
    const formData = await request.formData();
    const currentPassword = String(formData.get('currentPassword') ?? '');
    const newPassword = String(formData.get('newPassword') ?? '');
    const repeatPassword = String(formData.get('repeatPassword') ?? '');

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return fail(400, { message: `La contraseña nueva debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.` });
    }
    if (newPassword !== repeatPassword) {
      return fail(400, { message: 'Las dos contraseñas nuevas no coinciden.' });
    }

    try {
      await auth.api.changePassword({
        body: {
          currentPassword,
          newPassword,
          // Cambiar la contraseña cierra la sesión en los demás dispositivos:
          // si alguien la conocía, deja de entrar en el momento.
          revokeOtherSessions: true
        },
        headers: request.headers
      });
    } catch {
      return fail(400, {
        message: 'No hemos podido cambiarla. Comprueba que la contraseña de ahora es la correcta.'
      });
    }
    // Solo aquí, y solo después de que Better Auth la haya aceptado de verdad:
    // este es el único punto del código que da por cumplida la obligación.
    if (locals.user.mustChangePassword) {
      await clearPasswordChangeRequirement({ id: locals.user.id }, params.householdId);
    }
    return { changed: true };
  }
};
