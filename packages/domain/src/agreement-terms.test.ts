import { describe, expect, it } from "vitest";

import {
  employeeVisibleSupplements,
  employeeVisibleTypes,
  isVisibleToEmployee,
  supplementsInForce,
  valueExtraWork,
  type ExtraWorkType,
  type RecurringSupplement,
} from "./agreement-terms.js";
import { calculateSettlement } from "./settlement.js";
import type { AgreementVersion } from "./agreements.js";

function type(overrides: Partial<ExtraWorkType> = {}): ExtraWorkType {
  return {
    id: "tipo-1",
    code: "jornada_extra",
    name: "Jornada extra",
    unit: "per_shift",
    rateCents: 5000n,
    referenceMinutes: 600,
    active: true,
    ...overrides,
  };
}

function supplement(overrides: Partial<RecurringSupplement> = {}): RecurringSupplement {
  return {
    id: "complemento-1",
    code: "antiguedad",
    name: "Complemento de antigüedad",
    amountCents: 3000n,
    periodicity: "monthly",
    addsToPay: true,
    startsOn: null,
    endsOn: null,
    active: true,
    ...overrides,
  };
}

const VERSIONS: readonly AgreementVersion[] = [
  { id: "version-1", validFrom: "2026-01-01", validTo: null, monthlySalaryCents: 150000n },
];

describe("valoración por unidad", () => {
  it("prorratea la hora extraordinaria con redondeo half-up en bigint", () => {
    const hourly = type({ code: "overtime", unit: "per_hour", rateCents: 1000n, referenceMinutes: null });
    // 10 €/h durante 90 min son 15 €, sin coma flotante por el camino.
    expect(valueExtraWork(hourly, 90).amountCents).toBe(1500n);
    // 25 minutos a 10 €/h son 4,1666… €: se redondea hacia arriba, no se trunca.
    expect(valueExtraWork(hourly, 25).amountCents).toBe(417n);
  });

  it("una jornada vale su tarifa una vez, dure lo que dure el día", () => {
    const shift = type();
    expect(valueExtraWork(shift, 600).amountCents).toBe(5000n);
    // Se quedó una hora de más: sigue siendo UNA jornada extra, no 1,1.
    expect(valueExtraWork(shift, 660).amountCents).toBe(5000n);
    expect(valueExtraWork(shift, 660).quantityLabel).toBe("1 jornada");
  });

  it("un importe fijo por supuesto vale su tarifa: la noche de guardia son 50 €", () => {
    const nightShift = type({
      code: "noche_de_guardia",
      name: "Noche de guardia",
      unit: "fixed_amount",
      rateCents: 5000n,
      referenceMinutes: 720,
    });
    const valued = valueExtraWork(nightShift, 720);
    expect(valued.amountCents).toBe(5000n);
    expect(valued.unitRateCents).toBe(5000n);
    expect(valued.quantityLabel).toBe("1 vez");
  });

  it("acredita como descanso la jornada pactada, y lo trabajado si no hay ninguna", () => {
    expect(valueExtraWork(type({ referenceMinutes: 600 }), 660).creditMinutes).toBe(600);
    expect(
      valueExtraWork(
        type({ unit: "per_hour", rateCents: 1000n, referenceMinutes: null }),
        90,
      ).creditMinutes,
    ).toBe(90);
  });

  it("un concepto desactivado o sin tarifa no se puede valorar", () => {
    expect(() => valueExtraWork(type({ active: false }), 600)).toThrowError(
      /no está activo/,
    );
    expect(() => valueExtraWork(type({ rateCents: null }), 600)).toThrowError(
      /no tiene tarifa pactada/,
    );
  });

  it("rechaza una duración que no es un entero positivo de minutos", () => {
    expect(() => valueExtraWork(type(), 0)).toThrowError(/entero positivo/);
    expect(() => valueExtraWork(type(), 12.5)).toThrowError(/entero positivo/);
  });
});

describe("qué ve la empleada", () => {
  it("solo lo activo y con tarifa: es la regla del propietario, literal", () => {
    const catalogue = [
      type({ id: "visible" }),
      type({ id: "desactivado", code: "overtime", unit: "per_hour", referenceMinutes: null, active: false }),
      type({ id: "sin_tarifa", code: "sin_tarifa", rateCents: null }),
    ];
    expect(employeeVisibleTypes(catalogue).map((item) => item.id)).toEqual(["visible"]);
    expect(isVisibleToEmployee(catalogue[1] as ExtraWorkType)).toBe(false);
    expect(isVisibleToEmployee(catalogue[2] as ExtraWorkType)).toBe(false);
  });

  it("ve los complementos vivos SUMEN O NO: el seguro que paga la casa es suyo también", () => {
    const catalogue = [
      supplement({ id: "antiguedad" }),
      supplement({ id: "seguro", code: "seguro_medico", addsToPay: false, amountCents: 4500n }),
      supplement({ id: "retirado", code: "plus_transporte", active: false }),
    ];
    expect(employeeVisibleSupplements(catalogue).map((item) => item.id)).toEqual([
      "antiguedad",
      "seguro",
    ]);
  });

  it("un complemento fuera de vigencia no rige el mes", () => {
    const catalogue = [
      supplement({ id: "empieza_luego", startsOn: "2026-09-01" }),
      supplement({ id: "acabo_antes", endsOn: "2026-07-31" }),
      supplement({ id: "vigente", startsOn: "2026-08-15", endsOn: null }),
    ];
    expect(
      supplementsInForce(catalogue, "2026-08-01", "2026-08-31").map((item) => item.id),
    ).toEqual(["vigente"]);
  });
});

describe("los complementos en la cuenta del mes", () => {
  const base = {
    period: "2026-08",
    agreementVersions: VERSIONS,
    extraWork: [],
    extraPay: [],
    advanceDeductions: [],
    unpaidAbsences: [],
    adjustments: [],
    expenses: [],
  } as const;

  it("el que suma entra en el total; el que no suma NO lo altera ni un céntimo", () => {
    const withoutSupplements = calculateSettlement({ ...base });
    const withBoth = calculateSettlement({
      ...base,
      supplements: [
        supplement({ id: "antiguedad", amountCents: 3000n, addsToPay: true }),
        supplement({
          id: "seguro",
          code: "seguro_medico",
          name: "Seguro médico privado",
          amountCents: 4500n,
          addsToPay: false,
        }),
      ],
    });

    expect(withoutSupplements.transferTotalCents).toBe(150000n);
    // Sube exactamente la antigüedad. El seguro médico, que son 45 €, no toca
    // el total: lo paga la casa, no viaja en la transferencia.
    expect(withBoth.transferTotalCents).toBe(153000n);
    expect(withBoth.salaryCents).toBe(153000n);
    expect(withBoth.householdPaidSupplements).toEqual([
      { id: "seguro", label: "Seguro médico privado", amountCents: 4500n },
    ]);
    expect(withBoth.lines.filter((line) => line.kind === "supplement")).toHaveLength(1);
  });

  it("un complemento retirado o sin importe no aparece por ninguna parte", () => {
    const projection = calculateSettlement({
      ...base,
      supplements: [
        supplement({ id: "retirado", active: false }),
        supplement({ id: "sin_importe", amountCents: null }),
      ],
    });
    expect(projection.transferTotalCents).toBe(150000n);
    expect(projection.lines.filter((line) => line.kind === "supplement")).toHaveLength(0);
    expect(projection.householdPaidSupplements).toHaveLength(0);
  });

  it("sin complementos el cálculo es exactamente el de antes", () => {
    expect(calculateSettlement({ ...base }).householdPaidSupplements).toHaveLength(0);
  });
});
