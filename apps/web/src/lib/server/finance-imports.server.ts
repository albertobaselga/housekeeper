import type { Pool } from 'pg';

// Subpath obligatorio: la raíz `@housekeeper/domain` no reexporta finanzas.
import { normText, type FinanceBank, type ParsedRow } from '@housekeeper/domain/finance';
import {
  computeDedupHash,
  parseStatement,
  requireFinanceAdmin,
  runPostImportPipeline,
  withAuthorizedTransaction
} from '@housekeeper/server';

import { getDatabasePool } from './db.server';

/**
 * Tope de tamaño del extracto ANTES de materializarlo en memoria (mismo criterio
 * que `MAX_ATTACHMENT_BYTES` en attachments.server.ts): un extracto real de unos
 * cientos de movimientos no se acerca ni de lejos a esto, y sin tope cualquier
 * `family_admin` autenticado podría forzar a la función serverless a cargar un
 * fichero arbitrariamente grande antes de que `parseStatement` tenga ocasión de
 * rechazarlo.
 */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export interface ImportPreviewResult {
  bank: FinanceBank;
  newCount: number;
  dupCount: number;
  unknownRefs: string[];
  sample: Array<{ opDate: string; concept: string; provider: string | null; amountCents: string }>;
}

export interface NewAccountInput {
  bankRef: string;
  name: string;
  kind: 'comun' | 'personal' | 'inversion';
  ownerLabel: string;
}

export interface ImportConfirmResult {
  batchId: string | null;
  newCount: number;
  dupCount: number;
}

export class ImportUncoveredAccountsError extends Error {
  override readonly name = 'ImportUncoveredAccountsError';
  constructor(readonly refs: string[]) {
    super(`Cuentas sin dar de alta: ${refs.join(', ')}`);
  }
}

function hashOf(row: ParsedRow): string {
  return computeDedupHash({
    bankRef: row.bankRef,
    opDate: row.opDate,
    amountCents: row.amountCents,
    concept: row.concept,
    balanceCents: row.balanceCents,
    dedupRef: row.dedupRef
  });
}

/**
 * Filas realmente nuevas de un extracto: ni ya presentes en el hogar ni
 * repetidas DENTRO del propio fichero. Lo segundo no es teórico: `dedup_hash`
 * es UNIQUE por hogar, así que dos apuntes idénticos en el mismo extracto
 * reventarían la transacción entera con un 23505 y no se importaría nada.
 * Preview y confirm cuentan con esta misma función para que la previsualización
 * no mienta: los colapsados suman a `dupCount`. Cada fila fresca lleva su hash
 * ya calculado (en vez de un array paralelo indexado) para no necesitar `!`
 * al leerlo de vuelta bajo `noUncheckedIndexedAccess` (Ruling R7).
 */
function splitFreshRows(
  rows: readonly ParsedRow[],
  known: ReadonlySet<string>
): { fresh: Array<{ row: ParsedRow; hash: string }>; dupCount: number } {
  const seen = new Set<string>();
  const fresh: Array<{ row: ParsedRow; hash: string }> = [];
  for (const row of rows) {
    const hash = hashOf(row);
    if (known.has(hash) || seen.has(hash)) continue;
    seen.add(hash);
    fresh.push({ row, hash });
  }
  return { fresh, dupCount: rows.length - fresh.length };
}

/**
 * Previsualización sin estado: el fichero se parsea en memoria y solo se
 * consulta qué hashes ya existen y qué refs de cuenta faltan. Nada se persiste.
 *
 * [FASE 5 · despacho de cierre, F5-I3] El parseo va DENTRO de la transacción
 * autorizada, después de `requireFinanceAdmin`. El guard previo de la ruta
 * (`requireFinanceRequest`) solo comprueba sesión, UUID de hogar y
 * PERTENENCIA: con el parseo delante, cualquier miembro del hogar —la empleada
 * incluida, a quien la tabla de capacidades cierra las siete pantallas pero no
 * estos dos endpoints— podía forzar la descompresión y el parseo completo de
 * un xlsx de hasta 10 MB antes de recibir su 404. La respuesta al no
 * autorizado no cambia (mismo 404 de siempre): solo cambia el ORDEN.
 */
export async function previewImport(
  user: { id: string },
  householdId: string,
  bytes: Uint8Array,
  filename: string,
  pool: Pool | null = getDatabasePool()
): Promise<ImportPreviewResult> {
  if (!pool) throw new Error('La importación requiere la base de datos del hogar');
  return withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
    await requireFinanceAdmin(client, membership);
    const statement = parseStatement(bytes, filename);
    const hashes = statement.rows.map(hashOf);
    const existing = await client.query<{ dedup_hash: string }>(
      `select dedup_hash from app.finance_transactions
        where household_id = $1 and dedup_hash = any($2::text[])`,
      [householdId, hashes]
    );
    const known = new Set(existing.rows.map((row) => row.dedup_hash));
    const accounts = await client.query<{ bank_ref: string }>(
      `select bank_ref from app.finance_accounts where household_id = $1`,
      [householdId]
    );
    const knownRefs = new Set(accounts.rows.map((row) => row.bank_ref));
    const { fresh, dupCount } = splitFreshRows(statement.rows, known);
    return {
      bank: statement.bank,
      newCount: fresh.length,
      dupCount,
      unknownRefs: statement.accountRefs.filter((ref) => !knownRefs.has(ref)),
      sample: statement.rows.slice(0, 20).map((row) => ({
        opDate: row.opDate,
        concept: row.concept.slice(0, 120),
        provider: row.provider,
        amountCents: row.amountCents.toString()
      }))
    };
  });
}

/**
 * Confirmación sin estado (Vercel es efímero): el cliente reenvía el fichero y
 * el resultado es determinista por dedup_hash. Crea las cuentas nuevas del
 * payload, el lote y las transacciones, y ejecuta el pipeline unificado.
 * El extracto NO se persiste en ningún almacenamiento.
 *
 * [FASE 5 · despacho de cierre, F5-I3] El parseo va DENTRO de la transacción
 * autorizada, después de `requireFinanceAdmin`, por el mismo motivo que en
 * `previewImport`: quien no tiene la concesión recibe su 404 sin que el
 * servidor haya tocado el fichero.
 */
export async function confirmImport(
  user: { id: string },
  householdId: string,
  bytes: Uint8Array,
  filename: string,
  newAccounts: NewAccountInput[],
  pool: Pool | null = getDatabasePool()
): Promise<ImportConfirmResult> {
  if (!pool) throw new Error('La importación requiere la base de datos del hogar');
  return withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
    await requireFinanceAdmin(client, membership);
    const statement = parseStatement(bytes, filename);
    // `on conflict … do nothing`: reconfirmar el mismo extracto con las MISMAS
    // `newAccounts` (doble clic, reintento tras un timeout) es el camino
    // determinista que el propio módulo promete, no un 23505 sin capturar
    // sobre `UNIQUE (household_id, bank_ref)` (0036_finance.sql:118).
    for (const account of newAccounts) {
      await client.query(
        `insert into app.finance_accounts
           (household_id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs)
         values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, '[]'::jsonb)
         on conflict (household_id, bank_ref) do nothing`,
        [householdId, account.name, statement.bank, account.kind, account.ownerLabel, account.bankRef]
      );
    }
    const accounts = await client.query<{ id: string; bank_ref: string }>(
      `select id, bank_ref from app.finance_accounts where household_id = $1`,
      [householdId]
    );
    const accountByRef = new Map(accounts.rows.map((row) => [row.bank_ref, row.id]));
    const uncovered = statement.accountRefs.filter((ref) => !accountByRef.has(ref));
    if (uncovered.length > 0) throw new ImportUncoveredAccountsError(uncovered);

    const hashes = statement.rows.map(hashOf);
    const existing = await client.query<{ dedup_hash: string }>(
      `select dedup_hash from app.finance_transactions
        where household_id = $1 and dedup_hash = any($2::text[])`,
      [householdId, hashes]
    );
    const known = new Set(existing.rows.map((row) => row.dedup_hash));
    const { fresh, dupCount } = splitFreshRows(statement.rows, known);
    if (fresh.length === 0) return { batchId: null, newCount: 0, dupCount };

    const batch = await client.query<{ id: string }>(
      `insert into app.finance_import_batches (household_id, filename, bank, new_count, dup_count)
       values ($1, $2, $3, $4, $5) returning id`,
      [householdId, filename, statement.bank, fresh.length, dupCount]
    );
    const batchId = batch.rows[0]?.id;
    if (!batchId) throw new Error('La inserción del lote no devolvió identificador');

    for (const { row, hash } of fresh) {
      await client.query(
        `insert into app.finance_transactions
           (household_id, account_id, batch_id, op_date, value_date, concept, provider, provider_norm,
            amount_cents, balance_cents, code_common, code_own, category_id, status, transfer_group_id,
            dedup_hash, recurrence, recurrence_manual, raw, currency_code, bank_category)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, null, 'pendiente', null,
                 $13, null, false, $14::jsonb, 'EUR', $15)`,
        [
          householdId,
          accountByRef.get(row.accountRef),
          batchId,
          row.opDate,
          row.valueDate,
          row.concept,
          row.provider,
          row.provider ? normText(row.provider) : null,
          row.amountCents.toString(),
          row.balanceCents === null ? null : row.balanceCents.toString(),
          row.codeCommon,
          row.codeOwn,
          hash,
          JSON.stringify(row.raw),
          row.bankCategory
        ]
      );
    }
    await runPostImportPipeline(client, householdId);
    return { batchId, newCount: fresh.length, dupCount };
  });
}
