import { describe, expect, it } from "vitest";

import {
  DomainRuleError,
  vacationCalendarDays,
  vacationDaysInYear,
  vacationPeriodsOverlap,
  vacationYearBalance,
} from "./index.js";

function domainCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainRuleError) return error.code;
    throw error;
  }
  throw new Error("Se esperaba un DomainRuleError");
}

describe("días naturales de un periodo", () => {
  it("cuenta ambos extremos: del 1 al 15 de agosto son 15 días", () => {
    expect(vacationCalendarDays("2026-08-01", "2026-08-15")).toBe(15);
  });

  it("un solo día es un día", () => {
    expect(vacationCalendarDays("2026-08-01", "2026-08-01")).toBe(1);
  });

  it("cruza meses y el 29 de febrero de un bisiesto", () => {
    expect(vacationCalendarDays("2028-02-27", "2028-03-01")).toBe(4);
  });

  it("cruza el fin de año", () => {
    expect(vacationCalendarDays("2026-12-24", "2027-01-05")).toBe(13);
  });

  it("rechaza acabar antes de empezar", () => {
    expect(domainCode(() => vacationCalendarDays("2026-08-10", "2026-08-01"))).toBe(
      "INVALID_VACATION_INTERVAL",
    );
  });

  it("rechaza una fecha inventada", () => {
    expect(domainCode(() => vacationCalendarDays("2026-02-30", "2026-03-01"))).toBe(
      "INVALID_VACATION_DATE",
    );
  });
});

describe("solape entre periodos", () => {
  const agosto = { startsOn: "2026-08-01", endsOn: "2026-08-15" };

  it("detecta el solape aunque solo compartan el último día", () => {
    expect(vacationPeriodsOverlap(agosto, { startsOn: "2026-08-15", endsOn: "2026-08-20" })).toBe(true);
  });

  it("no ve solape en días consecutivos", () => {
    expect(vacationPeriodsOverlap(agosto, { startsOn: "2026-08-16", endsOn: "2026-08-20" })).toBe(false);
  });

  it("detecta el periodo contenido dentro de otro", () => {
    expect(vacationPeriodsOverlap(agosto, { startsOn: "2026-08-05", endsOn: "2026-08-07" })).toBe(true);
  });
});

describe("reparto de un periodo entre años", () => {
  const navidad = { startsOn: "2026-12-24", endsOn: "2027-01-05" };

  it("cada año gasta solo sus días", () => {
    expect(vacationDaysInYear(navidad, 2026)).toBe(8);
    expect(vacationDaysInYear(navidad, 2027)).toBe(5);
    expect(vacationDaysInYear(navidad, 2026) + vacationDaysInYear(navidad, 2027)).toBe(13);
  });

  it("un año que el periodo no toca no gasta nada", () => {
    expect(vacationDaysInYear(navidad, 2025)).toBe(0);
    expect(vacationDaysInYear(navidad, 2028)).toBe(0);
  });
});

describe("saldo del año natural", () => {
  const acuerdoEntero = { agreementStartsOn: "2020-01-01", annualVacationDays: 30 } as const;

  it("año completo: derecho íntegro, sin prorrateo", () => {
    const balance = vacationYearBalance({ ...acuerdoEntero, year: 2026, periods: [] });
    expect(balance.entitledDays).toBe(30);
    expect(balance.prorated).toBe(false);
    expect(balance.takenDays).toBe(0);
    expect(balance.remainingDays).toBe(30);
  });

  it("resta lo disfrutado y deja el resto", () => {
    const balance = vacationYearBalance({
      ...acuerdoEntero,
      year: 2026,
      periods: [
        { startsOn: "2026-08-01", endsOn: "2026-08-15" },
        { startsOn: "2026-12-24", endsOn: "2026-12-31" },
      ],
    });
    expect(balance.takenDays).toBe(23);
    expect(balance.remainingDays).toBe(7);
  });

  it("el exceso NO se rechaza: queda en negativo y se puede enseñar", () => {
    const balance = vacationYearBalance({
      ...acuerdoEntero,
      year: 2026,
      periods: [{ startsOn: "2026-06-01", endsOn: "2026-07-05" }],
    });
    expect(balance.takenDays).toBe(35);
    expect(balance.remainingDays).toBe(-5);
  });

  it("un año bisiesto tiene 366 días naturales", () => {
    expect(vacationYearBalance({ ...acuerdoEntero, year: 2028, periods: [] }).daysInYear).toBe(366);
  });

  it("prorratea el primer año y lo dice", () => {
    // Del 3 de febrero al 31 de diciembre de 2026 hay 332 de 365 días.
    // 30 × 332 / 365 = 27,29 → 28 redondeando a favor de quien trabaja.
    const balance = vacationYearBalance({
      year: 2026,
      annualVacationDays: 30,
      agreementStartsOn: "2026-02-03",
      periods: [],
    });
    expect(balance.prorated).toBe(true);
    expect(balance.coveredFrom).toBe("2026-02-03");
    expect(balance.coveredDays).toBe(332);
    expect(balance.entitledDays).toBe(28);
    expect(balance.annualVacationDays).toBe(30);
  });

  it("prorratea también el año en que el acuerdo termina", () => {
    // Del 1 de enero al 30 de junio de 2026: 181 de 365 días.
    // 30 × 181 / 365 = 14,88 → 15.
    const balance = vacationYearBalance({
      year: 2026,
      annualVacationDays: 30,
      agreementStartsOn: "2020-01-01",
      agreementEndsOn: "2026-06-30",
      periods: [],
    });
    expect(balance.prorated).toBe(true);
    expect(balance.coveredThrough).toBe("2026-06-30");
    expect(balance.entitledDays).toBe(15);
  });

  it("un año que el acuerdo no toca no da derecho a nada", () => {
    const balance = vacationYearBalance({
      year: 2019,
      annualVacationDays: 30,
      agreementStartsOn: "2020-01-01",
      periods: [],
    });
    expect(balance.coveredDays).toBe(0);
    expect(balance.entitledDays).toBe(0);
  });

  it("solo cuenta los días del año que se mira, aunque el periodo lo cruce", () => {
    const periods = [{ startsOn: "2026-12-24", endsOn: "2027-01-05" }];
    expect(vacationYearBalance({ ...acuerdoEntero, year: 2026, periods }).takenDays).toBe(8);
    expect(vacationYearBalance({ ...acuerdoEntero, year: 2027, periods }).takenDays).toBe(5);
  });

  it("un derecho de cero días es válido y deja el saldo en cero", () => {
    const balance = vacationYearBalance({
      year: 2026,
      annualVacationDays: 0,
      agreementStartsOn: "2020-01-01",
      periods: [],
    });
    expect(balance.entitledDays).toBe(0);
    expect(balance.remainingDays).toBe(0);
  });

  it("rechaza un derecho anual negativo o fraccionario", () => {
    expect(
      domainCode(() =>
        vacationYearBalance({
          year: 2026,
          annualVacationDays: -1,
          agreementStartsOn: "2020-01-01",
          periods: [],
        }),
      ),
    ).toBe("INVALID_VACATION_ENTITLEMENT");
    expect(
      domainCode(() =>
        vacationYearBalance({
          year: 2026,
          annualVacationDays: 22.5,
          agreementStartsOn: "2020-01-01",
          periods: [],
        }),
      ),
    ).toBe("INVALID_VACATION_ENTITLEMENT");
  });
});
