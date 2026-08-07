import type { Pool, PoolClient } from "pg";

import {
  API_VERSION,
  type AggregateType,
  type CommandAckV1,
  type CommandEnvelopeV1,
  type SyncResultV1,
  type UUID,
} from "@casa-clara/contracts";
import { commandEnvelopeSchema } from "@casa-clara/contracts/schemas";

import {
  AuthorizationError,
  withAuthorizedTransaction,
  type ActiveMembership,
  type AuthenticatedPrincipal,
} from "./database.js";
import { IdempotencyConflictError, executeIdempotentCommand } from "./idempotency.js";

export class CommandRejectedError extends Error {
  override readonly name = "CommandRejectedError";
  constructor(readonly errorCode: string, message?: string) {
    super(message ?? errorCode);
  }
}

/**
 * Conflicto que requiere resolución humana (p. ej. edición wiki sobre una
 * revisión ya superada): el ACK es `conflict`, no `rejected`, para que el
 * cliente ofrezca resolver en vez de descartar el comando.
 */
export class CommandConflictError extends Error {
  override readonly name = "CommandConflictError";
  constructor(readonly errorCode: string, message?: string) {
    super(message ?? errorCode);
  }
}

export type CommandHandler = (
  client: PoolClient,
  membership: ActiveMembership,
  envelope: CommandEnvelopeV1,
) => Promise<Omit<CommandAckV1, "operationId" | "status"> & { status?: "accepted" }>;

export type CommandHandlers = Partial<Record<AggregateType, CommandHandler>>;

const RETRYABLE_PG_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "57P03", // cannot_connect_now
]);

function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return typeof code === "string" && /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)$/.test(code);
}

function ackForError(operationId: UUID, error: unknown): CommandAckV1 {
  if (error instanceof AuthorizationError) {
    return { operationId, status: "rejected", errorCode: "not_authorized" };
  }
  if (error instanceof IdempotencyConflictError) {
    return { operationId, status: "conflict", errorCode: "operation_conflict" };
  }
  if (error instanceof CommandConflictError) {
    return { operationId, status: "conflict", errorCode: error.errorCode };
  }
  if (error instanceof CommandRejectedError) {
    return { operationId, status: "rejected", errorCode: error.errorCode };
  }
  const pgCode = (error as { code?: string }).code;
  if (typeof pgCode === "string" && /^(23|22|55)/.test(pgCode)) {
    return { operationId, status: "rejected", errorCode: "constraint_violation" };
  }
  if (isConnectionError(error) || (typeof pgCode === "string" && RETRYABLE_PG_CODES.has(pgCode))) {
    return { operationId, status: "retryable", errorCode: "transient", retryAfterSeconds: 30 };
  }
  return { operationId, status: "retryable", errorCode: "internal", retryAfterSeconds: 60 };
}

/**
 * Procesa un lote de comandos con ACK parcial: cada envelope se valida, autoriza y
 * ejecuta de forma independiente dentro de su propia transacción idempotente. Un
 * fallo en un comando nunca bloquea el resto del lote.
 */
export async function processSyncBatch(
  pool: Pool,
  principal: AuthenticatedPrincipal,
  commands: readonly unknown[],
  handlers: CommandHandlers,
): Promise<SyncResultV1> {
  const acknowledgements: CommandAckV1[] = [];

  for (const candidate of commands) {
    const parsed = commandEnvelopeSchema.safeParse(candidate);
    if (!parsed.success) {
      const rawOperationId = (candidate as { operationId?: unknown })?.operationId;
      if (typeof rawOperationId === "string" && /^[0-9a-f-]{36}$/i.test(rawOperationId)) {
        acknowledgements.push({
          operationId: rawOperationId,
          status: "rejected",
          errorCode: "invalid_envelope",
        });
        continue;
      }
      throw new CommandRejectedError("invalid_envelope", "Comando sin operationId identificable");
    }
    const envelope = parsed.data as CommandEnvelopeV1;

    const handler = handlers[envelope.aggregateType];
    if (!handler) {
      acknowledgements.push({
        operationId: envelope.operationId,
        status: "rejected",
        errorCode: "unsupported_aggregate",
      });
      continue;
    }

    try {
      const ack = await withAuthorizedTransaction(
        pool,
        principal,
        envelope.householdId,
        (client, membership) =>
          executeIdempotentCommand(client, envelope, membership.id, async () => {
            const result = await handler(client, membership, envelope);
            return { status: "accepted", ...result };
          }),
      );
      acknowledgements.push(ack);
    } catch (error) {
      acknowledgements.push(ackForError(envelope.operationId, error));
    }
  }

  return {
    apiVersion: API_VERSION,
    acknowledgements,
    nextCursor: new Date().toISOString(),
    snapshotVersion: null,
  };
}
