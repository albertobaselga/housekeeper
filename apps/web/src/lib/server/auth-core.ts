import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { admin } from 'better-auth/plugins/admin';
import { username } from 'better-auth/plugins/username';
import pg from 'pg';

/**
 * Longitud mínima de contraseña, compartida por la aplicación, el guion de alta
 * de cuentas y los formularios de cambio/reposición para que el mensaje de
 * «demasiado corta» diga siempre el mismo número.
 */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Rol de Better Auth que habilita el plugin `admin` (reponer contraseñas y
 * cerrar sesiones ajenas). NO es la autorización de la aplicación: el permiso
 * real lo concede la membresía `family_admin` bajo RLS. Este rol es la segunda
 * reja, y el guion de alta lo mantiene alineado con `family_admin`.
 */
export const AUTH_ADMIN_ROLE = 'admin';
export const AUTH_MEMBER_ROLE = 'user';

export interface AuthCoreOptions {
  /** Conexión del login de auth; su search_path aísla las tablas en el esquema `auth`. */
  databaseUrl: string;
  secret: string;
  baseURL: string;
  /** Plugins adicionales dependientes del runtime (p. ej. cookies de SvelteKit). */
  extraPlugins?: BetterAuthPlugin[];
}

/** Plugins propios de la casa, en tupla para que la inferencia del API no se diluya. */
type HousePlugins = [ReturnType<typeof username>, ReturnType<typeof admin>];

/**
 * Configuración canónica: se escribe UNA sola vez. `createAuthCore()` la reutiliza
 * tal cual y solo concatena `extraPlugins` cuando el runtime los aporta, de modo
 * que ningún cambio de configuración haya que escribirlo dos veces.
 *
 * Decisiones deliberadas (docs/despliegue/opciones-de-acceso.md §8):
 *
 * - `disableSignUp: true` **en todos los entornos**. `/api/auth` se monta entero
 *   en cuanto existe una instancia (hooks.server.ts), así que sin esta línea
 *   `POST /api/auth/sign-up/email` quedaría abierto a internet. Las cuentas nacen
 *   siempre del guion de alta, nunca de la web.
 * - **Sin `sendResetPassword`**: el endpoint `request-password-reset` responde
 *   entonces `400 RESET_PASSWORD_DISABLED`. El restablecimiento por correo queda
 *   deshabilitado a propósito; se repone cara a cara desde Ajustes.
 * - **Sin `magicLink`**: esta casa no depende del correo para entrar.
 * - `rateLimit.storage: 'database'`: el contador en memoria no sobrevive a un
 *   despliegue sin estado (cada función arrancaría con el contador a cero).
 */
function authOptions(options: AuthCoreOptions, pool: pg.Pool) {
  return {
    database: pool,
    secret: options.secret,
    baseURL: options.baseURL,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH
    },
    rateLimit: {
      storage: 'database' as const,
      customRules: {
        '/sign-in/username': { window: 60, max: 5 },
        '/sign-in/email': { window: 60, max: 5 },
        '/change-password': { window: 60, max: 5 },
        '/admin/set-user-password': { window: 60, max: 5 }
      }
    },
    plugins: [
      // Nuria entra tecleando `nuria`, no un correo: en un móvil es
      // notablemente más fácil de escribir sin erratas.
      username(),
      admin({ defaultRole: AUTH_MEMBER_ROLE, adminRoles: [AUTH_ADMIN_ROLE] })
    ] satisfies HousePlugins
  };
}

function buildAuth(options: ReturnType<typeof authOptions>) {
  return betterAuth(options);
}

export type AuthInstance = ReturnType<typeof buildAuth>;

export interface AuthCore {
  auth: AuthInstance;
  pool: pg.Pool;
}

/**
 * Fábrica sin dependencias de SvelteKit: la usan el hook del servidor, el guion
 * de alta de cuentas y los tests de integración con la misma configuración.
 */
export function createAuthCore(options: AuthCoreOptions): AuthCore {
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 3 });
  const base = authOptions(options, pool);
  if (!options.extraPlugins?.length) {
    return { auth: buildAuth(base), pool };
  }
  // Los plugins extra (cookies de SvelteKit) no añaden endpoints propios; el
  // tipo del API público sigue siendo el de la construcción canónica.
  const auth = betterAuth({
    ...base,
    plugins: [...base.plugins, ...options.extraPlugins]
  }) as unknown as AuthInstance;
  return { auth, pool };
}

export async function runAuthMigrations(auth: AuthInstance): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
