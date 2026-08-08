// Sonda de instalación tipo Supabase.
//
// Reproduce en el Postgres local las tres condiciones que distinguen a un
// proyecto Supabase recién creado de nuestro Postgres autogestionado:
//
//   1. el rol propietario del esquema es NOSUPERUSER y, sobre todo, NOBYPASSRLS
//      (sólo tiene CREATEROLE y CREATEDB);
//   2. unaccent y pg_trgm vienen preinstaladas en un esquema `extensions`, no en
//      `public`, y no somos dueños de esas extensiones;
//   3. los roles anon / authenticated / service_role ya existen.
//
// Sobre esa base instala el esquema COMPLETO desde cero -- bootstrap, las
// migraciones y las suites SQL/RLS -- con ese rol. Si algo del expediente deja
// de ser desplegable en Postgres gestionado, esta sonda se pone roja.
//
//   PROBE_ADMIN_URL=postgresql://casa_admin@127.0.0.1:54329/postgres \
//     pnpm --filter @casa-clara/db probe:supabase
//
// Variables: PROBE_ADMIN_URL (obligatoria, superusuario del clúster),
// PROBE_DATABASE (por omisión casaclara_sb_probe), PROBE_ROLE (sb_postgres),
// PROBE_EXTENSIONS_SCHEMA (extensions). Con --keep no borra la base al acabar.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import pg from 'pg';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const adminUrl = process.env.PROBE_ADMIN_URL;
const database = process.env.PROBE_DATABASE ?? 'casaclara_sb_probe';
const role = process.env.PROBE_ROLE ?? 'sb_postgres';
const extensionsSchema = process.env.PROBE_EXTENSIONS_SCHEMA ?? 'extensions';
const keep = process.argv.includes('--keep');

if (!adminUrl) {
  console.error('PROBE_ADMIN_URL is required (superusuario del clúster, base `postgres`)');
  process.exit(2);
}
if (!/^[a-z_][a-z0-9_]*$/.test(database) || !/^[a-z_][a-z0-9_]*$/.test(role)) {
  console.error('PROBE_DATABASE y PROBE_ROLE deben ser identificadores simples');
  process.exit(2);
}

const probeUrl = (() => {
  const parsed = new URL(adminUrl);
  parsed.username = role;
  parsed.password = '';
  parsed.pathname = `/${database}`;
  return parsed.toString();
})();
const adminOnProbeUrl = (() => {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
})();

function step(message) {
  console.log(`\n── ${message}`);
}

async function withClient(connectionString, run) {
  const client = new pg.Client({ connectionString });
  client.on('notice', (notice) => console.log(`   # ${notice.message}`));
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

function runScript(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(packageRoot, 'scripts', script)], {
      cwd: packageRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit'
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

step(`preparando el rol tipo Supabase «${role}» y la base «${database}»`);
await withClient(adminUrl, async (admin) => {
  await admin.query(
    `DO $probe_roles$
     BEGIN
       IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${literal(role)}) THEN
         CREATE ROLE ${role} LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS NOREPLICATION;
       END IF;
       -- Los tres roles que Supabase deja creados de fábrica. No deben interferir.
       IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
         CREATE ROLE anon NOLOGIN NOINHERIT;
       END IF;
       IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
         CREATE ROLE authenticated NOLOGIN NOINHERIT;
       END IF;
       IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
         CREATE ROLE service_role NOLOGIN NOINHERIT;
       END IF;
     END
     $probe_roles$`
  );

  // En Supabase los roles de grupo no existen y los crea el propio bootstrap, que
  // por tanto obtiene ADMIN OPTION sobre ellos (PG16+). En este clúster ya
  // existen porque los comparten otras bases, así que se reproduce ese estado en
  // vez de recrearlos: borrarlos rompería las demás bases del clúster.
  await admin.query(
    `DO $probe_admin_option$
     DECLARE
       existing text;
     BEGIN
       FOREACH existing IN ARRAY ARRAY['casa_clara_app', 'casa_clara_worker'] LOOP
         IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = existing) THEN
           EXECUTE format('GRANT %I TO %I WITH ADMIN OPTION', existing, ${literal(role)});
         END IF;
       END LOOP;
     END
     $probe_admin_option$`
  );

  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${database} OWNER ${role}`);
});

step(`instalando unaccent y pg_trgm en el esquema «${extensionsSchema}», como hace Supabase`);
await withClient(adminOnProbeUrl, async (admin) => {
  await admin.query(`CREATE SCHEMA IF NOT EXISTS ${extensionsSchema}`);
  await admin.query(`GRANT USAGE ON SCHEMA ${extensionsSchema} TO PUBLIC`);
  await admin.query(`CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA ${extensionsSchema}`);
  await admin.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ${extensionsSchema}`);
});

step('comprobando que la sonda no se está engañando');
await withClient(probeUrl, async (client) => {
  const { rows } = await client.query(
    `SELECT rolsuper, rolbypassrls, rolcreaterole,
            to_regprocedure('public.unaccent(pg_catalog.regdictionary, pg_catalog.text)') IS NOT NULL AS unaccent_in_public
       FROM pg_catalog.pg_roles WHERE rolname = current_user`
  );
  const guard = rows[0];
  const problems = [];
  if (guard.rolsuper) problems.push('el rol de la sonda es superusuario');
  if (guard.rolbypassrls) problems.push('el rol de la sonda tiene BYPASSRLS');
  if (!guard.rolcreaterole) problems.push('el rol de la sonda no tiene CREATEROLE');
  if (guard.unaccent_in_public) problems.push('unaccent ya resuelve en public antes del bootstrap');
  if (problems.length > 0) {
    console.error(`la sonda no reproduce Supabase: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log('   rol NOSUPERUSER + NOBYPASSRLS + CREATEROLE, unaccent fuera de public: correcto');
});

const stages = [
  ['bootstrap', 'bootstrap.mjs', { DATABASE_URL: probeUrl }],
  ['migraciones desde cero', 'migrate.mjs', { DATABASE_URL: probeUrl }],
  ['migraciones otra vez (idempotencia)', 'migrate.mjs', { DATABASE_URL: probeUrl }],
  ['suites SQL/RLS', 'run-sql-tests.mjs', { TEST_DATABASE_URL: probeUrl }]
];

let failed = null;
for (const [label, script, env] of stages) {
  step(label);
  const code = await runScript(script, {
    ...env,
    APP_DB_PASSWORD: process.env.APP_DB_PASSWORD ?? 'probe-app-only',
    WORKER_DB_PASSWORD: process.env.WORKER_DB_PASSWORD ?? 'probe-worker-only',
    AUTH_DB_PASSWORD: process.env.AUTH_DB_PASSWORD ?? 'probe-auth-only'
  });
  if (code !== 0) {
    failed = label;
    break;
  }
}

if (!failed) {
  // wiki-search.ts y wiki.server.ts llaman a similarity() y word_similarity()
  // sin cualificar, así que el esquema de pg_trgm tiene que estar en el
  // search_path del rol con el que corre la web. Se comprueba con ese rol, no
  // con el propietario, que es donde importa.
  step('búsqueda trigram desde el rol de la aplicación');
  const appUrl = (() => {
    const parsed = new URL(probeUrl);
    parsed.username = 'casa_clara_app_login';
    parsed.password = process.env.APP_DB_PASSWORD ?? 'probe-app-only';
    return parsed.toString();
  })();
  try {
    await withClient(appUrl, async (client) => {
      const { rows } = await client.query(
        `SELECT similarity('lavadora', 'lavadoras') AS trigram,
                app.unaccent_es('Colchón de la habitación') AS unaccented`
      );
      console.log(`   similarity=${rows[0].trigram}, unaccent_es="${rows[0].unaccented}"`);
      if (rows[0].unaccented !== 'Colchon de la habitacion') {
        throw new Error(`app.unaccent_es devolvió "${rows[0].unaccented}"`);
      }
    });
  } catch (error) {
    console.error(`   ${error.message ?? error}`);
    failed = 'búsqueda trigram desde el rol de la aplicación';
  }
}

if (!failed) {
  step('estado final del forzado de RLS');
  await withClient(probeUrl, async (client) => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE relation.relrowsecurity)::int AS enabled,
              count(*) FILTER (WHERE relation.relforcerowsecurity)::int AS forced
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('app', 'app_private') AND relation.relkind = 'r'`
    );
    const { total, enabled, forced } = rows[0];
    console.log(`   ${enabled}/${total} tablas con RLS activada, ${forced}/${total} con FORCE`);
    if (enabled !== total) {
      console.error('   alguna tabla se quedó sin ENABLE ROW LEVEL SECURITY');
      failed = 'estado final del forzado de RLS';
    }
  });
}

if (!keep) {
  step('limpiando');
  await withClient(adminUrl, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  });
} else {
  console.log(`\nbase conservada: ${probeUrl}`);
}

if (failed) {
  console.error(`\nsonda Supabase ROJA en: ${failed}`);
  process.exit(1);
}
console.log('\nsonda Supabase VERDE: bootstrap + 18 migraciones + 5 suites SQL/RLS');

function literal(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
