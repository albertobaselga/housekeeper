import { dev } from '$app/environment';
import { error, fail, redirect } from '@sveltejs/kit';
import { ROLE_LABELS } from '$lib/auth/role-labels';
import { getAuth } from '$lib/server/auth.server';
import { getDemoUser, listDemoUsers } from '$lib/server/fixtures.server';
import { createDemoSession } from '$lib/server/session.server';
import { isLocalHostname } from '$lib/server/synthetic.server';
import type { Actions, PageServerLoad } from './$types';

/**
 * Dos modos, y solo dos:
 *
 * - `password`: hay instalación real (DATABASE_AUTH_URL + BETTER_AUTH_SECRET).
 *   Se entra con nombre de usuario y contraseña. Es el modo de producción.
 * - `fixture-selector`: el paquete se construyó con `__FIXTURE_LOGIN__` y no hay
 *   base de datos de identidad. Solo entonces vive el selector de cuentas
 *   sintéticas que sostiene la demo local y la batería e2e.
 *
 * `__FIXTURE_LOGIN__` es constante de compilación: cuando vale `false` todo lo
 * que hay debajo de ella desaparece del paquete, incluida la acción `demo`, que
 * deja de existir como acción (SvelteKit responde 404 a `?/demo` porque no hay
 * nada que ejecutar, no porque una comprobación lo decida).
 */
export type LoginMode = 'fixture-selector' | 'password';

/**
 * Mensaje ÚNICO para cualquier fallo de entrada. Usuario inexistente,
 * contraseña incorrecta o cuenta sin membresía dan exactamente la misma
 * respuesta: nadie puede averiguar desde fuera qué cuentas existen.
 */
const SIGN_IN_FAILED = 'No hemos podido entrar con esos datos. Revisa el usuario y la contraseña.';
const TOO_MANY_ATTEMPTS = 'Demasiados intentos seguidos. Espera un minuto y vuelve a probar.';

function isSafeNext(value: string | null): value is string {
  return Boolean(value && value.startsWith('/') && !value.startsWith('//'));
}

function resolveMode(): LoginMode {
  // El `return` incondicional deja muerto todo lo que sigue cuando la constante
  // es falsa: no queda ni la llamada a getAuth() ni el otro modo.
  if (!__FIXTURE_LOGIN__) return 'password';
  return getAuth() ? 'password' : 'fixture-selector';
}

export const load: PageServerLoad = ({ locals, url }) => {
  if (locals.user) redirect(303, `/h/${encodeURIComponent(locals.user.householdIds[0])}/today`);
  const mode = resolveMode();
  return {
    mode,
    next: isSafeNext(url.searchParams.get('next')) ? url.searchParams.get('next') : null,
    // Las cuentas sintéticas no viajan al cliente cuando hay entrada real, y en
    // el paquete de producción `listDemoUsers` ni siquiera está referenciada.
    accounts:
      __FIXTURE_LOGIN__ && mode === 'fixture-selector'
        ? listDemoUsers().map(({ id, name, initials, email, role }) => ({
            id,
            name,
            initials,
            email,
            role,
            roleLabel: ROLE_LABELS[role]
          }))
        : []
  };
};

/** Entrada real: nombre de usuario + contraseña. Siempre presente. */
const passwordAction: Actions['password'] = async ({ request }) => {
  const auth = getAuth();
  if (!auth) error(404, 'La entrada con contraseña no está configurada en este entorno');
  const formData = await request.formData();
  const name = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const nextValue = String(formData.get('next') ?? '');
  const destination = isSafeNext(nextValue) ? nextValue : null;
  if (!name || !password) return fail(400, { message: SIGN_IN_FAILED, username: name });

  try {
    await auth.api.signInUsername({
      body: { username: name, password },
      headers: request.headers
    });
  } catch (cause) {
    // El limitador (rateLimit, almacenado en base de datos) responde 429; es
    // el único caso que merece un mensaje distinto, porque callarlo dejaría a
    // la persona repitiendo una contraseña que sí es correcta.
    const status = (cause as { status?: number | string })?.status;
    if (status === 429 || status === 'TOO_MANY_REQUESTS') {
      return fail(429, { message: TOO_MANY_ATTEMPTS, username: name });
    }
    return fail(401, { message: SIGN_IN_FAILED, username: name });
  }
  // `/` reenvía a Hoy del primer hogar de la persona (routes/+page.server.ts).
  redirect(303, destination ?? '/');
};

/**
 * Selector de cuentas sintéticas. Solo se ensambla en `actions` cuando el
 * paquete se construyó con `__FIXTURE_LOGIN__`; en el paquete de producción
 * esta función queda sin referencias y Rollup la borra junto con `getDemoUser`,
 * `createDemoSession` y la lista de cuentas.
 *
 * Las dos rejas de dentro se conservan como refuerzo, no como cerradura: la
 * cerradura es que este código no viaje. `getAuth()` cubre el caso de una
 * instalación real construida a propósito con el selector (batería e2e con
 * base de datos), y el nombre de servidor cubre que ese paquete no se sirva
 * desde un dominio público.
 */
const demoAction: Actions['demo'] = async ({ cookies, request, url }) => {
  if (getAuth()) error(404, 'Este entorno entra con contraseña');
  if (!dev && !isLocalHostname(url.hostname)) error(403, 'El acceso demo solo está disponible en local');
  const formData = await request.formData();
  const accountId = String(formData.get('accountId') ?? '');
  const nextValue = String(formData.get('next') ?? '');
  const destination = isSafeNext(nextValue) ? nextValue : null;

  const user = getDemoUser(accountId);
  if (!user) return fail(400, { message: 'Elige una cuenta demo válida.' });
  createDemoSession(cookies, user.id, url.protocol === 'https:');
  redirect(303, destination ?? `/h/${encodeURIComponent(user.householdIds[0])}/today`);
};

/**
 * En el paquete de producción `actions` tiene UNA entrada. `?/demo` no responde
 * 403 ni 404 «a propósito»: responde 404 porque SvelteKit no encuentra ninguna
 * acción con ese nombre, igual que con cualquier nombre inventado.
 */
export const actions: Actions = __FIXTURE_LOGIN__
  ? { password: passwordAction, demo: demoAction }
  : { password: passwordAction };
