import { getRequestEvent } from '$app/server';
import { env } from '$env/dynamic/private';
import { sveltekitCookies } from 'better-auth/svelte-kit';

import { createAuthCore, type AuthInstance } from './auth-core';

let instance: AuthInstance | null | undefined;

/**
 * Instancia perezosa de Better Auth. Devuelve null cuando el entorno no define
 * DATABASE_AUTH_URL/BETTER_AUTH_SECRET: la demo sin base de datos mantiene el
 * selector local y ninguna ruta /api/auth queda expuesta.
 *
 * No hay entrega de correo en ningún punto del recorrido de acceso: se entra
 * con usuario y contraseña, y las contraseñas se reponen cara a cara desde
 * Ajustes (docs/despliegue/acceso-produccion.md).
 */
export function getAuth(): AuthInstance | null {
  if (instance !== undefined) return instance;
  if (!env.DATABASE_AUTH_URL || !env.BETTER_AUTH_SECRET) {
    instance = null;
    return instance;
  }
  instance = createAuthCore({
    databaseUrl: env.DATABASE_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL ?? 'http://localhost:3000',
    extraPlugins: [sveltekitCookies(getRequestEvent)]
  }).auth;
  return instance;
}
