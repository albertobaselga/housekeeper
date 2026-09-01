import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import { hasCapability } from "@casa-clara/contracts/capabilities";
import { financeCommandPayloadSchema } from "@casa-clara/contracts/schemas";

import type { ActiveMembership } from "../database.js";
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
    // El disparador finance_module_grants_target_guard (0034) respalda esta
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

export const financeCommandHandler: CommandHandler = async (client, membership, envelope) => {
  const parsed = financeCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  // La autorización va DENTRO de cada `case`, NUNCA antes del `switch`.
  // `requireAccessManagingAdmin` es la puerta de conceder/revocar: rol
  // administrador con access.manage, SIN concesión propia. Cualquier kind que
  // añadan las fases siguientes (transacciones, importación, eventos…) empieza
  // por `await requireFinanceAdmin(client, membership)` — el doble cerrojo. Si
  // esta llamada estuviera antes del switch, todos esos comandos heredarían la
  // puerta floja en silencio y en el servidor solo quedaría la RLS.
  switch (payload.kind) {
    case "finance.grant.write":
      requireAccessManagingAdmin(membership);
      return grantFinance(client, envelope.householdId, membership, payload.membershipId);
    case "finance.revoke.write":
      requireAccessManagingAdmin(membership);
      return revokeFinance(client, envelope.householdId, membership, payload.membershipId);
  }
};

/** Mapa de handlers de finanzas listo para la ruta de sync. */
export const financeCommandHandlers: CommandHandlers = {
  finance: financeCommandHandler,
};
