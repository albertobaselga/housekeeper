import { describe, expect, it } from "vitest";

import {
  API_VERSION,
  assertSnapshotFresh,
  hasCapability,
  isMoneyCents,
  isRole,
  type CriticalSnapshotV1,
} from "./index.js";
import {
  agreementCommandPayloadSchema,
  commandEnvelopeSchema,
  vacationCommandPayloadSchema,
} from "./schemas.js";

const snapshot = (generatedAt: string, expiresAt: string): CriticalSnapshotV1 => ({
  apiVersion: API_VERSION,
  schemaVersion: 1,
  householdId: "household",
  membershipId: "membership",
  version: "1",
  etag: "etag",
  cursor: "cursor",
  generatedAt,
  expiresAt,
  signature: "signature",
  payload: {
    emergency: [],
    contacts: [],
    dietaryFlags: [],
    today: {},
    wikiPages: [],
  },
});

describe("contratos públicos", () => {
  it("deniega roles desconocidos", () => {
    expect(isRole("family_admin")).toBe(true);
    expect(isRole("owner")).toBe(false);
  });

  it("aplica permisos mínimos a helper y viewer", () => {
    expect(hasCapability("helper", "content.read")).toBe(true);
    expect(hasCapability("helper", "settlement.read")).toBe(false);
    expect(hasCapability("viewer", "calendar.read")).toBe(true);
    expect(hasCapability("viewer", "menu.read")).toBe(false);
  });

  it("representa dinero como céntimos enteros serializables", () => {
    expect(isMoneyCents("145330")).toBe(true);
    expect(isMoneyCents("-10000")).toBe(true);
    expect(isMoneyCents("14.53")).toBe(false);
  });

  it("valida el envelope compartido en tiempo de ejecución", () => {
    expect(commandEnvelopeSchema.safeParse({
      apiVersion: 1,
      operationId: "d9ea93f9-0373-42c9-bde6-3c84ce96f8f4",
      householdId: "47959c6f-390f-4a67-9fd9-9e8f2f5a4512",
      schemaVersion: 1,
      aggregateType: "expense",
      aggregateId: null,
      baseRevision: null,
      occurredAt: "2026-08-07T10:00:00+02:00",
      payload: { amountCents: "4730" },
    }).success).toBe(true);
  });

  it("acepta un periodo de vacaciones bien formado y rechaza el que acaba antes de empezar", () => {
    const base = {
      action: "record" as const,
      agreementId: "12000000-0000-4000-8000-000000000001",
      note: "Quincena de agosto",
    };
    expect(
      vacationCommandPayloadSchema.safeParse({ ...base, startsOn: "2026-08-01", endsOn: "2026-08-15" })
        .success,
    ).toBe(true);
    // Un solo día es un periodo válido: el descanso de un día también se apunta.
    expect(
      vacationCommandPayloadSchema.safeParse({ ...base, startsOn: "2026-08-01", endsOn: "2026-08-01" })
        .success,
    ).toBe(true);
    expect(
      vacationCommandPayloadSchema.safeParse({ ...base, startsOn: "2026-08-15", endsOn: "2026-08-01" })
        .success,
    ).toBe(false);
    // Más de un año seguido no es un periodo de vacaciones: es un dedazo.
    expect(
      vacationCommandPayloadSchema.safeParse({ ...base, startsOn: "2026-01-01", endsOn: "2027-06-01" })
        .success,
    ).toBe(false);
  });

  it("exige motivo para anular un periodo apuntado", () => {
    const base = {
      action: "void" as const,
      vacationPeriodId: "da100000-0000-4000-8000-000000000001",
    };
    expect(vacationCommandPayloadSchema.safeParse({ ...base, reason: "Fechas mal" }).success).toBe(true);
    expect(vacationCommandPayloadSchema.safeParse({ ...base, reason: "   " }).success).toBe(false);
    expect(vacationCommandPayloadSchema.safeParse(base).success).toBe(false);
  });

  it("acota el derecho anual de vacaciones a días naturales enteros de un año", () => {
    const base = {
      action: "set_vacation_entitlement" as const,
      agreementId: "12000000-0000-4000-8000-000000000001",
      effectiveFrom: "2026-09-01",
      reason: "Convenio del hogar",
    };
    expect(agreementCommandPayloadSchema.safeParse({ ...base, annualVacationDays: 30 }).success).toBe(true);
    expect(agreementCommandPayloadSchema.safeParse({ ...base, annualVacationDays: 0 }).success).toBe(true);
    expect(agreementCommandPayloadSchema.safeParse({ ...base, annualVacationDays: 366 }).success).toBe(false);
    expect(agreementCommandPayloadSchema.safeParse({ ...base, annualVacationDays: -1 }).success).toBe(false);
    expect(agreementCommandPayloadSchema.safeParse({ ...base, annualVacationDays: 22.5 }).success).toBe(false);
  });

  it("rechaza snapshots con concesiones superiores a 24 horas", () => {
    const now = Date.parse("2026-08-07T10:00:00.000Z");
    expect(() =>
      assertSnapshotFresh(
        snapshot("2026-08-07T09:00:00.000Z", "2026-08-08T09:00:01.000Z"),
        now,
      ),
    ).toThrow(/24 horas/);
  });
});
