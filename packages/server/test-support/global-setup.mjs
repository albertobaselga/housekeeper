import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

export const INTEGRATION_APP_LOGIN = 'it_housekeeper_app_login';

// Provisiona una sola vez por ejecución de vitest el esquema, las fixtures y el
// login sin BYPASSRLS que comparten todos los tests de integración del paquete.
export default async function provisionIntegrationDatabase() {
  const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!adminUrl) return;

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('drop schema if exists app cascade');
    await client.query('drop schema if exists app_private cascade');
    await client.query('drop table if exists public.schema_migrations');
    const dbWorkspace = new URL('../../db/', import.meta.url);
    const { applyMigrations } = await import(new URL('scripts/migrate.mjs', dbWorkspace).href);
    await applyMigrations(client);
    const fixturesDir = fileURLToPath(new URL('fixtures', dbWorkspace));
    for (const fixture of (await readdir(fixturesDir)).filter((f) => f.endsWith('.sql')).sort()) {
      await client.query(await readFile(path.join(fixturesDir, fixture), 'utf8'));
    }
    await client.query(`drop role if exists ${INTEGRATION_APP_LOGIN}`);
    await client.query(
      `create role ${INTEGRATION_APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`,
    );
  } finally {
    await client.end();
  }

  return async () => {
    const teardown = new pg.Client({ connectionString: adminUrl });
    await teardown.connect();
    try {
      await teardown.query(`drop role if exists ${INTEGRATION_APP_LOGIN}`);
    } catch {
      // El rol puede seguir referenciado por otra sesión; no es un fallo del suite.
    } finally {
      await teardown.end();
    }
  };
}
