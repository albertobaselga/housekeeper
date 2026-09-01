import type { Pool, PoolClient } from "pg";

import type { Role, UUID } from "@housekeeper/contracts";

export interface AuthenticatedPrincipal {
  userId: UUID;
}

export interface ActiveMembership {
  id: UUID;
  householdId: UUID;
  role: Role;
  expiresAt: string | null;
}

export class AuthorizationError extends Error {
  override readonly name = "AuthorizationError";
}

export async function withAuthorizedTransaction<T>(
  pool: Pool,
  principal: AuthenticatedPrincipal,
  householdId: UUID,
  operation: (client: PoolClient, membership: ActiveMembership) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.user_id', $1, true)", [principal.userId]);
    const result = await client.query<{
      id: string;
      household_id: string;
      role: Role;
      expires_at: Date | null;
    }>(`select id, household_id, role, expires_at
        from app.household_memberships
        where user_id = $1
          and household_id = $2
          and starts_at <= now()
          and revoked_at is null
          and (expires_at is null or expires_at > now())
        limit 1`, [principal.userId, householdId]);
    const row = result.rows[0];
    if (!row) throw new AuthorizationError("Membresía inexistente, revocada o caducada");

    const membership: ActiveMembership = {
      id: row.id,
      householdId: row.household_id,
      role: row.role,
      expiresAt: row.expires_at?.toISOString() ?? null,
    };
    await client.query("select app.set_household_context($1, $2)", [membership.householdId, membership.id]);

    const value = await operation(client, membership);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
