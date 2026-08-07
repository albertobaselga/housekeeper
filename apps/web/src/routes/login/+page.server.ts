import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { error, fail, redirect } from '@sveltejs/kit';
import { ROLE_LABELS } from '$lib/auth/capabilities';
import { getAuth } from '$lib/server/auth.server';
import { getDemoUser, listDemoUsers } from '$lib/server/fixtures.server';
import { createDemoSession } from '$lib/server/session.server';
import type { Actions, PageServerLoad } from './$types';

export type LoginMode = 'fixture-selector' | 'password-selector' | 'magic-link';

function isSafeNext(value: string | null): value is string {
  return Boolean(value && value.startsWith('/') && !value.startsWith('//'));
}

function isLocalHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

function demoPasswordEnabled(): boolean {
  return env.ENABLE_DEMO_PASSWORD_AUTH === 'true';
}

function resolveMode(): LoginMode {
  if (!getAuth()) return 'fixture-selector';
  return demoPasswordEnabled() ? 'password-selector' : 'magic-link';
}

/** Credenciales demo desde el entorno; nunca viajan al cliente. */
function demoCredentialFor(accountId: string): { email: string; password: string } | null {
  const byAccount: Record<string, [string | undefined, string | undefined]> = {
    'fixture:roble:admin': [env.DEMO_ADMIN_EMAIL, env.DEMO_ADMIN_PASSWORD],
    'fixture:roble:family': [env.DEMO_MEMBER_EMAIL, env.DEMO_MEMBER_PASSWORD],
    'fixture:roble:employee': [env.DEMO_EMPLOYEE_EMAIL, env.DEMO_EMPLOYEE_PASSWORD],
    'fixture:roble:helper': [env.DEMO_HELPER_EMAIL, env.DEMO_HELPER_PASSWORD],
    'fixture:roble:viewer': [env.DEMO_VIEWER_EMAIL, env.DEMO_VIEWER_PASSWORD]
  };
  const [email, password] = byAccount[accountId] ?? [];
  return email && password ? { email, password } : null;
}

export const load: PageServerLoad = ({ locals, url }) => {
  if (locals.user) redirect(303, `/h/${encodeURIComponent(locals.user.householdIds[0])}/today`);
  const mode = resolveMode();
  return {
    mode,
    next: isSafeNext(url.searchParams.get('next')) ? url.searchParams.get('next') : null,
    accounts:
      mode === 'magic-link'
        ? []
        : listDemoUsers().map(({ id, name, initials, email, role }) => ({
            id,
            name,
            initials,
            email,
            role,
            roleLabel: ROLE_LABELS[role]
          }))
  };
};

export const actions: Actions = {
  default: async ({ cookies, request, url }) => {
    if (!dev && !isLocalHostname(url.hostname)) error(403, 'El acceso demo solo está disponible en local');
    const formData = await request.formData();
    const accountId = String(formData.get('accountId') ?? '');
    const nextValue = String(formData.get('next') ?? '');
    const destination = isSafeNext(nextValue) ? nextValue : null;

    const auth = getAuth();
    if (auth) {
      if (!demoPasswordEnabled()) error(403, 'Las cuentas demo con contraseña están deshabilitadas');
      const credential = demoCredentialFor(accountId);
      if (!credential) return fail(400, { message: 'Elige una cuenta demo válida.' });
      try {
        await auth.api.signInEmail({
          body: { email: credential.email, password: credential.password },
          headers: request.headers
        });
      } catch {
        return fail(401, {
          message: 'La cuenta demo no existe todavía. Ejecuta `pnpm --filter @casa-clara/web seed:demo`.'
        });
      }
      redirect(303, destination ?? '/');
    }

    const user = getDemoUser(accountId);
    if (!user) return fail(400, { message: 'Elige una cuenta demo válida.' });
    createDemoSession(cookies, user.id, url.protocol === 'https:');
    redirect(303, destination ?? `/h/${encodeURIComponent(user.householdIds[0])}/today`);
  },

  magiclink: async ({ request }) => {
    const auth = getAuth();
    if (!auth) error(404, 'La autenticación real no está configurada');
    const formData = await request.formData();
    const email = String(formData.get('email') ?? '').trim();
    const nextValue = String(formData.get('next') ?? '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail(400, { message: 'Escribe un correo válido.' });
    }
    try {
      await auth.api.signInMagicLink({
        body: { email, callbackURL: isSafeNext(nextValue) ? nextValue : '/' },
        headers: request.headers
      });
    } catch {
      // Respuesta idéntica exista o no la cuenta: sin enumeración de usuarios.
    }
    return { sent: true };
  }
};
