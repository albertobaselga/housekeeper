import type { Cookies } from '@sveltejs/kit';
import type { Session } from '$lib/auth/types';

const COOKIE_NAME = 'cc_demo_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const sessions = new Map<string, Session>();

function cookieOptions(secure: boolean) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure,
    maxAge: SESSION_DURATION_MS / 1000
  };
}

export function createDemoSession(cookies: Cookies, userId: string, secure: boolean): Session {
  const now = Date.now();
  const session: Session = {
    id: crypto.randomUUID(),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_DURATION_MS).toISOString()
  };
  sessions.set(session.id, session);
  cookies.set(COOKIE_NAME, session.id, cookieOptions(secure));
  return session;
}

export function readDemoSession(cookies: Cookies): Session | null {
  const id = cookies.get(COOKIE_NAME);
  if (!id) return null;
  const session = sessions.get(id);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

export function destroyDemoSession(cookies: Cookies, secure: boolean): void {
  const id = cookies.get(COOKIE_NAME);
  if (id) sessions.delete(id);
  cookies.delete(COOKIE_NAME, { ...cookieOptions(secure), maxAge: 0 });
}
