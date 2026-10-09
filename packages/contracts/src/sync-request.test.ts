import { describe, expect, it } from "vitest";

import { API_VERSION, MAX_SYNC_COMMANDS } from "./index.js";
import { syncRequestSchema } from "./schemas.js";

/**
 * `syncRequestSchema` mira la FORMA del lote y nada más: versión y una lista de
 * 1 a MAX_SYNC_COMMANDS comandos. Cada sobre lo valida `processSyncBatch` por
 * separado, que es quien puede rechazar uno solo («invalid_envelope»,
 * «unsupported_aggregate») y seguir con los demás.
 *
 * Si el esquema del lote validara los sobres, un solo comando de un agregado
 * que este servidor no conoce tumbaría el lote entero con un 422, y con él los
 * comandos de los demás módulos que viajan juntos (revisión final de cupones,
 * H1: el caso es volver a un despliegue anterior con comandos nuevos en cola).
 */
const envelope = (aggregateType: string) => ({
  apiVersion: API_VERSION,
  operationId: "11111111-1111-4111-8111-111111111111",
  householdId: "22222222-2222-4222-8222-222222222222",
  schemaVersion: 1,
  aggregateType,
  aggregateId: null,
  baseRevision: null,
  occurredAt: "2026-10-09T10:00:00Z",
  payload: {},
});

describe("syncRequestSchema", () => {
  it("deja pasar un lote con un agregado que este servidor no conoce", () => {
    const parsed = syncRequestSchema.safeParse({
      apiVersion: API_VERSION,
      commands: [envelope("menu_slot"), envelope("modulo_del_futuro")],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.commands).toHaveLength(2);
  });

  it("deja pasar un sobre deforme: lo rechaza processSyncBatch, de uno en uno", () => {
    const parsed = syncRequestSchema.safeParse({ apiVersion: API_VERSION, commands: [{ operationId: 7 }] });
    expect(parsed.success).toBe(true);
  });

  it("sigue exigiendo la versión y un lote de 1 a MAX_SYNC_COMMANDS", () => {
    expect(syncRequestSchema.safeParse({ apiVersion: 999, commands: [envelope("coupon")] }).success).toBe(false);
    expect(syncRequestSchema.safeParse({ apiVersion: API_VERSION, commands: [] }).success).toBe(false);
    expect(
      syncRequestSchema.safeParse({
        apiVersion: API_VERSION,
        commands: Array.from({ length: MAX_SYNC_COMMANDS + 1 }, () => envelope("coupon")),
      }).success,
    ).toBe(false);
    expect(syncRequestSchema.safeParse({ apiVersion: API_VERSION }).success).toBe(false);
  });
});
