import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { magicLink } from 'better-auth/plugins/magic-link';
import pg from 'pg';

export interface MagicLinkMessage {
  email: string;
  url: string;
  token: string;
}

export interface AuthCoreOptions {
  /** Conexión del login de auth; su search_path aísla las tablas en el esquema `auth`. */
  databaseUrl: string;
  secret: string;
  baseURL: string;
  /** Contraseña solo para cuentas demo locales (ENABLE_DEMO_PASSWORD_AUTH). */
  demoPasswordEnabled?: boolean;
  sendMagicLink: (message: MagicLinkMessage) => Promise<void>;
  /** Plugins adicionales dependientes del runtime (p. ej. cookies de SvelteKit). */
  extraPlugins?: BetterAuthPlugin[];
}

function buildAuth(options: AuthCoreOptions, pool: pg.Pool) {
  return betterAuth({
    database: pool,
    secret: options.secret,
    baseURL: options.baseURL,
    emailAndPassword: {
      enabled: options.demoPasswordEnabled ?? false
    },
    plugins: [
      magicLink({
        expiresIn: 600,
        // Las membresías nacen por invitación/semilla; un enlace mágico nunca
        // crea cuentas nuevas por sí solo.
        disableSignUp: true,
        sendMagicLink: async ({ email, token, url }) => options.sendMagicLink({ email, token, url })
      })
    ]
  });
}

export type AuthInstance = ReturnType<typeof buildAuth>;

export interface AuthCore {
  auth: AuthInstance;
  pool: pg.Pool;
}

/**
 * Fábrica sin dependencias de SvelteKit: la usan el hook del servidor, el script
 * de semillas y los tests de integración con la misma configuración.
 */
export function createAuthCore(options: AuthCoreOptions): AuthCore {
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 3 });
  if (!options.extraPlugins?.length) {
    return { auth: buildAuth(options, pool), pool };
  }
  // Los plugins extra (cookies de SvelteKit) no añaden endpoints propios; el
  // tipo del API público sigue siendo el de la construcción canónica.
  const auth = betterAuth({
    database: pool,
    secret: options.secret,
    baseURL: options.baseURL,
    emailAndPassword: {
      enabled: options.demoPasswordEnabled ?? false
    },
    plugins: [
      magicLink({
        expiresIn: 600,
        disableSignUp: true,
        sendMagicLink: async ({ email, token, url }) => options.sendMagicLink({ email, token, url })
      }),
      ...options.extraPlugins
    ]
  }) as unknown as AuthInstance;
  return { auth, pool };
}

export async function runAuthMigrations(auth: AuthInstance): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
