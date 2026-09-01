// Bootstrap de roles, esquema `casa_auth` y compatibilidad de extensiones.
//
// Antes vivía en infra/postgres/00-create-roles.sh, que sólo se ejecuta desde
// docker-entrypoint-initdb.d: un punto de enganche que Postgres gestionado
// (Supabase) no tiene. Ahora la lógica está en scripts/sql/bootstrap.sql y este
// runner la aplica sobre cualquier conexión, incluida la directa (5432) de
// Supabase con el rol `postgres`.
//
//   DATABASE_URL=… APP_DB_PASSWORD=… WORKER_DB_PASSWORD=… AUTH_DB_PASSWORD=… \
//     pnpm --filter @housekeeper/db bootstrap
//
// Ejecutar SIEMPRE antes de las migraciones: 0001 concede sobre casa_clara_app y
// casa_clara_worker, así que esos roles tienen que existir ya.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import pg from 'pg';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const bootstrapSqlPath = path.join(packageRoot, 'scripts', 'sql', 'bootstrap.sql');

const PASSWORD_SETTINGS = [
  ['housekeeper.app_password', 'APP_DB_PASSWORD'],
  ['housekeeper.worker_password', 'WORKER_DB_PASSWORD'],
  ['housekeeper.auth_password', 'AUTH_DB_PASSWORD']
];

// Las contraseñas viajan como parámetros de sesión para que psql y este runner
// compartan el mismo SQL. `set_config` es parametrizable, así que el secreto
// nunca se interpola en el texto de la sentencia.
export async function applyBootstrap(client, { env = process.env, log = () => {} } = {}) {
  const missing = PASSWORD_SETTINGS.filter(([, variable]) => !env[variable]).map(([, name]) => name);
  for (const [setting, variable] of PASSWORD_SETTINGS) {
    if (env[variable]) {
      await client.query('SELECT set_config($1, $2, false)', [setting, env[variable]]);
    }
  }
  if (missing.length > 0) {
    log(`sin ${missing.join(', ')}: los roles de login se crean sin tocar su contraseña`);
  }
  await client.query(await readFile(bootstrapSqlPath, 'utf8'));
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM pg_catalog.pg_roles
              WHERE rolname LIKE 'casa_clara\\_%')::int AS roles,
            (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname = 'casa_auth')::int AS auth_schema,
            (to_regprocedure('public.unaccent(pg_catalog.regdictionary, pg_catalog.text)') IS NOT NULL) AS unaccent_ready`
  );
  return rows[0];
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString });
  client.on('notice', (notice) => console.log(`# ${notice.message}`));
  try {
    await client.connect();
    const summary = await applyBootstrap(client, { log: console.log });
    console.log(
      `bootstrap ok: ${summary.roles} roles casa_clara_*, esquema casa_auth ${
        summary.auth_schema ? 'presente' : 'ausente'
      }, public.unaccent(regdictionary, text) ${
        summary.unaccent_ready ? 'resoluble' : 'la creará CREATE EXTENSION en 0007'
      }`
    );
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
