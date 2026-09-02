import type { PoolClient } from "pg";

import type { UUID } from "@housekeeper/contracts";
import { membershipCommandPayloadSchema } from "@housekeeper/contracts/schemas";

import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler, type CommandHandlers } from "../sync.js";

/**
 * Estado del acceso objetivo leído bajo la RLS del administrador
 * (memberships_admin_read): fuera del hogar en contexto la fila no es visible
 * y "no existe" y "no es tuya" colapsan en el mismo rechazo.
 */
interface TargetMembership {
  id: UUID;
  revoked: boolean;
}

async function requireTargetMembership(
  client: PoolClient,
  householdId: UUID,
  membershipId: UUID,
): Promise<TargetMembership> {
  const result = await client.query<{ id: string; revoked: boolean }>(
    `select id, revoked_at is not null as revoked
       from app.household_memberships
      where household_id = $1 and id = $2`,
    [householdId, membershipId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CommandRejectedError("membership_not_found", "La membresía no existe en este hogar");
  }
  return { id: row.id, revoked: row.revoked };
}

async function setExpiry(
  client: PoolClient,
  householdId: UUID,
  membershipId: UUID,
  expiresAt: string | null,
): Promise<{ resourceId: UUID }> {
  const target = await requireTargetMembership(client, householdId, membershipId);
  if (target.revoked) {
    // Un acceso revocado ya está muerto: su caducidad no se reprograma.
    throw new CommandRejectedError("already_revoked", "La membresía ya está revocada");
  }
  if (expiresAt !== null) {
    // El reloj que manda es el de la base (statement_timestamp()), el mismo
    // contra el que la RLS decide si la membresía sigue viva.
    const past = await client.query<{ past: boolean }>(
      "select $1::timestamptz <= statement_timestamp() as past",
      [expiresAt],
    );
    if (past.rows[0]?.past) {
      throw new CommandRejectedError("expiry_in_past", "La caducidad debe ser una fecha futura");
    }
  }
  // El CHECK de la tabla (expires_at > starts_at) sigue vigilando el caso
  // residual de un starts_at futuro; su violación sale como constraint_violation.
  const updated = await client.query(
    `update app.household_memberships
        set expires_at = $3, updated_at = statement_timestamp()
      where household_id = $1 and id = $2 and revoked_at is null`,
    [householdId, membershipId, expiresAt],
  );
  if ((updated.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("membership_not_found", "La membresía no existe en este hogar");
  }
  return { resourceId: membershipId };
}

async function revoke(
  client: PoolClient,
  householdId: UUID,
  membershipId: UUID,
): Promise<{ resourceId: UUID }> {
  const revoked = await client.query(
    `update app.household_memberships
        set revoked_at = statement_timestamp(), updated_at = statement_timestamp()
      where household_id = $1 and id = $2 and revoked_at is null`,
    [householdId, membershipId],
  );
  if ((revoked.rowCount ?? 0) === 0) {
    const target = await requireTargetMembership(client, householdId, membershipId);
    if (target.revoked) {
      // Consciente de la idempotencia: el reintento no re-sella revoked_at,
      // pero el ACK distingue "ya estaba revocada" de una revocación nueva.
      throw new CommandRejectedError("already_revoked", "La membresía ya está revocada");
    }
    throw new CommandRejectedError("membership_not_found", "La membresía no existe en este hogar");
  }
  return { resourceId: membershipId };
}

/**
 * `membership` (F4-03, solo family_admin; la RLS memberships_admin_update lo
 * respalda en la base): caducidad programada (set_expiry con fecha futura o
 * null para retirarla) y revocación inmediata. Como cada petición vuelve a
 * resolver la membresía bajo RLS (withAuthorizedTransaction / resolveAppUser),
 * fijar revoked_at o un expires_at vencido corta el acceso al instante sin más
 * fontanería. Un administrador nunca puede caducarse o revocarse a sí mismo:
 * el hogar no se queda sin administración por un despiste.
 */
export const membershipCommandHandler: CommandHandler = async (client, membership, envelope) => {
  const parsed = membershipCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  requireAdmin(membership);
  const payload = parsed.data;
  if (payload.membershipId === membership.id) {
    throw new CommandRejectedError(
      "cannot_modify_self",
      "Un administrador no puede caducar ni revocar su propio acceso",
    );
  }
  switch (payload.action) {
    case "set_expiry":
      return setExpiry(client, envelope.householdId, payload.membershipId, payload.expiresAt);
    case "revoke":
      return revoke(client, envelope.householdId, payload.membershipId);
  }
};

function requireAdmin(membership: ActiveMembership): void {
  if (membership.role !== "family_admin") {
    throw new CommandRejectedError("not_allowed", "Solo la familia administradora gestiona los accesos");
  }
}

/** Mapa de handlers de accesos (oleada 5) listo para la ruta de sync. */
export const accessCommandHandlers: CommandHandlers = {
  membership: membershipCommandHandler,
};
