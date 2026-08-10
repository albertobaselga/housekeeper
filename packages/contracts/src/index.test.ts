import { describe, expect, it } from "vitest";

import { hasCapability, isRole } from "./capabilities.js";
import * as barrel from "./index.js";
import {
  API_VERSION,
  assertSnapshotFresh,
  isMoneyCents,
  type CriticalSnapshotV1,
} from "./index.js";
import {
  agreementCommandPayloadSchema,
  agreementCreateInputSchema,
  agreementTermsInputSchema,
  commandEnvelopeSchema,
  extraWorkCommandPayloadSchema,
  extraWorkTypeInputSchema,
  recurringSupplementInputSchema,
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
  /**
   * El barril lo carga TODA pantalla del cliente (de aquí sale `canonicalJson`,
   * que verifica la firma del paquete offline al arrancar). El troceo reparte
   * por alcanzabilidad de módulo, así que reexportar aquí el modelo de
   * autorización devuelve sus ~1,2 kB de tablas al arranque de Hoy aunque nadie
   * las use. Esta prueba es la versión rápida de la guarda que
   * `apps/web/scripts/verify-today-bundle.mjs` aplica sobre el paquete ya
   * construido: falla en segundos, sin necesitar una construcción entera.
   */
  it("no reexporta el modelo de autorización: vive en @casa-clara/contracts/capabilities", () => {
    expect(Object.keys(barrel).sort()).toEqual([
      "API_VERSION",
      "CRITICAL_SNAPSHOT_TTL_MS",
      "MAX_SYNC_COMMANDS",
      "assertSnapshotFresh",
      "canonicalJson",
      "isMoneyCents",
    ]);
  });

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

  it("acepta el concepto del catálogo al registrar trabajo extra, y lo exige bien formado", () => {
    const base = {
      action: "register" as const,
      agreementId: "12000000-0000-4000-8000-000000000001",
      kind: "worked_rest_day" as const,
      workedOn: "2026-08-08",
      durationMinutes: 480,
    };
    // Sin concepto sigue valiendo: es el histórico anterior a 0021.
    expect(extraWorkCommandPayloadSchema.safeParse(base).success).toBe(true);
    expect(
      extraWorkCommandPayloadSchema.safeParse({
        ...base,
        extraWorkTypeId: "13000000-0000-4000-8000-000000000004",
      }).success,
    ).toBe(true);
    expect(
      extraWorkCommandPayloadSchema.safeParse({ ...base, extraWorkTypeId: "jornada-extra" }).success,
    ).toBe(false);
  });

  it("una jornada tiene que decir de cuántas horas es; una tarifa por hora, no", () => {
    const base = { code: "jornada_extra", name: "Jornada extra", rateCents: "5000", active: true };
    expect(
      extraWorkTypeInputSchema.safeParse({ ...base, unit: "per_shift", referenceMinutes: 600 })
        .success,
    ).toBe(true);
    expect(
      extraWorkTypeInputSchema.safeParse({ ...base, unit: "per_shift", referenceMinutes: null })
        .success,
    ).toBe(false);
    expect(
      extraWorkTypeInputSchema.safeParse({ ...base, unit: "per_hour", referenceMinutes: 600 })
        .success,
    ).toBe(false);
    // Un concepto pactado sin tarifa es legítimo: la empleada no lo verá.
    expect(
      extraWorkTypeInputSchema.safeParse({
        ...base,
        unit: "fixed_amount",
        rateCents: null,
        referenceMinutes: null,
      }).success,
    ).toBe(true);
    expect(
      extraWorkTypeInputSchema.safeParse({
        ...base,
        unit: "fixed_amount",
        rateCents: "-1",
        referenceMinutes: null,
      }).success,
    ).toBe(false);
  });

  it("un complemento dice siempre si suma a la transferencia o lo paga la casa", () => {
    const base = {
      code: "seguro_medico",
      name: "Seguro médico privado",
      amountCents: "4500",
      periodicity: "monthly" as const,
      startsOn: null,
      endsOn: null,
      active: true,
    };
    expect(recurringSupplementInputSchema.safeParse({ ...base, addsToPay: false }).success).toBe(true);
    expect(recurringSupplementInputSchema.safeParse(base).success).toBe(false);
    expect(
      recurringSupplementInputSchema.safeParse({
        ...base,
        addsToPay: true,
        startsOn: "2026-09-01",
        endsOn: "2026-08-01",
      }).success,
    ).toBe(false);
  });

  it("los términos de una versión llevan siempre motivo y fecha de entrada en vigor", () => {
    const terms = {
      effectiveFrom: "2026-09-01",
      monthlySalaryCents: "150000",
      contractedWeeklyMinutes: 2400,
      annualVacationDays: 30,
      reason: "Subida pactada en agosto",
      extraWorkTypes: [],
      supplements: [],
    };
    expect(agreementTermsInputSchema.safeParse(terms).success).toBe(true);
    expect(agreementTermsInputSchema.safeParse({ ...terms, reason: "  " }).success).toBe(false);
    expect(
      agreementTermsInputSchema.safeParse({ ...terms, monthlySalaryCents: "-1" }).success,
    ).toBe(false);
    expect(
      agreementCreateInputSchema.safeParse({
        employeeMembershipId: "11000000-0000-4000-8000-000000000003",
        startsOn: "2026-09-01",
        terms,
      }).success,
    ).toBe(true);
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
