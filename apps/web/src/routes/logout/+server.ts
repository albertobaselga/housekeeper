import { redirect, type RequestHandler } from '@sveltejs/kit';
import { getAuth } from '$lib/server/auth.server';
import { destroyDemoSession } from '$lib/server/session.server';

export const POST: RequestHandler = async ({ cookies, request, url }) => {
  const auth = getAuth();
  if (auth) {
    await auth.api.signOut({ headers: request.headers }).catch(() => {});
  }
  // Sin selector en el paquete no hay cookie de maqueta que borrar, y
  // `destroyDemoSession` queda sin referencias (ver fixture-login-flag.js).
  if (__FIXTURE_LOGIN__) destroyDemoSession(cookies, url.protocol === 'https:');
  redirect(303, '/login');
};
