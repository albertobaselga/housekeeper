import { describe, expect, it } from "vitest";

import {
  DomainRuleError,
  calculateSettlement,
  deferralNote,
  imputationMonth,
  monthLabel,
  nextMonth,
  type SettlementInput,
} from "./index.js";

describe("a qué mes cae un concepto apuntado a mano", () => {
  it("respeta el mes elegido cuando no está cerrado", () => {
    expect(imputationMonth("2026-04", [])).toEqual({
      period: "2026-04",
      requested: "2026-04",
      note: "",
    });
  });

  it("acepta un mes ya empezado: abierto no es cerrado", () => {
    // La cuenta de abril puede estar iniciada («open») y aun así admitir
    // apuntes: lo que cierra la puerta es el cierre, no la apertura.
    expect(imputationMonth("2026-04", ["2026-03"]).period).toBe("2026-04");
  });

  it("no reescribe una cuenta cerrada: cae al siguiente con una nota que lo dice", () => {
    const imputation = imputationMonth("2026-03", ["2026-03"]);
    expect(imputation.period).toBe("2026-04");
    expect(imputation.requested).toBe("2026-03");
    expect(imputation.note).toBe(
      "Se pidió para marzo de 2026, pero esa cuenta ya estaba cerrada: se imputa a abril de 2026.",
    );
  });

  it("salta tantos meses cerrados como haga falta, incluido el cambio de año", () => {
    expect(imputationMonth("2026-11", ["2026-11", "2026-12"]).period).toBe("2027-01");
  });

  it("se rinde con causa legible si no hay ningún mes abierto por delante", () => {
    const closed = Array.from({ length: 30 }, (_unused, index) => {
      let period = "2026-01";
      for (let step = 0; step < index; step += 1) period = nextMonth(period);
      return period;
    });
    expect(() => imputationMonth("2026-01", closed)).toThrow(DomainRuleError);
  });

  it("habla en castellano llano", () => {
    expect(monthLabel("2026-09")).toBe("septiembre de 2026");
    expect(deferralNote("2026-12", "2027-01")).toContain("diciembre de 2026");
  });

  it("rechaza un mes que no es un mes", () => {
    expect(() => imputationMonth("2026-13", [])).toThrow(DomainRuleError);
    expect(() => imputationMonth("2026-04-01", [])).toThrow(DomainRuleError);
  });
});

const april: SettlementInput = {
  period: "2026-04",
  agreementVersions: [
    {
      id: "acuerdo-v1",
      validFrom: "2026-01-01",
      validTo: null,
      monthlySalaryCents: 140_000n,
    },
  ],
  extraWork: [],
  extraPay: [],
  advanceDeductions: [],
  unpaidAbsences: [],
  adjustments: [],
  expenses: [],
};

describe("conceptos apuntados a mano dentro de la cuenta del mes", () => {
  it("suma lo que suma y resta lo que resta, con su motivo a la vista", () => {
    const result = calculateSettlement({
      ...april,
      adjustments: [
        {
          id: "c1",
          label: "Gratificación de verano",
          reason: "Acordada en la conversación del 2 de abril",
          amountCents: 15_000n,
          addsToPay: true,
        },
        {
          id: "c2",
          label: "Descuento acordado",
          reason: "Rotura de la vitrocerámica, a medias",
          amountCents: -5_000n,
          addsToPay: true,
        },
      ],
    });

    expect(result.salaryCents).toBe(150_000n);
    expect(result.transferTotalCents).toBe(150_000n);
    const gratificacion = result.lines.find((line) => line.sourceId === "c1");
    expect(gratificacion?.amountCents).toBe(15_000n);
    expect(gratificacion?.label).toBe("Gratificación de verano");
    expect(gratificacion?.note).toBe("Acordada en la conversación del 2 de abril");
    expect(result.lines.find((line) => line.sourceId === "c2")?.amountCents).toBe(-5_000n);
    expect(result.notedAdjustments).toHaveLength(0);
  });

  it("lo que no se transfiere no toca la transferencia, aunque conste", () => {
    const result = calculateSettlement({
      ...april,
      adjustments: [
        {
          id: "c3",
          label: "Anticipo devuelto en mano",
          reason: "Devolvió 200 € en efectivo el 12 de abril",
          amountCents: -20_000n,
          addsToPay: false,
        },
      ],
    });

    // El total es el salario pelado: descontarlo otra vez sería cobrárselo dos
    // veces, que es exactamente el error que `addsToPay` existe para impedir.
    expect(result.transferTotalCents).toBe(140_000n);
    expect(result.lines.some((line) => line.kind === "adjustment")).toBe(false);
    expect(result.notedAdjustments).toEqual([
      {
        id: "c3",
        label: "Anticipo devuelto en mano",
        reason: "Devolvió 200 € en efectivo el 12 de abril",
        amountCents: -20_000n,
      },
    ]);
  });

  it("exige motivo y rechaza el importe cero", () => {
    expect(() =>
      calculateSettlement({
        ...april,
        adjustments: [
          { id: "c4", label: "Sin explicar", reason: "  ", amountCents: 100n, addsToPay: true },
        ],
      }),
    ).toThrow(TypeError);

    expect(() =>
      calculateSettlement({
        ...april,
        adjustments: [
          { id: "c5", label: "Nada", reason: "Nada", amountCents: 0n, addsToPay: true },
        ],
      }),
    ).toThrow(RangeError);
  });
});
