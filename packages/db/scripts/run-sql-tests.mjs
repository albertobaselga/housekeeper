import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import pg from 'pg';

import { applyMigrations } from './migrate.mjs';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testsDir = path.join(packageRoot, 'tests');
const fixturesDir = path.join(packageRoot, 'fixtures');

async function resolveTestFiles(args) {
  if (args.length > 0) {
    return args.map((arg) => path.resolve(packageRoot, arg));
  }
  const entries = await readdir(testsDir);
  return entries
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(testsDir, name));
}

// Every run starts from an empty schema and exercises the real migration runner,
// so the suite covers "migrate from zero" on top of its own assertions.
async function resetAndProvision(client) {
  await client.query('DROP SCHEMA IF EXISTS app CASCADE');
  await client.query('DROP SCHEMA IF EXISTS app_private CASCADE');
  await client.query('DROP TABLE IF EXISTS public.schema_migrations');
  await applyMigrations(client);
  const fixtureEntries = (await readdir(fixturesDir)).filter((name) => name.endsWith('.sql')).sort();
  for (const fixture of fixtureEntries) {
    await client.query(await readFile(path.join(fixturesDir, fixture), 'utf8'));
  }
}

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('TEST_DATABASE_URL or DATABASE_URL is required');
  process.exit(2);
}

const testFiles = await resolveTestFiles(process.argv.slice(2));
if (testFiles.length === 0) {
  console.error('No SQL test files found.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
let failures = 0;
try {
  await client.connect();
  await resetAndProvision(client);

  console.log(`1..${testFiles.length}`);
  for (const [index, file] of testFiles.entries()) {
    const name = path.relative(packageRoot, file);
    try {
      await client.query(await readFile(file, 'utf8'));
      console.log(`ok ${index + 1} - ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`not ok ${index + 1} - ${name}`);
      console.error(`# ${error.message ?? error}`);
      await client.query('ROLLBACK').catch(() => {});
    }
  }
  console.log(`# tests ${testFiles.length - failures} passed, ${failures} failed of ${testFiles.length}`);
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
} finally {
  await client.end();
}
if (failures > 0) {
  process.exitCode = 1;
}
