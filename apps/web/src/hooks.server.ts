import { error, redirect, type Handle } from '@sveltejs/kit';
import { can } from '$lib/auth/capabilities';
import { guardForPath } from '$lib/auth/routing';
import { getDemoUser } from '$lib/server/fixtures.server';
import { readDemoSession } from '$lib/server/session.server';

export const handle: Handle = async ({ event, resolve }) => {
  const session = readDemoSession(event.cookies);
  const user = session ? getDemoUser(session.userId) : null;
  event.locals.session = user ? session : null;
  event.locals.user = user;

  const guard = guardForPath(event.url.pathname);
  if (guard) {
    if (!guard.known) error(404, 'Esta ruta no existe');
    if (!user) {
      const next = `${event.url.pathname}${event.url.search}`;
      redirect(303, `/login?next=${encodeURIComponent(next)}`);
    }
    if (!guard.householdId || !user.householdIds.includes(guard.householdId)) {
      error(404, 'Hogar no encontrado');
    }
    if (guard.capability && !can(user.role, guard.capability)) {
      error(403, 'Tu rol no permite abrir esta sección');
    }
  }

  const response = await resolve(event);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return response;
};
