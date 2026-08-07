import { dev } from '$app/environment';
import { getRequestEvent } from '$app/server';
import { env } from '$env/dynamic/private';
import { sveltekitCookies } from 'better-auth/svelte-kit';

import { createAuthCore, type AuthInstance, type MagicLinkMessage } from './auth-core';

let instance: AuthInstance | null | undefined;

async function deliverMagicLink(message: MagicLinkMessage): Promise<void> {
  if (env.SMTP_HOST) {
    const { default: nodemailer } = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT ?? 1025),
      secure: false
    });
    await transport.sendMail({
      from: env.SMTP_FROM ?? 'Casa Clara <no-reply@casaclara.test>',
      to: message.email,
      subject: 'Tu enlace de acceso a Casa Clara',
      text: `Abre este enlace para entrar (caduca en 10 minutos):\n\n${message.url}\n\nSi no lo has pedido, ignora este mensaje.`
    });
    return;
  }
  if (dev) {
    // Solo en desarrollo: el enlace contiene un secreto y no debe tocar logs reales.
    console.info(`[auth] Enlace mágico para ${message.email}: ${message.url}`);
    return;
  }
  throw new Error('SMTP no configurado: no se puede entregar el enlace de acceso');
}

/**
 * Instancia perezosa de Better Auth. Devuelve null cuando el entorno no define
 * DATABASE_AUTH_URL/BETTER_AUTH_SECRET: la demo sin base de datos mantiene el
 * selector local y ninguna ruta /api/auth queda expuesta.
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
    demoPasswordEnabled: env.ENABLE_DEMO_PASSWORD_AUTH === 'true',
    sendMagicLink: deliverMagicLink,
    extraPlugins: [sveltekitCookies(getRequestEvent)]
  }).auth;
  return instance;
}
