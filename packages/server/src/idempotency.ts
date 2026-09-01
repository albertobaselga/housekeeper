import type { PoolClient } from "pg";

import {
  type CommandAckV1,
  type CommandEnvelopeV1,
  type UUID,
} from "@housekeeper/contracts";

import { canonicalSha256 } from "./canonical-json.js";

export class IdempotencyConflictError extends Error {
  override readonly name = "IdempotencyConflictError";
}

export async function executeIdempotentCommand(
  client: PoolClient,
  command: CommandEnvelopeV1,
  actorMembershipId: UUID,
  handler: () => Promise<Omit<CommandAckV1, "operationId">>,
): Promise<CommandAckV1> {
  const payloadHash = canonicalSha256(command);
  // app.command_receipts es append-only: el recibo se escribe una sola vez, con su
  // resultado final, en la misma transacción que las escrituras de dominio. El
  // advisory lock serializa reintentos concurrentes de la misma operación para que
  // el segundo ejecutor observe el recibo ya confirmado en lugar de duplicar trabajo.
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
    [command.householdId, command.operationId],
  );
  const receipt = await client.query<{
    payload_hash: string;
    result: CommandAckV1;
  }>(`select payload_hash, result
      from app.command_receipts
      where household_id = $1 and operation_id = $2`, [command.householdId, command.operationId]);
  const previous = receipt.rows[0];
  if (previous) {
    if (previous.payload_hash !== payloadHash) {
      throw new IdempotencyConflictError("operationId reutilizado con contenido diferente");
    }
    return { ...previous.result, status: "duplicate" };
  }

  const result: CommandAckV1 = { operationId: command.operationId, ...(await handler()) };
  await client.query(
    `insert into app.command_receipts
       (household_id, operation_id, command_type, payload_hash, result, actor_membership_id)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      command.householdId,
      command.operationId,
      command.aggregateType,
      payloadHash,
      JSON.stringify(result),
      actorMembershipId,
    ],
  );
  return result;
}
