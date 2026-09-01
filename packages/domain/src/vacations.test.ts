import { describe, expect, it } from "vitest";

import {
  DomainRuleError,
  contractYear,
  contractYearName,
  contractYearOn,
  moneyCents,
  parseEuroCents,
  readVacationCarryoverExpiry,
  vacationCalendarDays,
  vacationCarryoverDeadline,
  vacationCompensation,
  vacationDaysInWindow,
  vacationNewsSince,
  vacationPeriodsOverlap,
  vacationYearBalance,
  type VacationEventInput,
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

describe("el año de contrato", () => {
  it("el primero va del día del contrato a la víspera del aniversario", () => {
    expect(contractYear("2025-03-05", 1)).toEqual({
      index: 1,
      startsOn: "2025-03-05",
      endsOn: "2026-03-04",
    });
  });

  it("el segundo empieza el día del aniversario", () => {
    expect(contractYear("2025-03-05", 2)).toEqual({
      index: 2,
      startsOn: "2026-03-05",
      endsOn: "2027-03-04",
    });
  });

  it("dos años consecutivos ni se solapan ni dejan un día suelto", () => {
    const primero = contractYear("2025-03-05", 1);
    const segundo = contractYear("2025-03-05", 2);
    expect(vacationCalendarDays(primero.endsOn, segundo.startsOn)).toBe(2);
  });

  it("un contrato del 29 de febrero clava el aniversario al último día del mes", () => {
    // 2025 no es bisiesto: los doce meses se cumplen el 28 de febrero, así que
    // el primer año acaba la víspera, el 27. El aniversario ABRE el año nuevo,
    // igual que en cualquier otro contrato.
    expect(contractYear("2024-02-29", 1)).toEqual({
      index: 1,
      startsOn: "2024-02-29",
      endsOn: "2025-02-27",
    });
    expect(contractYear("2024-02-29", 2)).toEqual({
      index: 2,
      startsOn: "2025-02-28",
      endsOn: "2026-02-27",
    });
  });

  it("y vuelve a su día en el siguiente bisiesto, porque siempre cuenta desde el original", () => {
    expect(contractYear("2024-02-29", 5)).toEqual({
      index: 5,
      startsOn: "2028-02-29",
      endsOn: "2029-02-27",
    });
  });

  it("un año de contrato con un 29 de febrero dentro dura 366 días", () => {
    const year = contractYear("2027-06-01", 1);
    expect(vacationCalendarDays(year.startsOn, year.endsOn)).toBe(366);
  });

  it("rechaza numerar los años desde cero", () => {
    expect(domainCode(() => contractYear("2025-03-05", 0))).toBe("INVALID_VACATION_YEAR");
  });

  describe("en qué año de contrato cae una fecha", () => {
    it("el día del contrato es el primer día del primer año", () => {
      expect(contractYearOn("2025-03-05", "2025-03-05")?.index).toBe(1);
    });

    it("la víspera del aniversario todavía es el primer año", () => {
      expect(contractYearOn("2025-03-05", "2026-03-04")?.index).toBe(1);
    });

    it("el aniversario ya es el segundo", () => {
      expect(contractYearOn("2025-03-05", "2026-03-05")?.index).toBe(2);
    });

    it("antes de empezar no hay ningún año que contar", () => {
      expect(contractYearOn("2025-03-05", "2025-03-04")).toBeNull();
    });

    it("acierta también con el aniversario clavado del 29 de febrero", () => {
      expect(contractYearOn("2024-02-29", "2025-02-27")?.index).toBe(1);
      expect(contractYearOn("2024-02-29", "2025-02-28")?.index).toBe(2);
    });

    it("años lejanos: el décimo aniversario abre el año once", () => {
      expect(contractYearOn("2025-03-05", "2035-03-05")?.index).toBe(11);
    });
  });
});

describe("reparto de un periodo entre años de contrato", () => {
  const navidad = { startsOn: "2026-12-24", endsOn: "2027-01-05" };
  // Contrato del 5 de marzo: el corte cae el 4/5 de marzo, no en Nochevieja.
  const primero = contractYear("2025-03-05", 2); // 2026-03-05 … 2027-03-04

  it("un periodo entero dentro del año de contrato cuenta entero", () => {
    expect(vacationDaysInWindow(navidad, primero.startsOn, primero.endsOn)).toBe(13);
  });

  it("un periodo a caballo de dos años de contrato se reparte entre ellos", () => {
    // Del 1 al 10 de marzo de 2027, con el corte el 4: cuatro días del segundo
    // año y seis del tercero.
    const marzo = { startsOn: "2027-03-01", endsOn: "2027-03-10" };
    const segundo = contractYear("2025-03-05", 2);
    const tercero = contractYear("2025-03-05", 3);
    expect(vacationDaysInWindow(marzo, segundo.startsOn, segundo.endsOn)).toBe(4);
    expect(vacationDaysInWindow(marzo, tercero.startsOn, tercero.endsOn)).toBe(6);
    expect(
      vacationDaysInWindow(marzo, segundo.startsOn, segundo.endsOn) +
        vacationDaysInWindow(marzo, tercero.startsOn, tercero.endsOn),
    ).toBe(10);
  });

  it("un año que el periodo no toca no gasta nada", () => {
    const cuarto = contractYear("2025-03-05", 4);
    expect(vacationDaysInWindow(navidad, cuarto.startsOn, cuarto.endsOn)).toBe(0);
  });

  it("rechaza una ventana que acaba antes de empezar", () => {
    expect(domainCode(() => vacationDaysInWindow(navidad, "2027-01-01", "2026-01-01"))).toBe(
      "INVALID_VACATION_INTERVAL",
    );
  });
});

describe("saldo del año de contrato", () => {
  // Empezó el 5 de marzo de 2025: su segundo año va del 5-mar-2026 al 4-mar-2027.
  const acuerdo = {
    agreementStartsOn: "2025-03-05",
    annualVacationDays: 30,
    contractYearIndex: 2,
  } as const;

  it("año completo: derecho íntegro, sin prorrateo", () => {
    const balance = vacationYearBalance({ ...acuerdo, periods: [], asOf: "2027-03-04" });
    expect(balance.contractYear).toEqual({
      index: 2,
      startsOn: "2026-03-05",
      endsOn: "2027-03-04",
    });
    expect(balance.entitledDays).toBe(30);
    expect(balance.prorated).toBe(false);
    expect(balance.takenDays).toBe(0);
    expect(balance.remainingDays).toBe(30);
  });

  it("el primer año YA NO se prorratea: empieza el día del contrato", () => {
    // Antes, con el año natural, quien empezaba en noviembre veía un derecho
    // recortado. Ahora su primer año es suyo entero.
    const balance = vacationYearBalance({
      contractYearIndex: 1,
      annualVacationDays: 30,
      agreementStartsOn: "2026-11-02",
      periods: [],
      asOf: "2027-11-01",
    });
    expect(balance.prorated).toBe(false);
    expect(balance.entitledDays).toBe(30);
    expect(balance.coveredFrom).toBe("2026-11-02");
    expect(balance.coveredThrough).toBe("2027-11-01");
  });

  it("resta lo disfrutado y deja el resto", () => {
    const balance = vacationYearBalance({
      ...acuerdo,
      periods: [
        { startsOn: "2026-08-01", endsOn: "2026-08-15" },
        { startsOn: "2026-12-24", endsOn: "2026-12-31" },
      ],
      asOf: "2027-03-04",
    });
    expect(balance.takenDays).toBe(23);
    expect(balance.remainingDays).toBe(7);
  });

  it("el exceso NO se rechaza: queda en negativo y se puede enseñar", () => {
    const balance = vacationYearBalance({
      ...acuerdo,
      periods: [{ startsOn: "2026-06-01", endsOn: "2026-07-05" }],
      asOf: "2027-03-04",
    });
    expect(balance.takenDays).toBe(35);
    expect(balance.remainingDays).toBe(-5);
  });

  it("solo cuenta los días que caen en el año de contrato que se mira", () => {
    // Del 1 al 10 de marzo de 2027, con el corte el 4 de marzo.
    const periods = [{ startsOn: "2027-03-01", endsOn: "2027-03-10" }];
    expect(
      vacationYearBalance({ ...acuerdo, periods, asOf: "2027-03-04" }).takenDays,
    ).toBe(4);
    expect(
      vacationYearBalance({
        ...acuerdo,
        contractYearIndex: 3,
        periods,
        asOf: "2027-03-10",
      }).takenDays,
    ).toBe(6);
  });

  it("prorratea el ÚLTIMO año cuando el contrato termina a media anualidad", () => {
    // Del 5 de marzo al 31 de agosto de 2026 hay 180 de los 365 días del año de
    // contrato. 30 × 180 / 365 = 14,79 → 15 redondeando a favor de quien trabaja.
    const balance = vacationYearBalance({
      ...acuerdo,
      agreementEndsOn: "2026-08-31",
      periods: [],
      asOf: "2026-08-31",
    });
    expect(balance.prorated).toBe(true);
    expect(balance.coveredThrough).toBe("2026-08-31");
    expect(balance.coveredDays).toBe(180);
    expect(balance.daysInContractYear).toBe(365);
    expect(balance.entitledDays).toBe(15);
    expect(balance.annualVacationDays).toBe(30);
  });

  it("último año prorrateado y periodo repartido: las tres reglas a la vez", () => {
    // El contrato acaba el 30 de junio de 2026, a media anualidad, y hay un
    // periodo del 1 al 10 de marzo justo encima del aniversario. Es el cruce que
    // ninguna prueba cubría: prorrateo del último año, reparto entre dos años y
    // devengo a una fecha, todo sobre el mismo contrato.
    const termina = {
      agreementStartsOn: "2025-03-05",
      agreementEndsOn: "2026-06-30",
      annualVacationDays: 30,
      periods: [{ startsOn: "2026-03-01", endsOn: "2026-03-10" }],
      asOf: "2026-05-01",
    } as const;
    const primero = vacationYearBalance({ ...termina, contractYearIndex: 1 });
    const segundo = vacationYearBalance({ ...termina, contractYearIndex: 2 });

    // Del 5 de marzo al 30 de junio de 2026 hay 118 días cubiertos de 365.
    // 30 × 118 / 365 = 9,7 → 10.
    expect(segundo.coveredDays).toBe(118);
    expect(segundo.prorated).toBe(true);
    expect(segundo.entitledDays).toBe(10);
    // Devengado a 1 de mayo: 58 de los 118 días cubiertos. 10 × 58 / 118 = 4,9 → 5.
    expect(segundo.accruedDays).toBe(5);
    expect(segundo.availableNowDays).toBe(-1);
    expect(segundo.remainingDays).toBe(4);

    // Los diez días del periodo se reparten entre los dos años sin perder ni
    // duplicar ninguno: cuatro gastan el primer año y seis el segundo.
    expect(primero.takenDays).toBe(4);
    expect(segundo.takenDays).toBe(6);
    expect(primero.takenDays + segundo.takenDays).toBe(10);
    // Y el primer año sigue sin prorratearse: el contrato lo cubre entero.
    expect(primero.prorated).toBe(false);
    expect(primero.entitledDays).toBe(30);
  });

  it("un año de contrato que empieza después del fin del acuerdo no da derecho a nada", () => {
    const balance = vacationYearBalance({
      ...acuerdo,
      contractYearIndex: 3,
      agreementEndsOn: "2026-08-31",
      periods: [],
      asOf: "2027-06-01",
    });
    expect(balance.coveredDays).toBe(0);
    expect(balance.entitledDays).toBe(0);
    expect(balance.accruedDays).toBe(0);
  });

  it("un derecho de cero días es válido y deja el saldo en cero", () => {
    const balance = vacationYearBalance({
      ...acuerdo,
      annualVacationDays: 0,
      periods: [],
      asOf: "2026-09-01",
    });
    expect(balance.entitledDays).toBe(0);
    expect(balance.remainingDays).toBe(0);
    expect(balance.accruedDays).toBe(0);
  });

  it("rechaza un derecho anual negativo o fraccionario", () => {
    expect(
      domainCode(() =>
        vacationYearBalance({ ...acuerdo, annualVacationDays: -1, periods: [], asOf: "2026-09-01" }),
      ),
    ).toBe("INVALID_VACATION_ENTITLEMENT");
    expect(
      domainCode(() =>
        vacationYearBalance({ ...acuerdo, annualVacationDays: 22.5, periods: [], asOf: "2026-09-01" }),
      ),
    ).toBe("INVALID_VACATION_ENTITLEMENT");
  });

  it("rechaza una fecha de referencia inventada", () => {
    expect(
      domainCode(() => vacationYearBalance({ ...acuerdo, periods: [], asOf: "el martes" })),
    ).toBe("INVALID_VACATION_DATE");
  });
});

describe("días devengados a una fecha", () => {
  // Segundo año de contrato: del 5 de marzo de 2026 al 4 de marzo de 2027.
  const acuerdo = {
    agreementStartsOn: "2025-03-05",
    annualVacationDays: 30,
    contractYearIndex: 2,
    periods: [],
  } as const;

  it("el primer día del año ya devenga un día, por redondear a favor de quien trabaja", () => {
    expect(vacationYearBalance({ ...acuerdo, asOf: "2026-03-05" }).accruedDays).toBe(1);
  });

  it("a mitad de año lleva devengada la mitad", () => {
    // Del 5 de marzo al 1 de septiembre de 2026 son 181 días de 365.
    // 30 × 181 / 365 = 14,88 → 15.
    expect(vacationYearBalance({ ...acuerdo, asOf: "2026-09-01" }).accruedDays).toBe(15);
  });

  it("una fecha anterior al año de contrato no devenga nada", () => {
    expect(vacationYearBalance({ ...acuerdo, asOf: "2026-03-04" }).accruedDays).toBe(0);
  });

  it("pasado el fin del año de contrato está devengado entero", () => {
    expect(vacationYearBalance({ ...acuerdo, asOf: "2027-06-30" }).accruedDays).toBe(30);
    expect(vacationYearBalance({ ...acuerdo, asOf: "2027-03-04" }).accruedDays).toBe(30);
  });

  it("un contrato terminado devenga hasta su último día, no hasta hoy", () => {
    // El acuerdo acabó el 31 de agosto de 2026: su derecho quedó prorrateado en
    // 15 días y a esa fecha se los había ganado todos. Mirarlo en junio de 2027
    // no le quita ni le añade nada.
    const balance = vacationYearBalance({
      ...acuerdo,
      agreementEndsOn: "2026-08-31",
      asOf: "2027-06-30",
    });
    expect(balance.entitledDays).toBe(15);
    expect(balance.accruedDays).toBe(15);
  });

  it("lo devengado y lo que queda son dos cifras distintas, y las dos son ciertas", () => {
    // En agosto ha disfrutado 20 días de los 30 del año: le quedan 10 para lo
    // que resta de año de contrato, pero ha gastado por delante de lo devengado.
    const balance = vacationYearBalance({
      ...acuerdo,
      periods: [{ startsOn: "2026-08-01", endsOn: "2026-08-20" }],
      asOf: "2026-09-01",
    });
    expect(balance.takenDays).toBe(20);
    expect(balance.remainingDays).toBe(10);
    expect(balance.accruedDays).toBe(15);
    expect(balance.availableNowDays).toBe(-5);
  });

  it("disfrutar por adelantado no se recorta a cero: se enseña en negativo", () => {
    const balance = vacationYearBalance({
      ...acuerdo,
      periods: [{ startsOn: "2026-03-09", endsOn: "2026-03-18" }],
      asOf: "2026-03-20",
    });
    expect(balance.accruedDays).toBe(2);
    expect(balance.availableNowDays).toBe(-8);
  });
});

describe("compensación de los días sin disfrutar", () => {
  it("multiplica la tarifa pactada por los días y congela la frase", () => {
    const compensation = vacationCompensation({
      dayRateCents: parseEuroCents("46.15"),
      rateEffectiveFrom: "2026-03-05",
      unusedDays: 18,
    });
    expect(compensation?.compensationCents).toBe(83_070n);
    // El espacio que va antes del € es duro, y por eso se escribe escapado: lo
    // pone `formatEuroCents` para que el importe y su símbolo no acaben en dos
    // renglones distintos.
    expect(compensation?.basis).toBe(
      "18 días sin disfrutar × 46,15\u00a0€ por día, pactados en las condiciones " +
        "vigentes desde el 5 de marzo de 2026 = 830,70\u00a0€",
    );
  });

  it("sin tarifa pactada no hay compensación posible: devuelve la ausencia, no un cero", () => {
    expect(
      vacationCompensation({
        dayRateCents: null,
        rateEffectiveFrom: "2026-03-05",
        unusedDays: 18,
      }),
    ).toBeNull();
  });

  it("un solo día se dice en singular", () => {
    const compensation = vacationCompensation({
      dayRateCents: parseEuroCents("46.15"),
      rateEffectiveFrom: "2026-03-05",
      unusedDays: 1,
    });
    expect(compensation?.basis).toContain("1 día sin disfrutar × 46,15\u00a0€ por día");
  });

  it("el importe es exacto en céntimos: ni un céntimo de error de coma flotante", () => {
    // 4.618,35 € × 7 = 32.328,45 € exactos. En coma flotante ese mismo producto
    // ni siquiera da el número: da 32328.450000000004.
    const rate = parseEuroCents("4618.35");
    const compensation = vacationCompensation({
      dayRateCents: rate,
      rateEffectiveFrom: "2026-03-05",
      unusedDays: 7,
    });
    expect(compensation?.compensationCents).toBe(3_232_845n);
    expect(compensation?.basis).toContain("32.328,45\u00a0€");
    // La prueba de que el atajo fácil arrastra error desde el primer paso.
    expect(4618.35 * 7).not.toBe(32_328.45);
  });

  it("cero días sin disfrutar no es un caso raro: son cero euros", () => {
    const compensation = vacationCompensation({
      dayRateCents: parseEuroCents("46.15"),
      rateEffectiveFrom: "2026-03-05",
      unusedDays: 0,
    });
    expect(compensation?.compensationCents).toBe(0n);
    expect(compensation?.basis).toContain("0 días sin disfrutar");
  });

  it("rechaza días fraccionarios y una tarifa negativa", () => {
    expect(
      domainCode(() =>
        vacationCompensation({
          dayRateCents: parseEuroCents("46.15"),
          rateEffectiveFrom: "2026-03-05",
          unusedDays: 2.5,
        }),
      ),
    ).toBe("INVALID_VACATION_UNUSED_DAYS");
    expect(
      domainCode(() =>
        vacationCompensation({
          dayRateCents: moneyCents(-1n),
          rateEffectiveFrom: "2026-03-05",
          unusedDays: 3,
        }),
      ),
    ).toBe("INVALID_VACATION_DAY_RATE");
  });
});

describe("lo que todavía no se le ha contado", () => {
  const apuntado = (
    startsOn: string,
    endsOn: string,
    recordedAt: string,
  ): VacationEventInput => ({ startsOn, endsOn, status: "recorded", recordedAt, voidedAt: null });

  const anulado = (
    startsOn: string,
    endsOn: string,
    recordedAt: string,
    voidedAt: string,
  ): VacationEventInput => ({ startsOn, endsOn, status: "voided", recordedAt, voidedAt });

  it("sin haber mirado nunca, todo lo vigente es nuevo", () => {
    const news = vacationNewsSince(
      [apuntado("2026-08-01", "2026-08-15", "2026-07-20T10:00:00Z")],
      null,
    );
    expect(news.count).toBe(1);
    expect(news.recorded).toHaveLength(1);
    expect(news.voided).toHaveLength(0);
  });

  it("lo apuntado antes de la última mirada ya no es noticia", () => {
    const news = vacationNewsSince(
      [
        apuntado("2026-08-01", "2026-08-15", "2026-07-20T10:00:00Z"),
        apuntado("2026-12-24", "2026-12-31", "2026-08-02T09:00:00Z"),
      ],
      "2026-08-01T00:00:00Z",
    );
    expect(news.count).toBe(1);
    expect(news.recorded[0]?.startsOn).toBe("2026-12-24");
  });

  it("una anulación posterior a su mirada sí se le cuenta", () => {
    const news = vacationNewsSince(
      [anulado("2026-03-02", "2026-03-06", "2026-02-01T10:00:00Z", "2026-08-05T12:00:00Z")],
      "2026-08-01T00:00:00Z",
    );
    expect(news.recorded).toHaveLength(0);
    expect(news.voided).toHaveLength(1);
  });

  it("lo que nació y murió entre dos miradas suyas no se cuenta", () => {
    const news = vacationNewsSince(
      [anulado("2026-03-02", "2026-03-06", "2026-08-03T10:00:00Z", "2026-08-04T12:00:00Z")],
      "2026-08-01T00:00:00Z",
    );
    expect(news.count).toBe(0);
  });

  it("la marca de agua es el sello más reciente de todo lo mirado, no solo de lo nuevo", () => {
    const news = vacationNewsSince(
      [
        apuntado("2026-08-01", "2026-08-15", "2026-07-20T10:00:00Z"),
        anulado("2026-03-02", "2026-03-06", "2026-02-01T10:00:00Z", "2026-09-09T08:30:00Z"),
      ],
      "2026-10-01T00:00:00Z",
    );
    expect(news.count).toBe(0);
    expect(news.newestAt).toBe("2026-09-09T08:30:00Z");
  });

  it("sin ningún periodo no hay marca que guardar", () => {
    expect(vacationNewsSince([], null)).toMatchObject({ count: 0, newestAt: null });
  });

  it("lo nuevo se ordena de lo último apuntado a lo primero", () => {
    const news = vacationNewsSince(
      [
        apuntado("2026-08-01", "2026-08-15", "2026-07-20T10:00:00Z"),
        apuntado("2026-12-24", "2026-12-31", "2026-07-25T10:00:00Z"),
      ],
      null,
    );
    expect(news.recorded.map((period) => period.startsOn)).toEqual(["2026-12-24", "2026-08-01"]);
  });

  it("rechaza un sello que no es un instante", () => {
    expect(
      domainCode(() => vacationNewsSince([apuntado("2026-08-01", "2026-08-15", "ayer")], null)),
    ).toBe("INVALID_VACATION_INSTANT");
  });
});

describe("el nombre del año de contrato", () => {
  it("usa el ordinal que diría una persona hasta el décimo", () => {
    expect(contractYearName(1)).toBe("primer año");
    expect(contractYearName(2)).toBe("segundo año");
    expect(contractYearName(10)).toBe("décimo año");
  });

  it("a partir de ahí lo dice con el número, que sí se lee en voz alta", () => {
    expect(contractYearName(11)).toBe("año 11");
    expect(contractYearName(37)).toBe("año 37");
  });
});

describe("caducidad de los días arrastrados", () => {
  it("ausente son seis meses: ningún contrato ya firmado necesita tocarse", () => {
    expect(readVacationCarryoverExpiry({})).toEqual({ mode: "months", months: 6 });
    expect(readVacationCarryoverExpiry(null)).toEqual({ mode: "months", months: 6 });
    expect(readVacationCarryoverExpiry(undefined)).toEqual({ mode: "months", months: 6 });
  });

  it("lee las dos formas pactadas", () => {
    expect(
      readVacationCarryoverExpiry({ vacationCarryoverExpiry: { mode: "never" } }),
    ).toEqual({ mode: "never" });
    expect(
      readVacationCarryoverExpiry({ vacationCarryoverExpiry: { mode: "months", months: 12 } }),
    ).toEqual({ mode: "months", months: 12 });
  });

  it("una política ilegible NO es «sin caducidad»: es la de por omisión", () => {
    // Es la diferencia entre no haber pactado nada y haber pactado que nunca
    // expiren. Confundirlas regalaría días que nadie acordó regalar.
    expect(readVacationCarryoverExpiry({ vacationCarryoverExpiry: "seis meses" })).toEqual({
      mode: "months",
      months: 6,
    });
    expect(
      readVacationCarryoverExpiry({ vacationCarryoverExpiry: { mode: "months", months: 0 } }),
    ).toEqual({ mode: "months", months: 6 });
    expect(
      readVacationCarryoverExpiry({ vacationCarryoverExpiry: { mode: "months", months: 1.5 } }),
    ).toEqual({ mode: "months", months: 6 });
  });

  it("el margen se cuenta desde el fin del año de contrato", () => {
    expect(vacationCarryoverDeadline("2027-03-04", { mode: "months", months: 6 })).toBe(
      "2027-09-04",
    );
    expect(vacationCarryoverDeadline("2026-12-31", { mode: "months", months: 3 })).toBe(
      "2027-03-31",
    );
  });

  it("clava el día al último del mes cuando el día no existe", () => {
    // El 31 de agosto más seis meses no es el 3 de marzo.
    expect(vacationCarryoverDeadline("2026-08-31", { mode: "months", months: 6 })).toBe(
      "2027-02-28",
    );
  });

  it("«nunca expiran» no tiene fecha límite, y eso es una respuesta", () => {
    expect(vacationCarryoverDeadline("2027-03-04", { mode: "never" })).toBeNull();
  });

  it("rechaza una fecha que no es fecha y un margen imposible", () => {
    expect(domainCode(() => vacationCarryoverDeadline("ayer", { mode: "never" }))).toBe(
      "INVALID_VACATION_DATE",
    );
    expect(
      domainCode(() => vacationCarryoverDeadline("2027-03-04", { mode: "months", months: 0 })),
    ).toBe("INVALID_VACATION_CARRYOVER_EXPIRY");
  });
});
