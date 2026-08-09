import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import pg from 'pg';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const migrationsDir = path.join(packageRoot, 'migrations');

const TRACKING_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename text PRIMARY KEY,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
  )
`;

// Bloque idempotente que levanta FORCE ROW LEVEL SECURITY sobre el propietario
// del esquema cuando ese rol no puede puentear RLS (Postgres gestionado tipo
// Supabase). Es una migración de pleno derecho, pero además hay que ejecutarla
// ENTRE migraciones: 0005, 0007, 0008, 0013, 0014, 0015 y 0016 vuelven a forzar,
// y las funciones SECURITY DEFINER con `SET row_security = off` de 0006 en
// adelante no se pueden ni crear mientras el forzado siga puesto. Reutilizar el
// fichero de la migración evita mantener dos copias del mismo bloque.
export const rlsForceCompatMigration = '0018_rls_force_compat.sql';

export async function listMigrationFiles() {
  const entries = await readdir(migrationsDir);
  return entries.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
}

// Los atributos de rol no se heredan por pertenencia, así que basta con mirar
// los del rol conectado: si es superusuario o tiene BYPASSRLS, FORCE no estorba
// y no se degrada nada.
async function ownerCanBypassRowSecurity(client) {
  const { rows } = await client.query(
    `SELECT coalesce(bool_or(rolsuper OR rolbypassrls), false) AS can_bypass
       FROM pg_catalog.pg_roles WHERE rolname = current_user`
  );
  return rows[0].can_bypass;
}

function stripOuterTransaction(filename, content) {
  const lines = content.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '' && !line.trim().startsWith('--'));
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') {
    last -= 1;
  }
  if (first === -1 || lines[first].trim() !== 'BEGIN;' || lines[last].trim() !== 'COMMIT;') {
    throw new Error(
      `${filename} must be a single BEGIN;...COMMIT; block so the runner can apply and record it atomically`
    );
  }
  return lines.slice(first + 1, last).join('\n');
}

// Applies every pending migration, each atomically together with its tracking row.
// Re-running against an up-to-date database performs no changes; a checksum drift
// on an already-applied file aborts instead of silently diverging.
// `until` detiene la aplicación DESPUÉS del fichero indicado. Solo existe para
// que las pruebas puedan dejar una base en un punto intermedio, sembrar datos y
// seguir migrando: una migración puede pasar con las tablas vacías y romperse
// con historial (le ocurrió a 0021 con los eventos de trabajo extra).
export async function applyMigrations(client, { log = () => {}, until = null } = {}) {
  await client.query("SELECT pg_advisory_lock(hashtext('casa_clara_schema_migrations'))");
  try {
    await client.query(TRACKING_TABLE_DDL);
    const { rows: appliedRows } = await client.query(
      'SELECT filename, sha256 FROM public.schema_migrations'
    );
    const applied = new Map(appliedRows.map((row) => [row.filename, row.sha256]));

    const relaxRlsForce = (await ownerCanBypassRowSecurity(client))
      ? null
      : await readFile(path.join(migrationsDir, rlsForceCompatMigration), 'utf8');
    if (relaxRlsForce) {
      log(`owner cannot bypass RLS; relaxing FORCE via ${rlsForceCompatMigration} between migrations`);
    }

    let appliedCount = 0;
    for (const filename of await listMigrationFiles()) {
      const content = await readFile(path.join(migrationsDir, filename), 'utf8');
      const checksum = createHash('sha256').update(content).digest('hex');
      const known = applied.get(filename);
      if (known !== undefined) {
        if (known !== checksum) {
          throw new Error(
            `${filename} was already applied with a different checksum; write a new migration instead of editing it`
          );
        }
        log(`skip ${filename} (already applied)`);
        continue;
      }
      const body = stripOuterTransaction(filename, content);
      if (relaxRlsForce) {
        await client.query(relaxRlsForce);
      }
      await client.query('BEGIN');
      try {
        await client.query(body);
        await client.query(
          'INSERT INTO public.schema_migrations (filename, sha256) VALUES ($1, $2)',
          [filename, checksum]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      appliedCount += 1;
      log(`applied ${filename}`);
      if (until && filename === until) break;
    }
    // Una pasada final para que una migración futura que vuelva a forzar no deje
    // la base en un estado donde la siguiente función definer no se pueda crear.
    if (relaxRlsForce && appliedCount > 0) {
      await client.query(relaxRlsForce);
    }
    return appliedCount;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('casa_clara_schema_migrations'))");
  }
}

export function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  return url;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const client = new pg.Client({ connectionString: connectionString() });
  try {
    await client.connect();
    const appliedCount = await applyMigrations(client, { log: console.log });
    console.log(
      appliedCount === 0
        ? 'Database is up to date; no migrations applied.'
        : `Applied ${appliedCount} migration(s).`
    );
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
