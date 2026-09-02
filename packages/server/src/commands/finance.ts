import type { PoolClient } from "pg";

import type { CommandEnvelopeV1, UUID } from "@housekeeper/contracts";
import { hasCapability } from "@housekeeper/contracts/capabilities";
import { financeCommandPayloadSchema, financeWritePayloadSchema } from "@housekeeper/contracts/schemas";
import { normalizeConcept, normText } from "@housekeeper/domain/finance";

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

// Helper interno para las tareas 3-5 de esta cadena (mismo fichero); ningún
// `case` de esta tarea lo llama todavía, pero manual.create/invest/transfers.link sí lo harán.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function transferCategoryId(client: PoolClient, householdId: UUID): Promise<UUID> {
  const result = await client.query<{ id: string }>(
    `select id from app.finance_categories
      where household_id = $1 and kind = 'transferencia' and parent_id is null`,
    [householdId],
  );
  const row = result.rows[0];
  if (!row) throw new CommandRejectedError("finance_category_not_found", "El hogar no tiene categoría de transferencia");
  return row.id;
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
  for (const eventId of wanted) {
    await client.query(
      `insert into app.finance_transaction_events (household_id, transaction_id, event_id) values ($1, $2, $3)`,
      [householdId, transactionId, eventId],
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
    await client.query(
      `insert into app.finance_rules (household_id, rule_type, pattern, category_id, priority, origin)
       values ($1, $2, $3, $4, 0, 'manual')`,
      [householdId, payload.createRule.ruleType, pattern, finalCategory],
    );
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
  const result = await client.query(
    `update app.finance_transactions as tx
        set status = coalesce($3, tx.status), category_id = coalesce($4::uuid, tx.category_id)
       from unnest($2::uuid[]) as ids(id)
      where tx.household_id = $1 and tx.id = ids.id`,
    [householdId, payload.transactionIds, payload.status ?? null, payload.categoryId ?? null],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("finance_transaction_not_found", "Ningún movimiento de la selección existe");
  }
  return {};
}

async function assignConceptRecurrence(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceAssignConceptRecurrencePayload,
): Promise<Record<string, never>> {
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
  const rawKind = (envelope.payload as { kind?: unknown } | null)?.kind;
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
    case "finance.account.update":
    case "finance.category.create":
    case "finance.category.update":
    case "finance.category.delete":
    case "finance.category.assignConcept":
    case "finance.rule.create":
    case "finance.rule.delete":
    case "finance.transaction.manual.create":
    case "finance.transaction.manual.delete":
    case "finance.transaction.invest":
    case "finance.transfers.link":
    case "finance.transfers.unlink":
    case "finance.event.create":
    case "finance.event.update":
    case "finance.event.delete":
    case "finance.event.assignTransactions":
    case "finance.event.assignConcept":
    case "finance.alias.update":
    case "finance.import.undo":
      // Tareas 3, 4 y 5 de esta cadena sustituyen cada uno de estos `case`
      // por su implementación real. Hasta entonces el kind está reconocido
      // por el esquema (y por tanto por el cerrojo de arriba) pero sin
      // manejar todavía: no es un agujero de autorización, es trabajo
      // pendiente explícito.
      throw new CommandRejectedError(
        "invalid_payload",
        `Comando de finanzas aún no implementado: ${payload.kind}`,
      );
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
