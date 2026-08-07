import type { PoolClient } from "pg";

import {
  API_VERSION,
  type CommandAckV1,
  type CommandEnvelopeV1,
  type UUID,
} from "@casa-clara/contracts";

import { canonicalSha256 } from "./canonical-json.js";

export class IdempotencyConflictError extends Error {
  override readonly name = "IdempotencyConflictError";
}

export async function executeIdempotentCommand(
  client: PoolClient,
  command: CommandEnvelopeV1,
  actorId: UUID,
  handler: () => Promise<Omit<CommandAckV1, "operationId">>,
): Promise<CommandAckV1> {
  const payloadHash = canonicalSha256(command);
  const receipt = await client.query<{
    payload_hash: string;
    result: CommandAckV1 | null;
  }>(`select payload_hash, result
      from app.command_receipts
      where household_id = $1 and operation_id = $2
      for update`, [command.householdId, command.operationId]);
  const previous = receipt.rows[0];
  if (previous) {
    if (previous.payload_hash !== payloadHash) {
      throw new IdempotencyConflictError("operationId reutilizado con contenido diferente");
    }
    if (previous.result) return { ...previous.result, status: "duplicate" };
  } else {
    await client.query(
      `insert into app.command_receipts
         (household_id, operation_id, actor_user_id, payload_hash, api_version, received_at)
       values ($1, $2, $3, $4, $5, now())`,
      [command.householdId, command.operationId, actorId, payloadHash, API_VERSION],
    );
  }

  const result: CommandAckV1 = { operationId: command.operationId, ...(await handler()) };
  await client.query(
    `update app.command_receipts
     set result = $3::jsonb, completed_at = now()
     where household_id = $1 and operation_id = $2`,
    [command.householdId, command.operationId, JSON.stringify(result)],
  );
  return result;
}
