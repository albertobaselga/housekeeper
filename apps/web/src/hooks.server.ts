import { building } from '$app/environment';
import { error, redirect, type Handle } from '@sveltejs/kit';
import { svelteKitHandler } from 'better-auth/svelte-kit';

import { guardForPath } from '$lib/auth/routing';
import { resolveAppUser } from '$lib/server/app-user.server';
import { getAuth } from '$lib/server/auth.server';
import { getDemoUser } from '$lib/server/fixtures.server';
import { readDemoSession } from '$lib/server/session.server';
import { syntheticGuard } from '$lib/server/synthetic.server';
import type { Session } from '$lib/auth/types';

export const handle: Handle = async ({ event, resolve }) => {
  const auth = getAuth();
  // Control 9: el flag solo-sintético se lee aquí y viaja por layout data
  // hasta el banner persistente del AppShell.
  event.locals.syntheticOnly = syntheticGuard().syntheticOnly;

  if (event.url.pathname.startsWith('/api/auth')) {
    if (!auth) error(404, 'La autenticación real no está configurada en este entorno');
    return svelteKitHandler({ event, resolve, auth, building });
  }

  if (auth) {
    const authSession = await auth.api.getSession({ headers: event.request.headers });
    if (authSession) {
      const session: Session = {
        id: authSession.session.id,
        userId: authSession.user.id,
        createdAt: new Date(authSession.session.createdAt).toISOString(),
        expiresAt: new Date(authSession.session.expiresAt).toISOString()
      };
      const user = await resolveAppUser(
        authSession.user.id,
        authSession.user.email,
        authSession.user.name ?? authSession.user.email
      );
      event.locals.session = user ? session : null;
      event.locals.user = user;
    } else {
      event.locals.session = null;
      event.locals.user = null;
    }
  } else {
    // Modo demo sin base de datos: sesiones en memoria y cuentas fixture.
    const session = readDemoSession(event.cookies);
    const user = session ? getDemoUser(session.userId) : null;
    event.locals.session = user ? session : null;
    event.locals.user = user;
  }

  const guard = guardForPath(event.url.pathname);
  if (guard) {
    if (!guard.known) error(404, 'Esta ruta no existe');
    if (!event.locals.user) {
      const next = `${event.url.pathname}${event.url.search}`;
      redirect(303, `/login?next=${encodeURIComponent(next)}`);
    }
    if (!guard.householdId || !event.locals.user.householdIds.includes(guard.householdId)) {
      error(404, 'Hogar no encontrado');
    }
    // El 403 por capacidad NO se lanza aquí: un error en el hook renderiza la
    // página de fallo cruda de SvelteKit. La misma comprobación vive en el
    // layout del hogar (+layout.server.ts), donde el error aterriza en
    // +error.svelte con un mensaje amable y un enlace de vuelta a Hoy.
  }

  const response = await resolve(event);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return response;
};
