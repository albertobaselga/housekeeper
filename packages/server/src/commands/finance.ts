import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { CommandEnvelopeV1, UUID } from "@housekeeper/contracts";
import { hasCapability } from "@housekeeper/contracts/capabilities";
import { financeCommandPayloadSchema, financeWritePayloadSchema } from "@housekeeper/contracts/schemas";
import { cashCounterlegFor, normalizeConcept, normText } from "@housekeeper/domain/finance";

import type { ActiveMembership } from "../database.js";
import { runPostImportPipeline } from "../finance/pipeline.js";
import { CommandRejectedError, type CommandHandler, type CommandHandlers } from "../sync.js";

/**
 * Doble cerrojo de Finanzas (spec §4), versión servidor: rol family_admin Y
 * concesión viva, verificados DENTRO de la transacción autorizada con la misma
 * función SQL que imponen las políticas RLS. Lo usan todos los handlers de
 * comandos y todos los endpoints REST de finanzas de las fases siguientes.
 * Análogo a requireAdmin (commands/membership.ts), más la segunda llave.
 */
export async function requireFinanceAdmin(
  client: PoolClient,
  membership: ActiveMembership,
): Promise<void> {
  if (membership.role !== "family_admin") {
    throw new CommandRejectedError("not_allowed", "Finanzas es de la familia administradora");
  }
  const result = await client.query<{ enabled: boolean }>(
    "select app.finance_enabled() as enabled",
  );
  if (!result.rows[0]?.enabled) {
    throw new CommandRejectedError("finance_not_granted", "Tu cuenta no tiene Finanzas activado");
  }
}

/**
 * Conceder/revocar NO exige concesión propia: cualquier family_admin con
 * access.manage gestiona quién ve Finanzas (y puede apagarse a sí mismo;
 * otra administración puede devolvérselo).
 */
function requireAccessManagingAdmin(membership: ActiveMembership): void {
  if (membership.role !== "family_admin" || !hasCapability(membership.role, "access.manage")) {
    throw new CommandRejectedError("not_allowed", "Solo la familia administradora gestiona Finanzas");
  }
}

async function grantFinance(
  client: PoolClient,
  householdId: UUID,
  actor: ActiveMembership,
  membershipId: UUID,
): Promise<{ resourceId: UUID }> {
  const target = await client.query<{ role: string; revoked: boolean }>(
    `select role::text as role, revoked_at is not null as revoked
       from app.household_memberships
      where household_id = $1 and id = $2`,
    [householdId, membershipId],
  );
  const row = target.rows[0];
  if (!row || row.revoked) {
    throw new CommandRejectedError("membership_not_found", "La membresía no existe o está revocada");
  }
  if (row.role !== "family_admin") {
    // El disparador finance_module_grants_target_guard (0036) respalda esta
    // regla en la base; aquí se rechaza con un código legible antes de chocar.
    throw new CommandRejectedError(
      "grant_target_not_admin",
      "Finanzas solo se concede a la familia administradora",
    );
  }
  const live = await client.query<{ id: string }>(
    `select id from app.finance_module_grants
      where household_id = $1 and membership_id = $2 and revoked_at is null`,
    [householdId, membershipId],
  );
  if (live.rows[0]) {
    throw new CommandRejectedError("already_granted", "Esa cuenta ya tiene Finanzas activado");
  }
  const inserted = await client.query<{ id: string }>(
    `insert into app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
     values ($1, $2, $3)
     returning id`,
    [householdId, membershipId, actor.id],
  );
  const grantId = inserted.rows[0]?.id;
  if (!grantId) throw new Error("La concesión de Finanzas no devolvió identificador");
  // Activar el módulo en un hogar por primera vez le siembra su árbol de
  // categorías (spec §5: «la semilla del origen se replica como datos por
  // hogar al activar el módulo o migrar»). Es idempotente y devuelve 0 si el
  // hogar ya tiene categorías —el que llega por el ETL de la fase 3, o
  // cualquier concesión posterior—, y bypasea RLS a propósito: quien concede
  // puede no tener concesión propia todavía. Sin esta línea, un hogar recién
  // activado se queda sin la raíz `transferencia` y no se pueden vincular
  // transferencias, efectivo ni inversiones.
  await client.query("select app.seed_finance_categories()");
  return { resourceId: grantId as UUID };
}

async function revokeFinance(
  client: PoolClient,
  householdId: UUID,
  actor: ActiveMembership,
  membershipId: UUID,
): Promise<{ resourceId: UUID }> {
  const updated = await client.query<{ id: string }>(
    `update app.finance_module_grants
        set revoked_at = statement_timestamp(),
            revoked_by_membership_id = $3
      where household_id = $1 and membership_id = $2 and revoked_at is null
      returning id`,
    [householdId, membershipId, actor.id],
  );
  if (!updated.rows[0]) {
    throw new CommandRejectedError("not_granted", "Esa cuenta no tiene Finanzas activado");
  }
  return { resourceId: updated.rows[0].id as UUID };
}

/**
 * [FASE 1] Concesión y revocación del módulo: puerta `access.manage`, NUNCA
 * `requireFinanceAdmin` — quien concede todavía puede no tener concesión
 * propia. El dispatcher de más abajo enruta aquí ANTES de exigir el doble
 * cerrojo, precisamente para que estos dos kinds no lo atraviesen. Cuerpo
 * movido tal cual desde el `financeCommandHandler` original de la fase 1: la
 * autorización sigue DENTRO de cada `case`, no antes del `switch`.
 */
async function handleFinanceGrantCommand(
  client: PoolClient,
  membership: ActiveMembership,
  envelope: CommandEnvelopeV1,
): Promise<{ resourceId: UUID }> {
  const parsed = financeCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  switch (payload.kind) {
    case "finance.grant.write":
      requireAccessManagingAdmin(membership);
      return grantFinance(client, envelope.householdId, membership, payload.membershipId);
    case "finance.revoke.write":
      requireAccessManagingAdmin(membership);
      return revokeFinance(client, envelope.householdId, membership, payload.membershipId);
  }
}

// Tipos derivados del esquema (no de las interfaces `*PayloadV1` de
// `@housekeeper/contracts`, escritas a mano): bajo `exactOptionalPropertyTypes`
// zod tipa cada campo opcional como `T | undefined` explícito en el valor, que
// no encaja con una interfaz a mano que solo declara la clave opcional. Usar
// el tipo que el propio `.parse()` produce evita el desajuste sin recurrir a
// castings, igual que `RoutineUpsertPayload` hace en `schemas.ts` con `z.infer`.
type FinanceWritePayload = ReturnType<typeof financeWritePayloadSchema.parse>;
type FinanceTransactionUpdatePayload = Extract<FinanceWritePayload, { kind: "finance.transaction.update" }>;
type FinanceTransactionsBulkPayload = Extract<FinanceWritePayload, { kind: "finance.transactions.bulk" }>;
type FinanceAssignConceptRecurrencePayload = Extract<
  FinanceWritePayload,
  { kind: "finance.transactions.assignConceptRecurrence" }
>;
type FinanceManualCreatePayload = Extract<FinanceWritePayload, { kind: "finance.transaction.manual.create" }>;
type FinanceManualDeletePayload = Extract<FinanceWritePayload, { kind: "finance.transaction.manual.delete" }>;
type FinanceTransactionInvestPayload = Extract<FinanceWritePayload, { kind: "finance.transaction.invest" }>;
type FinanceTransfersLinkPayload = Extract<FinanceWritePayload, { kind: "finance.transfers.link" }>;
type FinanceTransfersUnlinkPayload = Extract<FinanceWritePayload, { kind: "finance.transfers.unlink" }>;
type FinanceEventAssignTransactionsPayload = Extract<
  FinanceWritePayload,
  { kind: "finance.event.assignTransactions" }
>;
type FinanceEventAssignConceptPayload = Extract<FinanceWritePayload, { kind: "finance.event.assignConcept" }>;
type FinanceAliasUpdatePayload = Extract<FinanceWritePayload, { kind: "finance.alias.update" }>;
type FinanceAccountUpdatePayload = Extract<FinanceWritePayload, { kind: "finance.account.update" }>;
type FinanceCategoryCreatePayload = Extract<FinanceWritePayload, { kind: "finance.category.create" }>;
type FinanceCategoryAssignConceptPayload = Extract<FinanceWritePayload, { kind: "finance.category.assignConcept" }>;

interface FinanceTxRow {
  id: UUID;
  account_id: string;
  category_id: string | null;
  status: string;
  concept: string;
  provider: string | null;
  amount_cents: string;
  transfer_group_id: string | null;
  dedup_hash: string;
  batch_id: string | null;
  op_date: string;
}

async function requireFinanceTransaction(
  client: PoolClient,
  householdId: UUID,
  transactionId: UUID,
): Promise<FinanceTxRow> {
  const result = await client.query<FinanceTxRow>(
    `select id, account_id, category_id, status, concept, provider,
            amount_cents::text as amount_cents, transfer_group_id, dedup_hash, batch_id,
            op_date::text as op_date
       from app.finance_transactions
      where household_id = $1 and id = $2`,
    [householdId, transactionId],
  );
  const row = result.rows[0];
  if (!row) throw new CommandRejectedError("finance_transaction_not_found", "El movimiento no existe en este hogar");
  return row;
}

async function requireFinanceCategory(
  client: PoolClient,
  householdId: UUID,
  categoryId: UUID,
): Promise<{ id: string; kind: string; parent_id: string | null }> {
  const result = await client.query<{ id: string; kind: string; parent_id: string | null }>(
    `select id, kind, parent_id from app.finance_categories where household_id = $1 and id = $2`,
    [householdId, categoryId],
  );
  const row = result.rows[0];
  if (!row) throw new CommandRejectedError("finance_category_not_found", "La categoría no existe en este hogar");
  return row;
}

/**
 * Movimientos NO vinculados a transferencia que casan con el selector del
 * pivot/las páginas de revisión: por categoría (la propia o sus hijas
 * DIRECTAS, filtrado en SQL con una subconsulta) o por proveedor —aceptando
 * cualquier alias cuyo `display` normalice al mismo texto— y, opcionalmente,
 * concepto. El filtro caro (categoría/proveedor) corre en SQL contra toda la
 * tabla; `finance_transactions` no tiene columna `concept_norm` propia (solo
 * `finance_event_rules` la tiene), así que el afinado final por concepto se
 * hace en memoria sobre el conjunto YA acotado por SQL, nunca sobre el hogar
 * entero.
 *
 * Espejo SQL de `matchByProvider`/`matchByCategory` en
 * `domain/finance/event-rules.ts`: misma semántica escrita dos veces (SQL
 * aquí, en memoria allí); si cambia una, cambia la otra.
 *
 * El filtro de proveedor compara `tx.provider_norm`, la columna ALMACENADA
 * (NULLABLE, sin trigger que la mantenga) — no la recalcula con `normText`
 * como hace el gemelo de dominio. Si un comando futuro
 * (`finance.transaction.manual.create`) inserta sin rellenarla, esas filas
 * desaparecen en silencio de este selector: quien escriba ese comando debe
 * poblar `provider_norm` a mano.
 */
async function matchingFinanceTxIds(
  client: PoolClient,
  householdId: UUID,
  selector: { provider?: string | undefined; concept?: string | undefined; categoryId?: string | undefined },
): Promise<string[]> {
  if (selector.categoryId) {
    const result = await client.query<{ id: string }>(
      `select tx.id
         from app.finance_transactions as tx
        where tx.household_id = $1
          and tx.transfer_group_id is null
          and (
            tx.category_id = $2
            or tx.category_id in (
              select id from app.finance_categories where household_id = $1 and parent_id = $2
            )
          )`,
      [householdId, selector.categoryId],
    );
    return result.rows.map((row) => row.id);
  }

  const providerNorm = normText(selector.provider ?? "");
  if (!providerNorm) {
    throw new CommandRejectedError("finance_selector_required", "Se requiere proveedor o categoría");
  }
  const aliases = await client.query<{ provider_norm: string; display: string }>(
    `select provider_norm, display from app.finance_provider_aliases where household_id = $1`,
    [householdId],
  );
  const acceptedProviderNorms = [
    providerNorm,
    ...aliases.rows.filter((alias) => normText(alias.display) === providerNorm).map((alias) => alias.provider_norm),
  ];
  const conceptNorm = selector.concept === undefined ? null : normText(normalizeConcept(selector.concept));

  const result = await client.query<{ id: string; concept: string }>(
    `select tx.id, tx.concept
       from app.finance_transactions as tx
      where tx.household_id = $1
        and tx.transfer_group_id is null
        and tx.provider_norm = any($2::text[])`,
    [householdId, acceptedProviderNorms],
  );
  const rows =
    conceptNorm === null
      ? result.rows
      : result.rows.filter((row) => normText(normalizeConcept(row.concept)) === conceptNorm);
  return rows.map((row) => row.id);
}

async function replaceTransactionEvents(
  client: PoolClient,
  householdId: UUID,
  transactionId: UUID,
  eventIds: readonly string[],
): Promise<void> {
  const wanted = [...new Set(eventIds)];
  if (wanted.length > 0) {
    const found = await client.query(
      `select id from app.finance_events where household_id = $1 and id = any($2::uuid[])`,
      [householdId, wanted],
    );
    if ((found.rowCount ?? 0) !== wanted.length) {
      throw new CommandRejectedError("finance_event_not_found", "Algún evento ya no existe");
    }
  }
  await client.query(
    `delete from app.finance_transaction_events where household_id = $1 and transaction_id = $2`,
    [householdId, transactionId],
  );
  if (wanted.length > 0) {
    // Una sola sentencia por conjuntos: el `delete` de arriba ya garantiza que
    // no hay conflicto con el UNIQUE (household_id, transaction_id, event_id).
    await client.query(
      `insert into app.finance_transaction_events (household_id, transaction_id, event_id)
       select $1, $2, unnest($3::uuid[])`,
      [householdId, transactionId, wanted],
    );
  }
}

async function updateFinanceTransaction(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceTransactionUpdatePayload,
): Promise<{ resourceId: UUID }> {
  const tx = await requireFinanceTransaction(client, householdId, payload.transactionId);
  if (payload.eventIds !== undefined) {
    await replaceTransactionEvents(client, householdId, tx.id, payload.eventIds);
  }
  if (payload.categoryId !== undefined && payload.categoryId !== null) {
    const category = await requireFinanceCategory(client, householdId, payload.categoryId);
    if (category.kind === "transferencia") {
      throw new CommandRejectedError("finance_category_is_transfer", "No se puede recategorizar a transferencia");
    }
  }
  await client.query(
    `update app.finance_transactions
        set category_id = case when $3::boolean then $4::uuid else category_id end,
            status = coalesce($5, status),
            concept = coalesce($6, concept),
            recurrence = case when $7::boolean then $8 else recurrence end,
            recurrence_manual = case when $7::boolean then true else recurrence_manual end
      where household_id = $1 and id = $2`,
    [
      householdId,
      tx.id,
      payload.categoryId !== undefined,
      payload.categoryId ?? null,
      payload.status ?? null,
      payload.concept ?? null,
      payload.recurrence !== undefined,
      payload.recurrence ?? null,
    ],
  );
  if (payload.createRule) {
    const finalCategory = payload.categoryId !== undefined ? payload.categoryId : tx.category_id;
    if (!finalCategory) {
      throw new CommandRejectedError("invalid_payload", "No se puede crear una regla sin categoría");
    }
    const pattern = payload.createRule.ruleType === "proveedor_exacto" ? tx.provider : tx.concept;
    if (!pattern) {
      throw new CommandRejectedError("invalid_payload", "El movimiento no tiene proveedor para la regla");
    }
    await replaceManualRule(client, householdId, payload.createRule.ruleType, pattern, finalCategory);
    await runPostImportPipeline(client, householdId);
  }
  return { resourceId: tx.id };
}

async function bulkUpdateFinanceTransactions(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceTransactionsBulkPayload,
): Promise<Record<string, never>> {
  // `status` es OPCIONAL a propósito: el pivot de la fase 6 cambia solo la
  // categoría en bloque. Que llegue al menos un campo de cambio (categoría o
  // estado) lo valida aquí (`invalid_payload`), no un refine del esquema: la
  // unión discriminada exige objetos planos.
  if (payload.categoryId === undefined && payload.status === undefined) {
    throw new CommandRejectedError("invalid_payload", "El cambio en bloque necesita categoría o estado");
  }
  if (payload.categoryId) {
    const category = await requireFinanceCategory(client, householdId, payload.categoryId);
    if (category.kind === "transferencia") {
      throw new CommandRejectedError("finance_category_is_transfer", "No se puede recategorizar a transferencia");
    }
  }
  // Todo o nada: si algún id de la selección no existe en este hogar (ya
  // borrado, o de otro hogar), el comando entero se rechaza en vez de aplicar
  // el cambio a un subconjunto sin decírselo al cliente. Se compara contra
  // ids DISTINTOS (no la longitud cruda) para no penalizar duplicados en la
  // selección. El throw revierte la transacción completa (withAuthorizedTransaction).
  const distinctIds = new Set(payload.transactionIds);
  const result = await client.query(
    `update app.finance_transactions as tx
        set status = coalesce($3, tx.status), category_id = coalesce($4::uuid, tx.category_id)
       from unnest($2::uuid[]) as ids(id)
      where tx.household_id = $1 and tx.id = ids.id`,
    [householdId, payload.transactionIds, payload.status ?? null, payload.categoryId ?? null],
  );
  if ((result.rowCount ?? 0) !== distinctIds.size) {
    throw new CommandRejectedError(
      "finance_transaction_not_found",
      (result.rowCount ?? 0) === 0
        ? "Ningún movimiento de la selección existe"
        : "Algún movimiento de la selección no existe en este hogar",
    );
  }
  return {};
}

async function assignConceptRecurrence(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceAssignConceptRecurrencePayload,
): Promise<Record<string, never>> {
  // Decisión (F5-I4): un selector que no casa con nada es un no-op ACEPTADO, no
  // un error — a diferencia de los ids explícitos, que sí se rechazan.
  const ids = await matchingFinanceTxIds(client, householdId, payload);
  if (ids.length > 0) {
    await client.query(
      `update app.finance_transactions
          set recurrence = $3, recurrence_manual = true
        where household_id = $1 and id = any($2::uuid[])`,
      [householdId, ids, payload.recurrence],
    );
  }
  return {};
}

async function requireFinanceAccount(
  client: PoolClient,
  householdId: UUID,
  accountId: UUID,
): Promise<{ id: string; kind: string; name: string }> {
  const result = await client.query<{ id: string; kind: string; name: string }>(
    `select id, kind, name from app.finance_accounts where household_id = $1 and id = $2`,
    [householdId, accountId],
  );
  const row = result.rows[0];
  if (!row) throw new CommandRejectedError("finance_account_not_found", "La cuenta no existe en este hogar");
  return row;
}

/**
 * Cuenta «Efectivo» del hogar: se identifica por `bank_ref = 'EFECTIVO'`
 * (`CASH_REF` del origen, `backend/app/cash.py:8`) y, como respaldo para
 * cuentas migradas o creadas a mano sin esa referencia, por el nombre
 * normalizado. Nunca por `bank = 'efectivo'`: el CHECK de 0036 solo admite
 * los cuatro bancos reales y deja NULL para las cuentas sin banco.
 */
async function cashAccountId(client: PoolClient, householdId: UUID): Promise<UUID | null> {
  const byRef = await client.query<{ id: string }>(
    `select id from app.finance_accounts
      where household_id = $1 and bank is null and archived_at is null and bank_ref = 'EFECTIVO'
      limit 1`,
    [householdId],
  );
  if (byRef.rows[0]) return byRef.rows[0].id as UUID;
  const byName = await client.query<{ id: string }>(
    `select id from app.finance_accounts
      where household_id = $1 and bank is null and archived_at is null and upper(name) = 'EFECTIVO'
      order by name
      limit 1`,
    [householdId],
  );
  return (byName.rows[0]?.id as UUID | undefined) ?? null;
}

/** Categoría raíz «Efectivo» (gasto) de la contrapartida; se siembra la primera vez. */
async function cashCategoryId(client: PoolClient, householdId: UUID): Promise<UUID> {
  const found = await client.query<{ id: string }>(
    `select id from app.finance_categories
      where household_id = $1 and parent_id is null and kind = 'gasto' and lower(name) = 'efectivo'
      limit 1`,
    [householdId],
  );
  const existing = found.rows[0]?.id;
  if (existing) return existing as UUID;
  const inserted = await client.query<{ id: string }>(
    `insert into app.finance_categories (household_id, name, kind, parent_id)
     values ($1, 'Efectivo', 'gasto', null) returning id`,
    [householdId],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("La inserción de la categoría Efectivo no devolvió identificador");
  return id as UUID;
}

/** Categoría raíz «transferencia» del hogar (a lo sumo una: índice único
 * parcial `finance_categories_one_transfer_root_idx`); se siembra la primera
 * vez, igual que `cashCategoryId`. La usan invest/link para agrupar patas. */
async function transferCategoryId(client: PoolClient, householdId: UUID): Promise<UUID> {
  const found = await client.query<{ id: string }>(
    `select id from app.finance_categories
      where household_id = $1 and parent_id is null and kind = 'transferencia'
      limit 1`,
    [householdId],
  );
  const existing = found.rows[0]?.id;
  if (existing) return existing as UUID;
  const inserted = await client.query<{ id: string }>(
    `insert into app.finance_categories (household_id, name, kind, parent_id)
     values ($1, 'Transferencias', 'transferencia', null) returning id`,
    [householdId],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("La inserción de la categoría Transferencias no devolvió identificador");
  return id as UUID;
}

/**
 * Estrechado sin `as` (R7) de `category.kind` — tipado `string` en
 * `requireFinanceCategory` — al literal que exige `FinanceTxView.categoryKind`.
 * El CHECK de 0036 garantiza el valor en la base; esto solo evita el cast
 * sobre una fila SQL para satisfacer al tipo.
 */
const FINANCE_CATEGORY_KINDS = ["gasto", "ingreso", "transferencia"] as const;

async function createManualTransaction(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceManualCreatePayload,
): Promise<{ resourceId: UUID }> {
  await requireFinanceAccount(client, householdId, payload.accountId);
  const category = payload.categoryId
    ? await requireFinanceCategory(client, householdId, payload.categoryId)
    : null;
  const provider = (payload.provider ?? "").trim();
  const providerNorm = provider ? normText(provider) : null;
  const dedupHash = `manual-${randomUUID().replace(/-/g, "")}`;
  const inserted = await client.query<{ id: string }>(
    `insert into app.finance_transactions
       (household_id, account_id, batch_id, op_date, value_date, concept, provider, provider_norm,
        amount_cents, balance_cents, category_id, status, transfer_group_id, dedup_hash,
        recurrence, recurrence_manual, raw, currency_code)
     values ($1, $2, null, $3, null, $4, $5, $6, $7, null, $8, 'confirmada', null, $9,
             $10, $11, '{}'::jsonb, 'EUR')
     returning id`,
    [
      householdId,
      payload.accountId,
      payload.opDate,
      payload.concept,
      provider || null,
      providerNorm,
      payload.amountCents,
      payload.categoryId ?? null,
      dedupHash,
      payload.recurrence ?? null,
      payload.recurrence != null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("La inserción del manual no devolvió identificador");

  // Doble entrada del efectivo: un gasto EN la cuenta Efectivo nace con su
  // contrapartida (+Efectivo, confirmada, recurrence_manual, hash `cashpair-`).
  // Se escribe aquí porque este comando es su ÚNICO productor: el paso
  // «efectivo» de runPostImportPipeline solo recategoriza retiradas de cajero
  // (fase 2), nunca inserta la contrapartida.
  const cashId = await cashAccountId(client, householdId);
  if (cashId && payload.accountId === cashId && payload.categoryId && category) {
    const efectivoCategoryId = await cashCategoryId(client, householdId);
    const categoryKind = FINANCE_CATEGORY_KINDS.find((kind) => kind === category.kind);
    if (!categoryKind) {
      throw new Error(`kind de categoría inesperado: ${category.kind}`);
    }
    const counterleg = cashCounterlegFor(
      {
        id: id as UUID,
        accountId: payload.accountId,
        opDate: payload.opDate,
        concept: payload.concept,
        provider: provider || null,
        providerNorm,
        amountCents: BigInt(payload.amountCents),
        categoryId: payload.categoryId,
        categoryKind,
        status: "confirmada",
        transferGroupId: null,
        recurrence: payload.recurrence ?? null,
        recurrenceManual: payload.recurrence != null,
        codeCommon: null,
        codeOwn: null,
        dedupHash,
      },
      { cashAccountId: cashId, efectivoCategoryId },
    );
    if (counterleg) {
      await client.query(
        `insert into app.finance_transactions
           (household_id, account_id, batch_id, op_date, value_date, concept, provider, provider_norm,
            amount_cents, balance_cents, category_id, status, transfer_group_id, dedup_hash,
            recurrence, recurrence_manual, raw, currency_code)
         values ($1, $2, null, $3, null, $4, $5, $6, $7, null, $8, 'confirmada', null, $9,
                 null, true, '{}'::jsonb, 'EUR')`,
        [
          householdId,
          counterleg.accountId,
          counterleg.opDate,
          counterleg.concept,
          counterleg.provider,
          normText(counterleg.provider),
          counterleg.amountCents.toString(),
          counterleg.categoryId,
          counterleg.dedupHash,
        ],
      );
    }
  }

  // Y después, la verdad post-escritura compartida: reglas, alias, espejos y
  // recurrencia, respetando los overrides manuales.
  await runPostImportPipeline(client, householdId);
  return { resourceId: id as UUID };
}

async function deleteManualTransaction(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceManualDeletePayload,
): Promise<Record<string, never>> {
  const tx = await requireFinanceTransaction(client, householdId, payload.transactionId);
  if (tx.dedup_hash.startsWith("cashpair-")) {
    throw new CommandRejectedError("finance_cashpair_leg", "Es una contrapartida de efectivo: borra su gasto");
  }
  if (tx.batch_id !== null || !tx.dedup_hash.startsWith("manual-")) {
    throw new CommandRejectedError("finance_not_manual", "Solo se pueden borrar movimientos manuales");
  }
  // Borrarlo dejaría a su pareja sola en el grupo, con la categoría
  // `transferencia` que Analítica y el pivot excluyen de ingreso y gasto: el
  // descuadre no saldría en ningún total. Primero se desvincula (el botón `⇄`
  // de Movimientos), y entonces sí se borra.
  if (tx.transfer_group_id !== null) {
    throw new CommandRejectedError(
      "finance_already_linked",
      "Desvincula la transferencia antes de borrar el movimiento",
    );
  }
  const counter = await client.query<{ id: string }>(
    `select id from app.finance_transactions where household_id = $1 and dedup_hash = $2`,
    [householdId, `cashpair-${tx.dedup_hash}`],
  );
  const ids = [tx.id, ...counter.rows.map((row) => row.id)];
  await client.query(
    `delete from app.finance_transaction_events where household_id = $1 and transaction_id = any($2::uuid[])`,
    [householdId, ids],
  );
  await client.query(`delete from app.finance_transactions where household_id = $1 and id = any($2::uuid[])`, [
    householdId,
    ids,
  ]);
  return {};
}

async function investTransaction(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceTransactionInvestPayload,
): Promise<{ resourceId: UUID }> {
  const tx = await requireFinanceTransaction(client, householdId, payload.transactionId);
  const account = await requireFinanceAccount(client, householdId, payload.accountId);
  if (account.kind !== "inversion") {
    throw new CommandRejectedError("finance_not_investment_account", "La cuenta destino no es de inversión");
  }
  if (tx.transfer_group_id) {
    throw new CommandRejectedError("finance_already_linked", "El movimiento ya está vinculado a un grupo");
  }
  if (BigInt(tx.amount_cents) >= 0n) {
    throw new CommandRejectedError("finance_invest_needs_charge", "Solo un cargo puede marcarse como inversión");
  }
  // Mismo prefijo que detectInvestmentContributions (domain/finance/investments.ts,
  // consumido por pipeline.ts): `invmirror-` + el dedup_hash del cargo real,
  // NUNCA un hash recalculado — así un espejo ya existente (creado por el
  // pipeline automático o por un invest anterior) se detecta por igualdad de
  // cadena, no por casualidad estadística.
  const mirrorHash = `invmirror-${tx.dedup_hash}`;
  const existing = await client.query(
    `select 1 from app.finance_transactions where household_id = $1 and dedup_hash = $2`,
    [householdId, mirrorHash],
  );
  if ((existing.rowCount ?? 0) > 0) {
    throw new CommandRejectedError("finance_mirror_exists", "Ya existía un espejo para este movimiento");
  }
  const groupId = randomUUID() as UUID;
  const categoryId = await transferCategoryId(client, householdId);
  // Mismo rótulo que detectInvestmentContributions (domain/finance/investments.ts,
  // el que usa el pipeline automático para la MISMA operación): concepto
  // "Aportación a <cuenta> — <proveedor del cargo>" y proveedor = nombre de la
  // cuenta de inversión, NUNCA el concepto/proveedor del cargo original — así
  // el usuario ve la misma etiqueta se dispare a mano o lo detecte el pipeline.
  const mirrorConcept = `Aportación a ${account.name} — ${tx.provider ?? ""}`;
  const mirrorProvider = account.name;
  // El espejo hereda el `batch_id` del cargo real, exactamente como el espejo
  // que inserta el pipeline (`finance/pipeline.ts`, «hereda el batch_id de su
  // cargo — deshacer el lote lo arrastra»): así el CASCADE de `import.undo` se
  // lleva las dos patas y nunca queda medio grupo de transferencia huérfano.
  // Para un cargo manual el `batch_id` es NULL y el espejo también.
  await client.query(
    `insert into app.finance_transactions
       (household_id, account_id, batch_id, op_date, concept, provider, provider_norm,
        amount_cents, category_id, status, transfer_group_id, dedup_hash,
        recurrence, recurrence_manual, raw, currency_code)
     values ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, 'confirmada', $10, $11, null, false, '{}'::jsonb, 'EUR')`,
    [
      householdId,
      payload.accountId,
      tx.batch_id,
      tx.op_date,
      mirrorConcept,
      mirrorProvider,
      normText(mirrorProvider),
      (-BigInt(tx.amount_cents)).toString(),
      categoryId,
      groupId,
      mirrorHash,
    ],
  );
  await client.query(
    `update app.finance_transactions
        set transfer_group_id = $3, category_id = $4, status = 'confirmada'
      where household_id = $1 and id = $2`,
    [householdId, tx.id, groupId, categoryId],
  );
  return { resourceId: groupId };
}

async function linkTransfers(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceTransfersLinkPayload,
): Promise<{ resourceId: UUID }> {
  const ids = [...new Set(payload.transactionIds)];
  // El esquema exige `transactionIds.min(2)` sobre el array CRUDO; tras
  // deduplicar con el Set puede quedar un único id (mismo id repetido a
  // propósito o por error del cliente) — sin esta guarda, un movimiento con
  // amount_cents = 0 (el CHECK de 0036 no lo prohíbe fuera de `manual.create`)
  // se agruparía consigo mismo.
  if (ids.length < 2) {
    throw new CommandRejectedError("invalid_payload", "Se necesitan al menos dos movimientos distintos");
  }
  const loaded = await client.query<{ id: string; amount_cents: string; transfer_group_id: string | null }>(
    `select id, amount_cents::text as amount_cents, transfer_group_id
       from app.finance_transactions
      where household_id = $1 and id = any($2::uuid[])`,
    [householdId, ids],
  );
  if ((loaded.rowCount ?? 0) !== ids.length) {
    throw new CommandRejectedError("finance_transaction_not_found", "Algún movimiento no existe");
  }
  if (loaded.rows.some((row) => row.transfer_group_id !== null)) {
    throw new CommandRejectedError("finance_already_linked", "Algún movimiento ya pertenece a un grupo");
  }
  const sum = loaded.rows.reduce((total, row) => total + BigInt(row.amount_cents), 0n);
  if (sum !== 0n) {
    throw new CommandRejectedError("finance_transfer_sum_not_zero", "La selección no suma cero");
  }
  const groupId = randomUUID() as UUID;
  const categoryId = await transferCategoryId(client, householdId);
  await client.query(
    `update app.finance_transactions
        set transfer_group_id = $3, category_id = $4, status = 'confirmada'
      where household_id = $1 and id = any($2::uuid[])`,
    [householdId, ids, groupId, categoryId],
  );
  return { resourceId: groupId };
}

async function unlinkTransfers(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceTransfersUnlinkPayload,
): Promise<Record<string, never>> {
  const legs = await client.query<{ id: string; dedup_hash: string }>(
    `select id, dedup_hash from app.finance_transactions
      where household_id = $1 and transfer_group_id = $2`,
    [householdId, payload.transferGroupId],
  );
  if ((legs.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("finance_transfer_group_not_found", "Esa transferencia ya no existe");
  }
  // Grupos con pata espejo de INVERSIÓN (`invmirror-`): se borra el espejo y la
  // pata real vuelve a pendiente. Grupos normales (dos patas manuales/reales):
  // se desagrupan las dos. Las contrapartidas de efectivo (`cashpair-`) no se
  // agrupan nunca: no llevan transfer_group_id y se borran con su gasto
  // manual (deleteManualTransaction), nunca por aquí.
  const mirrors = legs.rows.filter((row) => row.dedup_hash.startsWith("invmirror-")).map((row) => row.id);
  const real = legs.rows.filter((row) => !row.dedup_hash.startsWith("invmirror-")).map((row) => row.id);
  if (mirrors.length > 0) {
    await client.query(
      `delete from app.finance_transaction_events where household_id = $1 and transaction_id = any($2::uuid[])`,
      [householdId, mirrors],
    );
    await client.query(`delete from app.finance_transactions where household_id = $1 and id = any($2::uuid[])`, [
      householdId,
      mirrors,
    ]);
  }
  if (real.length > 0) {
    await client.query(
      `update app.finance_transactions
          set transfer_group_id = null, category_id = null, status = 'pendiente'
        where household_id = $1 and id = any($2::uuid[])`,
      [householdId, real],
    );
  }
  return {};
}

/**
 * Rechaza un nombre de evento que ya use otro evento del hogar (comparación
 * case-insensitive, como pide la fixture). `excludeId` deja pasar el propio
 * evento al renombrarlo (o al reintentar `create` con el mismo `id`, R21) sin
 * que choque consigo mismo.
 */
async function cleanEventName(
  client: PoolClient,
  householdId: UUID,
  name: string,
  excludeId: UUID | null,
): Promise<string> {
  const trimmed = name.trim();
  const clash = await client.query(
    `select 1 from app.finance_events
      where household_id = $1 and lower(name) = lower($2) and ($3::uuid is null or id <> $3)`,
    [householdId, trimmed, excludeId],
  );
  if ((clash.rowCount ?? 0) > 0) {
    throw new CommandRejectedError("finance_event_name_taken", `Ya existe un evento llamado «${trimmed}»`);
  }
  return trimmed;
}

async function requireFinanceEvent(client: PoolClient, householdId: UUID, eventId: UUID): Promise<UUID> {
  const result = await client.query(`select id from app.finance_events where household_id = $1 and id = $2`, [
    householdId,
    eventId,
  ]);
  if ((result.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("finance_event_not_found", "El evento no existe en este hogar");
  }
  return eventId;
}

/**
 * R21: `id` es opcional en el payload — la cola de sync puede reintentar el
 * mismo comando tras perder el ack, así que el `insert` es
 * `on conflict (household_id, id) do nothing` (la clave real de la tabla,
 * NUNCA `id` a secas: 0036 la declara `PRIMARY KEY (household_id, id)`)
 * seguido de un `select` que devuelve la misma fila si el conflicto saltó.
 * El choque de `name` se sigue comprobando ANTES del insert, excluyendo el
 * propio `id` objetivo: un reintento con el mismo id y el mismo nombre no es
 * una colisión.
 */
async function createFinanceEvent(
  client: PoolClient,
  householdId: UUID,
  payload: { id?: UUID | undefined; name: string },
): Promise<{ resourceId: UUID }> {
  const id = (payload.id ?? randomUUID()) as UUID;
  const clean = await cleanEventName(client, householdId, payload.name, id);
  await client.query(
    `insert into app.finance_events (id, household_id, name) values ($1, $2, $3)
       on conflict (household_id, id) do nothing`,
    [id, householdId, clean],
  );
  const result = await client.query<{ id: string }>(
    `select id from app.finance_events where household_id = $1 and id = $2`,
    [householdId, id],
  );
  const resourceId = result.rows[0]?.id;
  if (!resourceId) throw new Error("La inserción del evento no devolvió identificador");
  return { resourceId: resourceId as UUID };
}

async function deleteFinanceEvent(client: PoolClient, householdId: UUID, eventId: UUID): Promise<Record<string, never>> {
  await requireFinanceEvent(client, householdId, eventId);
  // Desvincula, no borra movimientos: el CASCADE de 0036 sobre event_id ya
  // borra por su cuenta finance_transaction_events y finance_event_rules —
  // no se repite a mano (R22).
  await client.query(`delete from app.finance_events where household_id = $1 and id = $2`, [householdId, eventId]);
  return {};
}

async function assignEventTransactions(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceEventAssignTransactionsPayload,
): Promise<Record<string, never>> {
  await requireFinanceEvent(client, householdId, payload.eventId);
  // Todo o nada, la misma semántica que `bulkUpdateFinanceTransactions`
  // (:397-412): un id ajeno, borrado o inexistente rechaza el comando entero en
  // vez de ignorarse en silencio. La comprobación de existencia va ANTES de
  // escribir Y antes de borrar: en el camino `remove` el `rowCount` del delete
  // no sirve de comprobación (un movimiento que existe puede no estar asignado
  // a este evento), así que se verifica con un `select` y solo entonces se
  // borra. Ids DISTINTOS, no la longitud cruda, para no penalizar duplicados.
  const distinctIds = [...new Set(payload.transactionIds)];
  const found = await client.query(
    `select id from app.finance_transactions where household_id = $1 and id = any($2::uuid[])`,
    [householdId, distinctIds],
  );
  if ((found.rowCount ?? 0) !== distinctIds.length) {
    throw new CommandRejectedError(
      "finance_transaction_not_found",
      (found.rowCount ?? 0) === 0
        ? "Ningún movimiento de la selección existe"
        : "Algún movimiento de la selección no existe en este hogar",
    );
  }
  if (payload.action === "remove") {
    await client.query(
      `delete from app.finance_transaction_events
        where household_id = $1 and event_id = $2 and transaction_id = any($3::uuid[])`,
      [householdId, payload.eventId, distinctIds],
    );
    return {};
  }
  // R22: una sola sentencia por conjuntos, nunca un bucle. Ya no hace falta
  // filtrar por hogar dentro del insert: la comprobación de arriba garantiza
  // que los ids son de este hogar (y sin ella, filtrar era justo lo que se
  // tragaba los ajenos en silencio).
  await client.query(
    `insert into app.finance_transaction_events (household_id, transaction_id, event_id)
     select $1, unnest($3::uuid[]), $2
     on conflict do nothing`,
    [householdId, payload.eventId, distinctIds],
  );
  return {};
}

async function resolveTargetEventId(
  client: PoolClient,
  householdId: UUID,
  eventId: UUID | null | undefined,
  newEventName: string | undefined,
): Promise<UUID | null> {
  if (newEventName !== undefined) {
    const name = newEventName.trim();
    const existing = await client.query<{ id: string }>(
      `select id from app.finance_events where household_id = $1 and lower(name) = lower($2)`,
      [householdId, name],
    );
    if (existing.rows[0]) return existing.rows[0].id as UUID;
    return (await createFinanceEvent(client, householdId, { name })).resourceId;
  }
  if (eventId != null) return requireFinanceEvent(client, householdId, eventId);
  return null;
}

/**
 * Asigna (o desasigna, con `eventId: null`) el evento que le toca a todo
 * movimiento que case con el selector proveedor/categoría(+concepto) —
 * espejo de `finance.transactions.assignConceptRecurrence` pero para
 * eventos— y deja escrita la regla en `finance_event_rules` para que el
 * pipeline (`matchEventRules`, `domain/finance/event-rules.ts`) seleccione
 * las MISMAS filas en las importaciones futuras: por eso `provider_norm`/
 * `concept_norm` se calculan con la MISMA composición que ese gemelo de
 * dominio usa para comparar (`normText` puro para proveedor,
 * `normText(normalizeConcept(...))` para concepto — nunca solo
 * `normalizeConcept`, que no pasa por mayúsculas/acentos), no con la del
 * propio payload sin tocar. Cadena vacía tras `trim()` → NULL, como hace
 * ya `createManualTransaction` con `provider_norm`.
 */
async function assignConceptToEvent(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceEventAssignConceptPayload,
): Promise<{ resourceId?: UUID }> {
  // La guarda de la categoría va POR DELANTE de todo lo que escribe (el evento
  // implícito de `newEventName`, el `delete` de la regla): un categoryId de otro
  // hogar se rechaza sin haber tocado nada, en vez de acusar `ok` porque el
  // selector no casó con ninguna fila (F5-I4).
  if (payload.categoryId) {
    await requireFinanceCategory(client, householdId, payload.categoryId);
  }
  const targetEventId = await resolveTargetEventId(client, householdId, payload.eventId, payload.newEventName);
  const txIds = await matchingFinanceTxIds(client, householdId, payload);

  // Borrar la regla existente es el MISMO paso se desasigne (targetEventId
  // === null) o se reasigne a otro evento: solo cambia si DESPUÉS hay un
  // insert. Escrito una única vez por selector (categoría o proveedor) para
  // que ambas ramas no puedan divergir en silencio sobre «qué cuenta como
  // la misma regla» — antes se repetían las mismas cuatro sentencias.
  if (payload.categoryId) {
    await client.query(`delete from app.finance_event_rules where household_id = $1 and category_id = $2`, [
      householdId,
      payload.categoryId,
    ]);
    if (targetEventId !== null) {
      await client.query(
        `insert into app.finance_event_rules (household_id, category_id, event_id) values ($1, $2, $3)`,
        [householdId, payload.categoryId, targetEventId],
      );
    }
  } else {
    // providerNorm/conceptNorm solo se calculan (y solo tienen sentido) en
    // el selector por proveedor, nunca en el de categoría.
    const providerNorm = payload.provider ? normText(payload.provider) : null;
    const conceptNorm = payload.concept ? normText(normalizeConcept(payload.concept)) : null;
    await client.query(
      `delete from app.finance_event_rules
        where household_id = $1 and provider_norm = $2 and concept_norm is not distinct from $3`,
      [householdId, providerNorm, conceptNorm],
    );
    if (targetEventId !== null) {
      await client.query(
        `insert into app.finance_event_rules (household_id, provider_norm, concept_norm, event_id)
         values ($1, $2, $3, $4)`,
        [householdId, providerNorm, conceptNorm, targetEventId],
      );
    }
  }

  if (targetEventId === null) {
    // Caso de borrado: la regla ya cayó arriba; ahora caen TODOS los
    // vínculos de los movimientos que casan.
    if (txIds.length > 0) {
      await client.query(
        `delete from app.finance_transaction_events where household_id = $1 and transaction_id = any($2::uuid[])`,
        [householdId, txIds],
      );
    }
    return {};
  }

  if (txIds.length > 0) {
    // Mover a un evento es EXCLUSIVO: el pivot agrupa por el primer evento asignado.
    await client.query(
      `delete from app.finance_transaction_events
        where household_id = $1 and transaction_id = any($2::uuid[]) and event_id <> $3`,
      [householdId, txIds, targetEventId],
    );
    await client.query(
      `insert into app.finance_transaction_events (household_id, transaction_id, event_id)
       select $1, unnest($2::uuid[]), $3
       on conflict do nothing`,
      [householdId, txIds, targetEventId],
    );
  }
  return { resourceId: targetEventId };
}

async function updateProviderAlias(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceAliasUpdatePayload,
): Promise<Record<string, never>> {
  const providerNorm = normText(payload.provider);
  if (!providerNorm) throw new CommandRejectedError("invalid_payload", "El proveedor no puede estar vacío");
  const display = payload.alias.trim();
  if (!display) {
    // Decisión (F5-I4): borrar un alias que no existe es un no-op ACEPTADO, no
    // un error — el selector es un proveedor, no un id de fila.
    await client.query(`delete from app.finance_provider_aliases where household_id = $1 and provider_norm = $2`, [
      householdId,
      providerNorm,
    ]);
    return {};
  }
  await client.query(
    `insert into app.finance_provider_aliases (household_id, provider_norm, display)
     values ($1, $2, $3)
     on conflict (household_id, provider_norm) do update set display = excluded.display`,
    [householdId, providerNorm, display],
  );
  return {};
}

async function updateFinanceAccount(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceAccountUpdatePayload,
): Promise<{ resourceId: UUID }> {
  await requireFinanceAccount(client, householdId, payload.accountId);
  // Solo columnas editables por comando: `bank`/`bank_ref` no aparecen aquí ni
  // en el esquema (`financeAccountUpdatePayloadSchema`) — se fijan al importar
  // y no se tocan por esta vía (resolución del coordinador).
  await client.query(
    `update app.finance_accounts
        set name = $3, kind = $4, owner_label = $5,
            owner_aliases = $6::jsonb, transfer_refs = $7::jsonb
      where household_id = $1 and id = $2`,
    [
      householdId,
      payload.accountId,
      payload.name,
      payload.accountKind,
      payload.ownerLabel,
      JSON.stringify(payload.ownerAliases),
      JSON.stringify(payload.transferRefs),
    ],
  );
  return { resourceId: payload.accountId };
}

async function createFinanceCategory(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceCategoryCreatePayload,
): Promise<{ resourceId: UUID }> {
  let kind: string = payload.categoryKind;
  if (payload.parentId) {
    const parent = await requireFinanceCategory(client, householdId, payload.parentId);
    if (parent.parent_id !== null) {
      throw new CommandRejectedError("invalid_payload", "El árbol de categorías es de dos niveles");
    }
    if (parent.kind === "transferencia") {
      throw new CommandRejectedError("finance_category_is_transfer", "La categoría de transferencias no tiene hijas");
    }
    kind = parent.kind; // la subcategoría hereda la naturaleza del padre, no el categoryKind del payload
  }
  const inserted = await client.query<{ id: string }>(
    `insert into app.finance_categories (household_id, name, kind, parent_id)
     values ($1, $2, $3, $4) returning id`,
    [householdId, payload.name, kind, payload.parentId],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("La inserción de la categoría no devolvió identificador");
  return { resourceId: id as UUID };
}

async function deleteFinanceCategory(
  client: PoolClient,
  householdId: UUID,
  categoryId: UUID,
): Promise<Record<string, never>> {
  const category = await requireFinanceCategory(client, householdId, categoryId);
  if (category.kind === "transferencia") {
    throw new CommandRejectedError("finance_category_is_transfer", "La categoría de transferencias no se borra");
  }
  const usage = await client.query<{ txs: number; children: number; rules: number; event_rules: number }>(
    `select
       (select count(*)::int from app.finance_transactions where household_id = $1 and category_id = $2) as txs,
       (select count(*)::int from app.finance_categories where household_id = $1 and parent_id = $2) as children,
       (select count(*)::int from app.finance_rules where household_id = $1 and category_id = $2) as rules,
       (select count(*)::int from app.finance_event_rules where household_id = $1 and category_id = $2) as event_rules`,
    [householdId, categoryId],
  );
  const counts = usage.rows[0];
  if (counts && (counts.txs > 0 || counts.children > 0 || counts.rules > 0 || counts.event_rules > 0)) {
    throw new CommandRejectedError(
      "finance_category_in_use",
      `Categoría en uso: ${counts.txs} movimientos, ${counts.children} subcategorías, ${counts.rules} reglas, ${counts.event_rules} eventos`,
    );
  }
  await client.query(`delete from app.finance_categories where household_id = $1 and id = $2`, [householdId, categoryId]);
  return {};
}

/**
 * Simetría con assignConceptToEvent: crear o recategorizar una regla manual
 * SUSTITUYE la regla previa del mismo patrón en vez de acumular reglas
 * gemelas con prioridad 0 entre las que el pipeline elegiría por orden
 * físico (F6-I1). Solo caen las reglas manuales: las de origen 'agente' y
 * las creadas desde Ajustes con otra prioridad no son «la misma regla». Los
 * dos sitios que crean una regla manual de prioridad 0 —recategorizar un
 * concepto desde Analítica y confirmar con regla desde la revisión— pasan
 * por aquí para que ninguno pueda divergir en silencio sobre esa semántica.
 */
async function replaceManualRule(
  client: PoolClient,
  householdId: UUID,
  ruleType: "proveedor_exacto" | "concepto_contiene",
  pattern: string,
  categoryId: UUID,
): Promise<UUID> {
  await client.query(
    `delete from app.finance_rules
      where household_id = $1 and rule_type = $2 and pattern = $3 and origin = 'manual' and priority = 0`,
    [householdId, ruleType, pattern],
  );
  const inserted = await client.query<{ id: string }>(
    `insert into app.finance_rules (household_id, rule_type, pattern, category_id, priority, origin)
     values ($1, $2, $3, $4, 0, 'manual') returning id`,
    [householdId, ruleType, pattern, categoryId],
  );
  const ruleId = inserted.rows[0]?.id;
  if (!ruleId) throw new Error("La regla manual no devolvió identificador");
  return ruleId;
}

/**
 * OJO: aquí `payload.categoryId` es la categoría DESTINO, no un selector. Si
 * se le pasara el payload entero, `matchingFinanceTxIds` tomaría la rama
 * `selector.categoryId` y recategorizaría los movimientos que YA están en el
 * destino, sin tocar los del proveedor pedido. Selector explícito, siempre.
 */
async function assignConceptToCategory(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceCategoryAssignConceptPayload,
): Promise<{ resourceId: UUID }> {
  const target = await requireFinanceCategory(client, householdId, payload.categoryId);
  if (target.kind === "transferencia") {
    throw new CommandRejectedError("finance_category_is_transfer", "No se puede recategorizar a transferencia");
  }
  const ids = await matchingFinanceTxIds(client, householdId, {
    provider: payload.provider,
    concept: payload.concept,
  });
  if (ids.length > 0) {
    // Los movimientos ya categorizados como transferencia no se tocan (en la
    // práctica ya vienen excluidos: matchingFinanceTxIds filtra
    // transfer_group_id is null cuando el selector es proveedor/concepto).
    await client.query(
      `update app.finance_transactions as tx
          set category_id = $3, status = 'confirmada'
        where tx.household_id = $1 and tx.id = any($2::uuid[])
          and not exists (
            select 1 from app.finance_categories as cat
             where cat.household_id = tx.household_id and cat.id = tx.category_id
               and cat.kind = 'transferencia')`,
      [householdId, ids, payload.categoryId],
    );
  }
  const ruleType = payload.concept === undefined ? "proveedor_exacto" : "concepto_contiene";
  const pattern = payload.concept === undefined ? payload.provider : payload.concept;
  const resourceId = await replaceManualRule(client, householdId, ruleType, pattern, payload.categoryId);
  return { resourceId };
}

async function undoImport(client: PoolClient, householdId: UUID, batchId: UUID): Promise<Record<string, never>> {
  const batch = await client.query(`select id from app.finance_import_batches where household_id = $1 and id = $2`, [
    householdId,
    batchId,
  ]);
  if ((batch.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("finance_batch_not_found", "Esa importación ya no existe");
  }
  await client.query(
    `delete from app.finance_transaction_events
      where household_id = $1 and transaction_id in (
        select id from app.finance_transactions where household_id = $1 and batch_id = $2)`,
    [householdId, batchId],
  );
  // ON DELETE CASCADE del esquema (0036 finance_transactions_batch_id_fkey):
  // borrar el lote se lleva sus transacciones por delante, espejos de
  // inversión incluidos (heredan el batch_id del cargo real: pipeline.ts,
  // "hereda el batch_id de su cargo — deshacer el lote lo arrastra").
  await client.query(`delete from app.finance_import_batches where household_id = $1 and id = $2`, [householdId, batchId]);
  return {};
}

/**
 * `finance`: todas las escrituras del módulo, discriminadas por `payload.kind`.
 *
 * Orden FIJO, no accidental:
 *   1. Se lee el `kind` del payload CRUDO (sin parsear con el esquema de
 *      escritura): grant/revoke son la puerta de fase 1 (`access.manage`,
 *      SIN concesión propia) y viven fuera del cerrojo por diseño.
 *   2. TODO lo demás pasa PRIMERO por `await requireFinanceAdmin(client,
 *      membership)`, antes incluso de validar la forma del payload. Así el
 *      cerrojo es estructural: ningún kind nuevo puede compilar sin cruzarlo,
 *      porque no hay manera de llegar al `switch` sin haberlo llamado.
 *   3. Solo entonces se valida con `financeWritePayloadSchema`.
 *   4. Y se despacha con un `switch` exhaustivo en tiempo de compilación: el
 *      `default` asigna `payload` a una variable `never` — si algún kind se
 *      queda sin `case`, el fichero deja de compilar. Las tareas siguientes
 *      de esta cadena sustituyen cada `case` "aún no implementado" por su
 *      lógica real, uno a uno, sin tocar la exhaustividad.
 */
export const financeCommandHandler: CommandHandler = async (client, membership, envelope) => {
  // Estrechado real (sin `as`, R7): `envelope.payload` es `unknown`; solo se
  // lee `kind` cuando el valor es de verdad un objeto con esa clave.
  const rawPayload = envelope.payload;
  const rawKind =
    typeof rawPayload === "object" && rawPayload !== null && "kind" in rawPayload
      ? rawPayload.kind
      : undefined;
  if (rawKind === "finance.grant.write" || rawKind === "finance.revoke.write") {
    return handleFinanceGrantCommand(client, membership, envelope);
  }

  await requireFinanceAdmin(client, membership);

  const parsed = financeWritePayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  switch (payload.kind) {
    case "finance.transaction.update":
      return updateFinanceTransaction(client, envelope.householdId, payload);
    case "finance.transactions.bulk":
      return bulkUpdateFinanceTransactions(client, envelope.householdId, payload);
    case "finance.transactions.assignConceptRecurrence":
      return assignConceptRecurrence(client, envelope.householdId, payload);
    case "finance.transaction.manual.create":
      return createManualTransaction(client, envelope.householdId, payload);
    case "finance.transaction.manual.delete":
      return deleteManualTransaction(client, envelope.householdId, payload);
    case "finance.transaction.invest":
      return investTransaction(client, envelope.householdId, payload);
    case "finance.transfers.link":
      return linkTransfers(client, envelope.householdId, payload);
    case "finance.transfers.unlink":
      return unlinkTransfers(client, envelope.householdId, payload);
    case "finance.event.create":
      return createFinanceEvent(client, envelope.householdId, payload);
    case "finance.event.update": {
      await requireFinanceEvent(client, envelope.householdId, payload.eventId);
      const clean = await cleanEventName(client, envelope.householdId, payload.name, payload.eventId);
      await client.query(`update app.finance_events set name = $3 where household_id = $1 and id = $2`, [
        envelope.householdId,
        payload.eventId,
        clean,
      ]);
      return { resourceId: payload.eventId };
    }
    case "finance.event.delete":
      return deleteFinanceEvent(client, envelope.householdId, payload.eventId);
    case "finance.event.assignTransactions":
      return assignEventTransactions(client, envelope.householdId, payload);
    case "finance.event.assignConcept":
      return assignConceptToEvent(client, envelope.householdId, payload);
    case "finance.alias.update":
      return updateProviderAlias(client, envelope.householdId, payload);
    case "finance.account.update":
      return updateFinanceAccount(client, envelope.householdId, payload);
    case "finance.category.create":
      return createFinanceCategory(client, envelope.householdId, payload);
    case "finance.category.update": {
      await requireFinanceCategory(client, envelope.householdId, payload.categoryId);
      await client.query(`update app.finance_categories set name = $3 where household_id = $1 and id = $2`, [
        envelope.householdId,
        payload.categoryId,
        payload.name,
      ]);
      return { resourceId: payload.categoryId };
    }
    case "finance.category.delete":
      return deleteFinanceCategory(client, envelope.householdId, payload.categoryId);
    case "finance.category.assignConcept":
      return assignConceptToCategory(client, envelope.householdId, payload);
    case "finance.rule.create": {
      const target = await requireFinanceCategory(client, envelope.householdId, payload.categoryId);
      if (target.kind === "transferencia") {
        throw new CommandRejectedError("finance_category_is_transfer", "Las reglas no apuntan a transferencia");
      }
      // R15 (resolución del coordinador): cuando el payload no trae
      // `priority`, el INSERT omite la columna para que mande el DEFAULT de
      // la tabla (100) — nunca 0 a secas, que colocaría a esta regla suelta
      // en un escalón de precedencia distinto al de cualquier otra regla
      // manual (domain/finance/rules.ts ordena por `priority` al resolver
      // empates). `pattern` se recorta a 200 antes de insertar, igual que
      // exige el CHECK de la tabla (0036), aunque el esquema ya lo acote a esa
      // misma longitud.
      const pattern = payload.pattern.slice(0, 200);
      const inserted =
        payload.priority === undefined
          ? await client.query<{ id: string }>(
              `insert into app.finance_rules (household_id, rule_type, pattern, category_id, origin)
               values ($1, $2, $3, $4, 'manual') returning id`,
              [envelope.householdId, payload.ruleType, pattern, payload.categoryId],
            )
          : await client.query<{ id: string }>(
              `insert into app.finance_rules (household_id, rule_type, pattern, category_id, priority, origin)
               values ($1, $2, $3, $4, $5, 'manual') returning id`,
              [envelope.householdId, payload.ruleType, pattern, payload.categoryId, payload.priority],
            );
      return { resourceId: inserted.rows[0]?.id as UUID };
    }
    case "finance.rule.delete": {
      const deleted = await client.query(`delete from app.finance_rules where household_id = $1 and id = $2`, [
        envelope.householdId,
        payload.ruleId,
      ]);
      if ((deleted.rowCount ?? 0) === 0) {
        throw new CommandRejectedError("finance_rule_not_found", "La regla ya no existe");
      }
      return {};
    }
    case "finance.import.undo":
      return undoImport(client, envelope.householdId, payload.batchId);
    default: {
      const _exhaustive: never = payload;
      throw new CommandRejectedError("invalid_payload", "Comando de finanzas desconocido");
    }
  }
};

/** Mapa de handlers de finanzas listo para la ruta de sync. */
export const financeCommandHandlers: CommandHandlers = {
  finance: financeCommandHandler,
};
