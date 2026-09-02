// ETL única de home-finance (SQLite) → casa-clara (Postgres, esquema 0036).
// Runbook: docs/runbooks/migracion-home-finance.md. Se ejecuta con `node` a
// pelo por conexión DIRECTA (5432) del propietario, como las migraciones.
// PASO 0 innegociable: copia de seguridad datada del .db FUERA de ambos repos.
// Imports EXACTOS de esta tarea: `pnpm lint` aplica @typescript-eslint/no-unused-vars
// como error también a los .mjs, así que cada tarea añade solo lo que estrena.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class ErrorDeUso extends Error {}

const USO = `Uso: node scripts/migrar-home-finance.mjs \\
  --sqlite <ruta finanzas.db> --database-url <postgresql://…> --household <slug> \\
  [--backup-dir <dir>] [--dry-run] [--verify-only] [--force-empty-check]`;

export function parseArgs(argv) {
  const opciones = {
    sqlite: null, databaseUrl: null, household: null,
    backupDir: path.join(os.homedir(), 'copias-home-finance'),
    dryRun: false, verifyOnly: false, forceEmptyCheck: false
  };
  const conValor = { '--sqlite': 'sqlite', '--database-url': 'databaseUrl', '--household': 'household', '--backup-dir': 'backupDir' };
  const banderas = { '--dry-run': 'dryRun', '--verify-only': 'verifyOnly', '--force-empty-check': 'forceEmptyCheck' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg in conValor) {
      const valor = argv[i + 1];
      if (!valor || valor.startsWith('--')) throw new ErrorDeUso(`${arg} necesita un valor.\n${USO}`);
      opciones[conValor[arg]] = valor;
      i += 1;
    } else if (arg in banderas) {
      opciones[banderas[arg]] = true;
    } else {
      throw new ErrorDeUso(`Argumento desconocido: ${arg}.\n${USO}`);
    }
  }
  for (const [bandera, clave] of [['--sqlite', 'sqlite'], ['--database-url', 'databaseUrl'], ['--household', 'household']]) {
    if (!opciones[clave]) throw new ErrorDeUso(`Falta ${bandera}.\n${USO}`);
  }
  if (opciones.dryRun && opciones.verifyOnly) throw new ErrorDeUso(`--dry-run y --verify-only son excluyentes.\n${USO}`);
  return opciones;
}

// Réplica EXACTA de backend/app/money.py::norm_text del origen, congelada a
// propósito: lo migrado debe casar con los alias que el origen escribió.
export function normText(valor) {
  const sinMarcas = valor.normalize('NFKD').replace(/\p{M}+/gu, '');
  return sinMarcas.replace(/\s+/g, ' ').trim().toUpperCase();
}

/** «Fuera de ambos repos» hecho comprobable: fuera de CUALQUIER repo git. */
export async function estaDentroDeUnRepo(dir) {
  let actual = path.resolve(dir);
  for (;;) {
    try {
      await access(path.join(actual, '.git'));
      return true;
    } catch {
      const padre = path.dirname(actual);
      if (padre === actual) return false;
      actual = padre;
    }
  }
}

export async function hacerCopiaSeguridad(rutaSqlite, backupDir, ahora = new Date()) {
  if (await estaDentroDeUnRepo(backupDir)) {
    throw new Error(`El directorio de copias ${backupDir} está dentro de un repositorio git; la copia de seguridad debe vivir fuera de ambos repos.`);
  }
  await mkdir(backupDir, { recursive: true });
  const sello = ahora.toISOString().replace(/[:.]/g, '-');
  const destino = path.join(backupDir, `finanzas-${sello}.db`);
  await copyFile(rutaSqlite, destino, constants.COPYFILE_EXCL);
  const [origen, copia] = await Promise.all([readFile(rutaSqlite), readFile(destino)]);
  const sha256 = createHash('sha256').update(origen).digest('hex');
  if (sha256 !== createHash('sha256').update(copia).digest('hex')) {
    throw new Error('La copia de seguridad no coincide con el original (sha256 distinto).');
  }
  return { destino, sha256 };
}

export function leerOrigen(rutaSqlite) {
  const db = new DatabaseSync(rutaSqlite, { readOnly: true });
  try {
    const todo = (sql) => {
      const stmt = db.prepare(sql);
      stmt.setReadBigInts(true); // céntimos SIEMPRE bigint, nunca Number
      return stmt.all();
    };
    const n = (v) => (v === null ? null : Number(v));
    return {
      accounts: todo('SELECT id, name, bank, kind, owner, bank_ref, owner_aliases, transfer_refs FROM accounts ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), owner_aliases: f.owner_aliases ?? '[]', transfer_refs: f.transfer_refs ?? '[]' })),
      categories: todo('SELECT id, name, parent_id, kind FROM categories ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), parent_id: n(f.parent_id) })),
      rules: todo('SELECT id, match_type, pattern, code_common, category_id, origin, priority, active FROM rules ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), category_id: n(f.category_id), priority: n(f.priority), active: f.active === 1n })),
      importBatches: todo('SELECT id, filename, bank, imported_at, new_count, dup_count FROM import_batches ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), new_count: n(f.new_count), dup_count: n(f.dup_count) })),
      // `raw` es nullable en el origen (models.py:74) y en 0036 la columna es
      // `jsonb NOT NULL DEFAULT '{}'` con CHECK de objeto: se coalesce AQUÍ, una
      // sola vez, igual que owner_aliases/transfer_refs (resolución canónica 8).
      transactions: todo(`SELECT id, account_id, batch_id, op_date, value_date, concept, provider,
          amount_cents, balance_cents, code_common, code_own, category_id, status,
          transfer_group_id, dedup_hash, recurrence, recurrence_manual, bank_category, raw
          FROM transactions ORDER BY id`)
        .map((f) => ({ ...f, id: n(f.id), account_id: n(f.account_id), batch_id: n(f.batch_id),
          category_id: n(f.category_id), recurrence_manual: f.recurrence_manual === 1n,
          raw: f.raw ?? '{}' })),
      providerAliases: todo('SELECT id, provider_norm, alias FROM provider_aliases ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id) })),
      events: todo('SELECT id, name FROM events ORDER BY id').map((f) => ({ ...f, id: n(f.id) })),
      transactionEvents: todo('SELECT id, transaction_id, event_id FROM transaction_events ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), transaction_id: n(f.transaction_id), event_id: n(f.event_id) })),
      eventRules: todo('SELECT id, provider_norm, concept_norm, category_id, event_id FROM event_rules ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), category_id: n(f.category_id), event_id: n(f.event_id) }))
    };
  } finally {
    db.close();
  }
}
