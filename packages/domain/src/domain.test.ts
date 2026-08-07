import { describe, expect, it } from "vitest";

import {
  InvalidExtraWorkTransition,
  calculateSettlement,
  derivePaymentStatus,
  transitionExtraWork,
  type ExtraWorkEvent,
  type SettlementInput,
} from "./index.js";

const baseEvent: ExtraWorkEvent = {
  id: "extra-1",
  status: "requested",
  durationMinutes: 480,
  requestedBy: "employee",
  approvedBy: null,
  performedAt: null,
  resolution: null,
  frozenUnitRateCents: null,
  frozenAmountCents: null,
  permanentCreditMinutes: 0,
};

describe("máquina de estados de jornadas extra", () => {
  it("conserva una jornada realizada sin aprobación hasta que se resuelva", () => {
    const performed = transitionExtraWork(baseEvent, {
      type: "report_unapproved_work",
      performedAt: "2026-03-09T18:00:00Z",
    });
    expect(performed.status).toBe("performed_pending_resolution");

    const resolved = transitionExtraWork(performed, {
      type: "resolve",
      approvedBy: "admin",
      resolution: "money",
      unitRateCents: 7_000n,
      amountCents: 7_000n,
      creditMinutes: 0,
    });
    expect(resolved).toMatchObject({
      status: "resolved",
      approvedBy: "admin",
      frozenAmountCents: 7_000n,
    });
  });

  it("genera descanso permanente, sin caducidad ni importe", () => {
    const accepted = transitionExtraWork(baseEvent, {
      type: "accept",
      approvedBy: "admin",
    });
    const performed = transitionExtraWork(accepted, {
      type: "mark_performed",
      performedAt: "2026-03-23T18:00:00Z",
    });
    const resolved = transitionExtraWork(performed, {
      type: "resolve",
      approvedBy: "admin",
      resolution: "time_off",
      unitRateCents: 7_000n,
      amountCents: 0n,
      creditMinutes: 480,
    });
    expect(resolved.permanentCreditMinutes).toBe(480);
    expect(resolved.frozenAmountCents).toBe(0n);
  });

  it("rechaza la edición de un evento terminal", () => {
    const rejected = transitionExtraWork(baseEvent, { type: "reject" });
    expect(() =>
      transitionExtraWork(rejected, { type: "accept", approvedBy: "admin" }),
    ).toThrow(InvalidExtraWorkTransition);
  });
});

const march: SettlementInput = {
  period: "2026-03",
  agreementVersions: [
    {
      id: "agreement-march",
      validFrom: "2026-01-01",
      validTo: "2026-05-31",
      monthlySalaryCents: 140_000n,
    },
    {
      id: "agreement-june",
      validFrom: "2026-06-01",
      validTo: null,
      monthlySalaryCents: 150_000n,
    },
  ],
  extraWork: [
    {
      id: "rest-day-09",
      workedOn: "2026-03-09",
      label: "Libranza trabajada 09/03 (pago)",
      resolution: "money",
      quantityLabel: "1 jornada",
      frozenUnitRateCents: 7_000n,
      frozenAmountCents: 7_000n,
      permanentCreditMinutes: 0,
    },
    {
      id: "rest-day-23",
      workedOn: "2026-03-23",
      label: "Libranza trabajada 23/03 (compensación)",
      resolution: "time_off",
      quantityLabel: "1 jornada",
      frozenUnitRateCents: 7_000n,
      frozenAmountCents: 0n,
      permanentCreditMinutes: 480,
    },
    {
      id: "hours",
      workedOn: "2026-03-18",
      label: "Horas extra",
      resolution: "money",
      quantityLabel: "3 h",
      frozenUnitRateCents: 1_200n,
      frozenAmountCents: 3_600n,
      permanentCreditMinutes: 0,
    },
  ],
  extraPay: [],
  advanceDeductions: [
    { id: "advance-1", label: "Descuento anticipo", amountCents: 10_000n },
  ],
  unpaidAbsences: [],
  adjustments: [],
  expenses: [
    { id: "expense-1", label: "Reembolso de gastos", amountCents: 4_730n },
  ],
};

describe("motor puro de liquidación", () => {
  it("reproduce el ejemplo de aceptación y mantiene trazabilidad", () => {
    const result = calculateSettlement(march);
    expect(result.salaryCents).toBe(140_600n);
    expect(result.reimbursementCents).toBe(4_730n);
    expect(result.transferTotalCents).toBe(145_330n);
    expect(result.permanentCreditMinutes).toBe(480);
    expect(result.lines.find((line) => line.sourceId === "rest-day-09")?.sourceHref)
      .toBe("/laboral/jornadas-extra/rest-day-09");
  });

  it("no aplica a marzo un cambio salarial de junio", () => {
    expect(calculateSettlement(march).agreementVersionId).toBe("agreement-march");
  });

  it("mantiene cerrada una liquidación con pago parcial", () => {
    expect(derivePaymentStatus(145_330n, [
      { id: "p1", amountCents: 100_000n, voided: false, confirmedByEmployeeAt: null },
    ])).toBe("closed");
  });

  it("solo confirma cobro cuando todos los pagos están confirmados", () => {
    expect(derivePaymentStatus(145_330n, [
      { id: "p1", amountCents: 145_330n, voided: false, confirmedByEmployeeAt: null },
    ])).toBe("paid");
    expect(derivePaymentStatus(145_330n, [
      {
        id: "p1",
        amountCents: 145_330n,
        voided: false,
        confirmedByEmployeeAt: "2026-03-31T12:00:00Z",
      },
    ])).toBe("receipt_confirmed");
  });
});
