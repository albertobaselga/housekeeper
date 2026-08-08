// Comando único de la Ola A: vuelca el «Manual de convivencia y operaciones
// v0.1» completo (Guía + rutinas + contacto + plantilla de menú) sobre una
// base de datos dada. Runbook: docs/runbooks/importar-manual.md.
//
//   DATABASE_URL=postgresql://... node scripts/import-manual.mjs \
//     --household <uuid> [--membership <uuid>] [--docx <Manual.docx>] [--dry-run]
//
// Secuencia:
//   1. (solo con --docx) regenera el corpus content/manual con convert-manual;
//      sin --docx usa el corpus commiteado — el .docx no se versiona.
//   2. wiki-import en DRY-RUN: si el corpus tiene un solo error, se aborta
//      aquí y la base queda intacta.
//   3. wiki-import real (idempotente por hash; repetirlo no duplica nada).
//   4. seed-manual: rutinas, contacto 112 y plantilla de menú (upsert por id
//      determinista).
// Con --dry-run los pasos 3-4 se ejecutan también como ensayo con rollback.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import pg from 'pg';

import { convert } from './convert-manual.mjs';
import { seedManual, printSeedReport } from './seed-manual.mjs';
import { importCorpus } from './wiki-import.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const corpusDir = path.join(packageRoot, 'content', 'manual');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--household':
        args.householdId = argv[++i];
        break;
      case '--membership':
        args.membershipId = argv[++i];
        break;
      case '--docx':
        args.docxPath = argv[++i];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        throw new Error(`argumento desconocido: ${argv[i]}`);
    }
  }
  if (!UUID_RE.test(args.householdId ?? '')) throw new Error('--household debe ser un uuid');
  if (args.membershipId && !UUID_RE.test(args.membershipId)) {
    throw new Error('--membership debe ser un uuid');
  }
  return args;
}

async function resolveMembership(client, householdId, membershipId) {
  if (membershipId) return membershipId;
  const admin = await client.query(
    `select id from app.household_memberships
      where household_id = $1 and role = 'family_admin'
        and revoked_at is null and starts_at <= now()
        and (expires_at is null or expires_at > now())
      order by created_at, id limit 1`,
    [householdId]
  );
  const id = admin.rows[0]?.id;
  if (!id) {
    throw new Error(`el hogar ${householdId} no tiene family_admin activo (usa --membership)`);
  }
  return id;
}

let client;
try {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL es obligatoria (rol admin/propietario de migraciones)');

  if (args.docxPath) {
    const summary = await convert({ docxPath: args.docxPath, outDir: corpusDir });
    console.log(
      `corpus regenerado: ${summary.notes} notas (${summary.published} publicadas, ` +
        `${summary.drafts} sin publicar) en ${corpusDir}`
    );
  } else {
    console.log(`corpus commiteado: ${corpusDir}`);
  }

  client = new pg.Client({ connectionString: url });
  await client.connect();
  const membershipId = await resolveMembership(client, args.householdId, args.membershipId);
  const importArgs = { householdId: args.householdId, membershipId, dir: corpusDir };

  // Ensayo transaccional SIEMPRE antes de tocar nada.
  const rehearsal = await importCorpus(client, { ...importArgs, dryRun: true });
  if (rehearsal.errors.length > 0) {
    for (const error of rehearsal.errors) console.error(`ERROR ${error.file}: ${error.reason}`);
    throw new Error('el dry-run del corpus falló; nada se ha importado');
  }
  console.log(
    `[dry-run] guía: ${rehearsal.pages.created.length} notas nuevas, ` +
      `${rehearsal.pages.updated.length} actualizadas, ${rehearsal.pages.skipped.length} sin cambios`
  );

  if (!args.dryRun) {
    const imported = await importCorpus(client, importArgs);
    console.log(
      `guía importada: ${imported.spaces.created.length} apartados nuevos, ` +
        `${imported.pages.created.length} notas nuevas, ${imported.pages.updated.length} actualizadas, ` +
        `${imported.pages.skipped.length} sin cambios, ${imported.revisions} revisiones`
    );
  }

  const seedReport = await seedManual(client, {
    householdId: args.householdId,
    membershipId,
    dryRun: args.dryRun,
  });
  printSeedReport(seedReport);
  console.log(args.dryRun ? 'ensayo completado; nada persistido.' : 'manual volcado por completo.');
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
} finally {
  await client?.end();
}
