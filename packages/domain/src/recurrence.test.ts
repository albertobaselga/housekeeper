import { afterEach, describe, expect, it } from "vitest";

import {
  DomainRuleError,
  MAX_OCCURRENCES_PER_CALL,
  PENDING_LOOKBACK_DAYS,
  SEASONS,
  cadenceClause,
  cadencePhrase,
  monthName,
  nextOccurrenceOnOrAfter,
  occurrenceHistory,
  occurrencesBetween,
  overduePolicyFor,
  pendingFor,
  spanishDateLabel,
  weekdayName,
  type RoutineRule,
  type RoutineSchedule,
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

/**
 * Réplica de la aritmética VIEJA —`app.advance_routine_after_completion` de la
 * migración 0009, `advanceDueDate` de `rhythm.ts` y `nextRoutineDue` de
 * `apps/web/src/lib/food/dates.ts`, las tres idénticas—: avanza desde la
 * ocurrencia COMPLETADA. Vive aquí solo para que la contraprueba del día 31
 * deje escrito qué se arregla; el código de producción no debe volver a tenerla.
 */
function legacyAdvanceFromCompleted(dueOn: string, months: number): string {
  const year = Number(dueOn.slice(0, 4));
  const monthIndex = Number(dueOn.slice(5, 7)) - 1;
  const day = Number(dueOn.slice(8, 10));
  const total = monthIndex + months;
  const targetYear = year + Math.floor(total / 12);
  const targetMonth = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("todos los días y «cada N días» (every_n_days)", () => {
  const diaria: RoutineRule = { pattern: "every_n_days", anchorOn: "2026-08-01", repeatEvery: 1 };

  it("todos los días es un día detrás de otro, extremos incluidos", () => {
    expect(occurrencesBetween(diaria, "2026-08-08", "2026-08-12")).toEqual([
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
    ]);
  });

  it("«cada 3 días» mantiene la fase del ancla aunque la ventana empiece en medio", () => {
    const cada3: RoutineRule = { pattern: "every_n_days", anchorOn: "2026-08-01", repeatEvery: 3 };
    // 01, 04, 07, 10, 13 … la ventana empieza el 05 y la fase no se pierde.
    expect(occurrencesBetween(cada3, "2026-08-05", "2026-08-14")).toEqual([
      "2026-08-07",
      "2026-08-10",
      "2026-08-13",
    ]);
  });

  it("nunca emite nada anterior al ancla, aunque la ventana empiece mucho antes", () => {
    expect(occurrencesBetween(diaria, "2020-01-01", "2026-08-03")).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
  });

  it("genera HACIA ATRÁS: una ventana entera en el pasado se puede pintar (E4)", () => {
    const antigua: RoutineRule = { pattern: "every_n_days", anchorOn: "2019-03-04", repeatEvery: 7 };
    expect(occurrencesBetween(antigua, "2020-05-01", "2020-05-31")).toEqual([
      "2020-05-04",
      "2020-05-11",
      "2020-05-18",
      "2020-05-25",
    ]);
  });

  it("cruza el 29 de febrero de un bisiesto sin perder ni repetir un día", () => {
    const bisiesto: RoutineRule = { pattern: "every_n_days", anchorOn: "2028-02-26", repeatEvery: 1 };
    expect(occurrencesBetween(bisiesto, "2028-02-26", "2028-03-02")).toEqual([
      "2028-02-26",
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
      "2028-03-02",
    ]);
  });

  it("cruza el cambio de año", () => {
    expect(occurrencesBetween(diaria, "2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  it("un ancla en el futuro no genera nada hasta que llega (caso 8)", () => {
    const futura: RoutineRule = { pattern: "every_n_days", anchorOn: "2027-01-15", repeatEvery: 1 };
    expect(occurrencesBetween(futura, "2026-08-01", "2026-12-31")).toEqual([]);
    expect(occurrencesBetween(futura, "2027-01-14", "2027-01-16")).toEqual([
      "2027-01-15",
      "2027-01-16",
    ]);
  });

  it("con `endsOn` ya pasado no genera nada, ni hacia atrás ni hacia delante (caso 9)", () => {
    const terminada: RoutineRule = {
      pattern: "every_n_days",
      anchorOn: "2026-01-01",
      repeatEvery: 1,
      endsOn: "2026-01-10",
    };
    expect(occurrencesBetween(terminada, "2026-08-01", "2026-08-31")).toEqual([]);
    expect(occurrencesBetween(terminada, "2026-01-08", "2026-12-31")).toEqual([
      "2026-01-08",
      "2026-01-09",
      "2026-01-10",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("cambio de hora y zona del proceso", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  const diaria: RoutineRule = { pattern: "every_n_days", anchorOn: "2026-03-01", repeatEvery: 1 };

  it("el 29 de marzo de 2026 (Madrid adelanta) no se pierde ni se duplica (caso 7)", () => {
    process.env.TZ = "Europe/Madrid";
    const dias = occurrencesBetween(diaria, "2026-03-27", "2026-03-31");
    expect(dias).toEqual(["2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]);
  });

  it("el 25 de octubre de 2026 (Madrid atrasa) tampoco (caso 7)", () => {
    process.env.TZ = "Europe/Madrid";
    const otonal: RoutineRule = { pattern: "every_n_days", anchorOn: "2026-10-01", repeatEvery: 1 };
    expect(occurrencesBetween(otonal, "2026-10-23", "2026-10-27")).toEqual([
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
    ]);
  });

  it("el resultado es idéntico en UTC+14 y en UTC-11: ninguna función usa la zona del proceso", () => {
    const semanal: RoutineRule = {
      pattern: "days_of_week",
      anchorOn: "2026-08-10",
      repeatEvery: 1,
      weekdays: [1, 4],
    };
    const mensual: RoutineRule = {
      pattern: "day_of_month",
      anchorOn: "2026-01-31",
      repeatEvery: 1,
      monthDay: 31,
    };

    process.env.TZ = "Pacific/Kiritimati"; // UTC+14
    const adelantado = [
      occurrencesBetween(diaria, "2026-03-27", "2026-03-31"),
      occurrencesBetween(semanal, "2026-08-01", "2026-09-01"),
      occurrencesBetween(mensual, "2026-01-01", "2026-06-30"),
      spanishDateLabel("2026-08-17"),
    ];

    process.env.TZ = "Pacific/Niue"; // UTC-11
    const atrasado = [
      occurrencesBetween(diaria, "2026-03-27", "2026-03-31"),
      occurrencesBetween(semanal, "2026-08-01", "2026-09-01"),
      occurrencesBetween(mensual, "2026-01-01", "2026-06-30"),
      spanishDateLabel("2026-08-17"),
    ];

    expect(atrasado).toEqual(adelantado);
    expect(adelantado[3]).toBe("lunes 17 de agosto");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("días fijos de la semana (days_of_week)", () => {
  it("«los lunes y los jueves» da los dos días de cada semana", () => {
    const cocina: RoutineRule = {
      pattern: "days_of_week",
      anchorOn: "2026-08-10",
      repeatEvery: 1,
      weekdays: [1, 4],
    };
    expect(occurrencesBetween(cocina, "2026-08-10", "2026-08-23")).toEqual([
      "2026-08-10",
      "2026-08-13",
      "2026-08-17",
      "2026-08-20",
    ]);
  });

  it("con el ancla a mitad de semana, los días anteriores de esa semana no se emiten (caso 3)", () => {
    const anclaJueves: RoutineRule = {
      pattern: "days_of_week",
      anchorOn: "2026-08-13",
      repeatEvery: 1,
      weekdays: [1, 4],
    };
    // El lunes 10 es anterior al ancla: no resucita.
    expect(occurrencesBetween(anclaJueves, "2026-08-01", "2026-08-24")).toEqual([
      "2026-08-13",
      "2026-08-17",
      "2026-08-20",
      "2026-08-24",
    ]);
  });

  it("«cada 2 semanas» con el ancla en DOMINGO cuenta desde el lunes anterior (WKST=MO, caso 2)", () => {
    // 2026-08-16 es domingo; su semana empieza el lunes 2026-08-10, que es la
    // semana 0. La siguiente semana activa arranca el lunes 2026-08-24.
    const quincenal: RoutineRule = {
      pattern: "days_of_week",
      anchorOn: "2026-08-16",
      repeatEvery: 2,
      weekdays: [1],
    };
    expect(occurrencesBetween(quincenal, "2026-08-01", "2026-09-30")).toEqual([
      "2026-08-24",
      "2026-09-07",
      "2026-09-21",
    ]);
  });

  it("con el domingo dentro de los días marcados, el ancla en domingo sí se emite", () => {
    const quincenal: RoutineRule = {
      pattern: "days_of_week",
      anchorOn: "2026-08-16",
      repeatEvery: 2,
      weekdays: [1, 7],
    };
    expect(occurrencesBetween(quincenal, "2026-08-01", "2026-09-08")).toEqual([
      "2026-08-16",
      "2026-08-24",
      "2026-08-30",
      "2026-09-07",
    ]);
  });

  it("la alternancia de «cada 2 semanas» sobrevive al cambio de año (la semana ISO se reinicia, el conteo de lunes no)", () => {
    // 2026 tiene 53 semanas ISO: numerar semanas rompería la cuenta aquí.
    const quincenal: RoutineRule = {
      pattern: "days_of_week",
      anchorOn: "2026-12-28",
      repeatEvery: 2,
      weekdays: [1],
    };
    expect(occurrencesBetween(quincenal, "2026-12-01", "2027-02-15")).toEqual([
      "2026-12-28",
      "2027-01-11",
      "2027-01-25",
      "2027-02-08",
    ]);
  });

  it("una semana que cruza el año emite sus días a los dos lados", () => {
    const laborables: RoutineRule = {
      pattern: "days_of_week",
      anchorOn: "2026-01-05",
      repeatEvery: 1,
      weekdays: [1, 3, 5],
    };
    expect(occurrencesBetween(laborables, "2026-12-28", "2027-01-04")).toEqual([
      "2026-12-28",
      "2026-12-30",
      "2027-01-01",
      "2027-01-04",
    ]);
  });

  it("acepta los días desordenados y con duplicados: los normaliza como la base", () => {
    const desordenada: RoutineRule = {
      pattern: "days_of_week",
      anchorOn: "2026-08-10",
      repeatEvery: 1,
      weekdays: [4, 1, 4],
    };
    expect(occurrencesBetween(desordenada, "2026-08-10", "2026-08-16")).toEqual([
      "2026-08-10",
      "2026-08-13",
    ]);
  });

  it("hacia atrás desde una ventana pasada mantiene la misma fase (E4)", () => {
    const quincenal: RoutineRule = {
      pattern: "days_of_week",
      anchorOn: "2026-01-05",
      repeatEvery: 2,
      weekdays: [1],
    };
    expect(occurrencesBetween(quincenal, "2026-02-01", "2026-03-15")).toEqual([
      "2026-02-02",
      "2026-02-16",
      "2026-03-02",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("cada cierto tiempo en meses (day_of_month): RECORTE Y NO SALTO", () => {
  const dia31: RoutineRule = {
    pattern: "day_of_month",
    anchorOn: "2026-01-31",
    repeatEvery: 1,
    monthDay: 31,
  };

  it("31 de enero → 28 de febrero → 31 de MARZO: el recorte no se hereda (caso 4)", () => {
    expect(occurrencesBetween(dia31, "2026-01-01", "2026-06-30")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
    ]);
  });

  it("contraprueba: la aritmética vieja, que avanzaba desde la ocurrencia completada, derivaba a 28 para siempre", () => {
    // Éste es el fallo real que arregla generar desde el ancla.
    const primera = "2026-01-31";
    const segunda = legacyAdvanceFromCompleted(primera, 1);
    const tercera = legacyAdvanceFromCompleted(segunda, 1);
    const cuarta = legacyAdvanceFromCompleted(tercera, 1);
    expect([segunda, tercera, cuarta]).toEqual(["2026-02-28", "2026-03-28", "2026-04-28"]);

    const nuevas = occurrencesBetween(dia31, "2026-01-01", "2026-04-30");
    expect(nuevas).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(nuevas[2]).not.toBe(tercera);
  });

  it("en año bisiesto recorta a 29 y vuelve a 31 en marzo", () => {
    const bisiesta: RoutineRule = { ...dia31, anchorOn: "2028-01-31" };
    expect(occurrencesBetween(bisiesta, "2028-01-01", "2028-03-31")).toEqual([
      "2028-01-31",
      "2028-02-29",
      "2028-03-31",
    ]);
  });

  it("`monthDay = -1` es siempre el último día del mes (caso 5)", () => {
    const ultimo: RoutineRule = {
      pattern: "day_of_month",
      anchorOn: "2028-01-31",
      repeatEvery: 1,
      monthDay: -1,
    };
    expect(occurrencesBetween(ultimo, "2028-01-01", "2028-04-30")).toEqual([
      "2028-01-31",
      "2028-02-29",
      "2028-03-31",
      "2028-04-30",
    ]);
  });

  it("«cada 3 meses» mantiene la fase del ancla aunque la ventana empiece en un mes muerto", () => {
    const trimestral: RoutineRule = {
      pattern: "day_of_month",
      anchorOn: "2026-01-15",
      repeatEvery: 3,
      monthDay: 15,
    };
    expect(occurrencesBetween(trimestral, "2026-02-01", "2027-02-28")).toEqual([
      "2026-04-15",
      "2026-07-15",
      "2026-10-15",
      "2027-01-15",
    ]);
  });

  it("admite 36 meses, que es el `quarterly` con intervalo 12 heredado de la 0008", () => {
    const cada36: RoutineRule = {
      pattern: "day_of_month",
      anchorOn: "2026-05-10",
      repeatEvery: 36,
      monthDay: 10,
    };
    expect(occurrencesBetween(cada36, "2026-01-01", "2035-12-31")).toEqual([
      "2026-05-10",
      "2029-05-10",
      "2032-05-10",
      "2035-05-10",
    ]);
  });

  it("el mes del ancla se emite solo si su día no es anterior al ancla", () => {
    const dia15: RoutineRule = {
      pattern: "day_of_month",
      anchorOn: "2026-01-31",
      repeatEvery: 1,
      monthDay: 15,
    };
    expect(occurrencesBetween(dia15, "2026-01-01", "2026-03-31")).toEqual([
      "2026-02-15",
      "2026-03-15",
    ]);
  });

  it("cruza el cambio de año sin saltarse diciembre ni enero", () => {
    const mensual: RoutineRule = {
      pattern: "day_of_month",
      anchorOn: "2026-11-01",
      repeatEvery: 1,
      monthDay: 1,
    };
    expect(occurrencesBetween(mensual, "2026-11-01", "2027-02-01")).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
      "2027-02-01",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("por temporada (months_of_year)", () => {
  const temporada: RoutineRule = {
    pattern: "months_of_year",
    anchorOn: "2026-06-01",
    months: [6, 12],
    monthDay: 1,
  };

  it("«en verano y en invierno» son el 1 de junio y el 1 de diciembre, todos los años (caso 6)", () => {
    expect(occurrencesBetween(temporada, "2026-01-01", "2028-12-31")).toEqual([
      "2026-06-01",
      "2026-12-01",
      "2027-06-01",
      "2027-12-01",
      "2028-06-01",
      "2028-12-01",
    ]);
  });

  it("el año del ancla no emite los meses anteriores al ancla", () => {
    const cuatroEstaciones: RoutineRule = {
      pattern: "months_of_year",
      anchorOn: "2026-06-01",
      months: [3, 6, 9, 12],
      monthDay: 1,
    };
    expect(occurrencesBetween(cuatroEstaciones, "2026-01-01", "2027-03-31")).toEqual([
      "2026-06-01",
      "2026-09-01",
      "2026-12-01",
      "2027-03-01",
      // marzo de 2026 queda fuera: es anterior al ancla.
    ]);
  });

  it("«el 29 de febrero» se recorta a 28 los años normales y cae el 29 en bisiesto (caso 6)", () => {
    const bisiesta: RoutineRule = {
      pattern: "months_of_year",
      anchorOn: "2026-01-01",
      months: [2],
      monthDay: 29,
    };
    expect(occurrencesBetween(bisiesta, "2026-01-01", "2029-12-31")).toEqual([
      "2026-02-28",
      "2027-02-28",
      "2028-02-29",
      "2029-02-28",
    ]);
  });

  it("`monthDay = -1` da el último día del mes de temporada", () => {
    const finDeMes: RoutineRule = {
      pattern: "months_of_year",
      anchorOn: "2026-01-01",
      months: [2, 6],
      monthDay: -1,
    };
    expect(occurrencesBetween(finDeMes, "2026-01-01", "2027-12-31")).toEqual([
      "2026-02-28",
      "2026-06-30",
      "2027-02-28",
      "2027-06-30",
    ]);
  });

  it("respeta `endsOn` a mitad de serie", () => {
    const acotada: RoutineRule = { ...temporada, endsOn: "2027-07-01" };
    expect(occurrencesBetween(acotada, "2026-01-01", "2030-12-31")).toEqual([
      "2026-06-01",
      "2026-12-01",
      "2027-06-01",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("«todavía no se sabe»: una rutina sin patrón no genera NADA, nunca", () => {
  const sinCadencia: RoutineSchedule = null;

  it("no genera ocurrencias ni en un siglo de ventana", () => {
    expect(occurrencesBetween(sinCadencia, "1970-01-01", "2070-12-31")).toEqual([]);
  });

  it("tampoco hacia atrás", () => {
    expect(occurrencesBetween(sinCadencia, "1999-01-01", "2000-01-01")).toEqual([]);
  });

  it("no tiene próxima fecha", () => {
    expect(nextOccurrenceOnOrAfter(sinCadencia, "2026-08-10")).toBeNull();
  });

  it("no aparece en Hoy: ni vencidas, ni de hoy, ni próximas, ni caché", () => {
    expect(pendingFor(sinCadencia, "carry", new Set(), "2026-08-10")).toEqual({
      due: [],
      overdue: null,
      upcoming: [],
      nextDueHint: null,
    });
  });

  it("no tiene historial que enseñar aunque haya finalizaciones registradas", () => {
    expect(
      occurrenceHistory(sinCadencia, {
        fromISO: "2020-01-01",
        toISO: "2030-01-01",
        todayISO: "2026-08-10",
        completions: [{ dueOn: "2026-08-09", completedByName: "Marta" }],
      }),
    ).toEqual([]);
  });

  it("se dice con la frase exacta del acuerdo", () => {
    expect(cadencePhrase(sinCadencia)).toBe("Sin día todavía. No aparecerá en Hoy.");
    expect(cadenceClause(sinCadencia)).toBe("sin día todavía");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("la política de atraso se deriva del patrón (§2.5)", () => {
  it("sub-semanal se pasa por alto", () => {
    expect(overduePolicyFor({ pattern: "every_n_days", anchorOn: "2026-01-01", repeatEvery: 1 })).toBe("skip");
    expect(overduePolicyFor({ pattern: "every_n_days", anchorOn: "2026-01-01", repeatEvery: 6 })).toBe("skip");
    expect(
      overduePolicyFor({
        pattern: "days_of_week",
        anchorOn: "2026-01-01",
        repeatEvery: 1,
        weekdays: [1, 4],
      }),
    ).toBe("skip");
  });

  it("«cada 2 semanas los lunes» también es sub-semanal a estos efectos", () => {
    expect(
      overduePolicyFor({
        pattern: "days_of_week",
        anchorOn: "2026-01-05",
        repeatEvery: 2,
        weekdays: [1],
      }),
    ).toBe("skip");
  });

  it("de semanal para arriba se arrastra", () => {
    expect(overduePolicyFor({ pattern: "every_n_days", anchorOn: "2026-01-01", repeatEvery: 7 })).toBe("carry");
    expect(overduePolicyFor({ pattern: "every_n_days", anchorOn: "2026-01-01", repeatEvery: 15 })).toBe("carry");
    expect(
      overduePolicyFor({
        pattern: "day_of_month",
        anchorOn: "2026-01-01",
        repeatEvery: 1,
        monthDay: 1,
      }),
    ).toBe("carry");
    expect(
      overduePolicyFor({
        pattern: "months_of_year",
        anchorOn: "2026-06-01",
        months: [6, 12],
        monthDay: 1,
      }),
    ).toBe("carry");
  });

  it("una rutina sin cadencia toma el DEFAULT de la columna, que da igual porque nunca vence", () => {
    expect(overduePolicyFor(null)).toBe("carry");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("lo que sale en Hoy (pendingFor)", () => {
  const diaria: RoutineRule = { pattern: "every_n_days", anchorOn: "2026-01-01", repeatEvery: 1 };
  const sabanas: RoutineRule = {
    pattern: "day_of_month",
    anchorOn: "2026-01-05",
    repeatEvery: 1,
    monthDay: 5,
  };

  it("con `skip` y diez días sin hacer no hay ninguna vencida (caso 12)", () => {
    const hoy = pendingFor(diaria, "skip", new Set(), "2026-08-10");
    expect(hoy.overdue).toBeNull();
    expect(hoy.due).toEqual(["2026-08-10"]);
    expect(hoy.upcoming).toEqual(["2026-08-11", "2026-08-12", "2026-08-13"]);
    expect(hoy.nextDueHint).toBe("2026-08-10");
  });

  it("con `carry` y varias perdidas se enseña UNA sola, la más antigua (caso 11)", () => {
    const hoy = pendingFor(sabanas, "carry", new Set(), "2026-08-10");
    expect(hoy.overdue).toBe("2026-01-05");
    expect(hoy.due).toEqual([]);
    expect(hoy.upcoming).toEqual(["2026-09-05", "2026-10-05", "2026-11-05"]);
    expect(hoy.nextDueHint).toBe("2026-01-05");
  });

  it("con `carry`, marcar la más antigua saca a la luz la siguiente, no una lista", () => {
    const hechas = new Set(["2026-01-05", "2026-02-05"]);
    expect(pendingFor(sabanas, "carry", hechas, "2026-08-10").overdue).toBe("2026-03-05");
  });

  it("la ocurrencia de hoy ya marcada deja de estar «por hacer»", () => {
    const hoy = pendingFor(diaria, "skip", new Set(["2026-08-10"]), "2026-08-10");
    expect(hoy.due).toEqual([]);
    expect(hoy.nextDueHint).toBe("2026-08-11");
  });

  it("«los lunes y los jueves»: marcar el lunes deja el JUEVES de la misma semana (caso 1)", () => {
    const cocina: RoutineRule = {
      pattern: "days_of_week",
      anchorOn: "2026-08-10",
      repeatEvery: 1,
      weekdays: [1, 4],
    };
    const lunes = pendingFor(cocina, "skip", new Set(["2026-08-10"]), "2026-08-10");
    expect(lunes.due).toEqual([]);
    // El chip optimista dice el jueves, no el lunes siguiente.
    expect(lunes.upcoming[0]).toBe("2026-08-13");
    expect(lunes.nextDueHint).toBe("2026-08-13");
  });

  it("no propone como próximas las ocurrencias futuras ya marcadas", () => {
    const hechas = new Set(["2026-08-11", "2026-08-12"]);
    expect(pendingFor(diaria, "skip", hechas, "2026-08-10").upcoming).toEqual([
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
    ]);
  });

  it("una rutina anclada en el futuro no vence hoy, pero sí anuncia su próxima (caso 8)", () => {
    const futura: RoutineRule = { pattern: "every_n_days", anchorOn: "2027-01-15", repeatEvery: 1 };
    const hoy = pendingFor(futura, "skip", new Set(), "2026-08-10");
    expect(hoy.due).toEqual([]);
    expect(hoy.overdue).toBeNull();
    expect(hoy.upcoming[0]).toBe("2027-01-15");
    expect(hoy.nextDueHint).toBe("2027-01-15");
  });

  it("con `endsOn` pasado no hay nada pendiente ni caché que refrescar (caso 9)", () => {
    const terminada: RoutineRule = { ...diaria, endsOn: "2026-02-01" };
    // Ni siquiera con `carry` y con enero entero sin marcar: una rutina
    // terminada deja de pedir. «No genera nada, no aparece, no avisa.»
    expect(pendingFor(terminada, "carry", new Set(), "2026-08-10")).toEqual({
      due: [],
      overdue: null,
      upcoming: [],
      nextDueHint: null,
    });
  });

  it("el último día de una rutina que acaba hoy todavía toca", () => {
    const acabaHoy: RoutineRule = { ...diaria, endsOn: "2026-08-10" };
    const hoy = pendingFor(acabaHoy, "carry", new Set(), "2026-08-10");
    expect(hoy.due).toEqual(["2026-08-10"]);
    expect(hoy.upcoming).toEqual([]);
  });

  it("un ancla muy antigua se corta por la ventana de rescate y sigue siendo barata (caso 10)", () => {
    const antigua: RoutineRule = { pattern: "every_n_days", anchorOn: "2019-01-01", repeatEvery: 1 };
    const inicio = performance.now();
    const hoy = pendingFor(antigua, "carry", new Set(), "2026-08-10");
    const coste = performance.now() - inicio;
    // No se rescata 2019: se rescatan 400 días.
    expect(hoy.overdue).toBe("2025-07-06");
    expect(hoy.due).toEqual(["2026-08-10"]);
    expect(coste).toBeLessThan(250);
  });

  it("la caché `next_due_hint` nunca es posterior a la ocurrencia real: es cota inferior", () => {
    const hoy = pendingFor(sabanas, "carry", new Set(), "2026-08-10");
    const reales = occurrencesBetween(sabanas, "2026-01-01", "2026-12-31");
    const primeraPendiente = reales.find((dueOn) => dueOn >= "2026-01-05");
    expect(hoy.nextDueHint).toBe(primeraPendiente);
    expect(hoy.nextDueHint! <= "2026-08-10").toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("marcar tarde no mueve el calendario", () => {
  const diaria: RoutineRule = { pattern: "every_n_days", anchorOn: "2026-08-01", repeatEvery: 1 };
  const mensual: RoutineRule = {
    pattern: "day_of_month",
    anchorOn: "2026-01-31",
    repeatEvery: 1,
    monthDay: 31,
  };

  it("completar una ocurrencia perdida la marca y NO desplaza la siguiente (caso 13)", () => {
    const antes = pendingFor(mensual, "carry", new Set(), "2026-08-10");
    expect(antes.overdue).toBe("2026-01-31");

    // El 10 de agosto alguien marca la de enero, siete meses tarde.
    const despues = pendingFor(mensual, "carry", new Set(["2026-01-31"]), "2026-08-10");
    expect(despues.overdue).toBe("2026-02-28");
    // La serie sigue exactamente igual: nadie ha empujado nada.
    expect(occurrencesBetween(mensual, "2026-08-01", "2026-10-31")).toEqual([
      "2026-08-31",
      "2026-09-30",
      "2026-10-31",
    ]);
  });

  it("marcar MUY tarde (dos años después) tampoco cambia una sola fecha", () => {
    const serie = occurrencesBetween(mensual, "2028-01-01", "2028-04-30");
    const conMarcadoTardio = occurrencesBetween(mensual, "2028-01-01", "2028-04-30");
    expect(conMarcadoTardio).toEqual(serie);
    expect(serie).toEqual(["2028-01-31", "2028-02-29", "2028-03-31", "2028-04-30"]);
  });

  it("una rutina diaria olvidada una semana no exige siete toques ni enseña siete líneas", () => {
    // La cinta de correr de hoy: con `skip` la ocurrencia caduca al acabar su día.
    const hoy = pendingFor(diaria, "skip", new Set(), "2026-08-10");
    expect(hoy.overdue).toBeNull();
    expect(hoy.due).toHaveLength(1);
  });

  it("y con `carry` sigue siendo UNA línea, aunque falten noventa", () => {
    const semanal: RoutineRule = { pattern: "every_n_days", anchorOn: "2026-01-01", repeatEvery: 7 };
    const hoy = pendingFor(semanal, "carry", new Set(), "2026-08-10");
    expect(hoy.overdue).toBe("2026-01-01");
    expect(typeof hoy.overdue).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("casar ocurrencias con las finalizaciones registradas (E2/E4)", () => {
  const cocina: RoutineRule = {
    pattern: "days_of_week",
    anchorOn: "2026-08-10",
    repeatEvery: 1,
    weekdays: [1, 4],
  };

  it("dice qué se hizo, qué día tocaba y quién lo marcó", () => {
    const historial = occurrenceHistory(cocina, {
      fromISO: "2026-08-10",
      toISO: "2026-08-20",
      todayISO: "2026-08-17",
      completions: [
        {
          dueOn: "2026-08-10",
          completedOn: "2026-08-10",
          completedAt: "2026-08-10T18:20:00.000Z",
          completedByMembershipId: "m-1",
          completedByName: "Marta",
        },
      ],
    });
    expect(historial.map((o) => [o.dueOn, o.status])).toEqual([
      ["2026-08-10", "done"],
      ["2026-08-13", "missed"],
      ["2026-08-17", "due"],
      ["2026-08-20", "upcoming"],
    ]);
    expect(historial[0]?.completion?.completedByName).toBe("Marta");
    expect(historial[0]?.completedLateDays).toBe(0);
    expect(historial[1]?.completion).toBeNull();
  });

  it("cuenta el retraso del marcado sin mover la ocurrencia", () => {
    const historial = occurrenceHistory(cocina, {
      fromISO: "2026-08-10",
      toISO: "2026-08-14",
      todayISO: "2026-09-30",
      completions: [
        { dueOn: "2026-08-13", completedOn: "2026-08-15" },
        { dueOn: "2026-08-10", completedOn: "2026-09-29" },
      ],
    });
    expect(historial.map((o) => [o.dueOn, o.completedLateDays])).toEqual([
      ["2026-08-10", 50],
      ["2026-08-13", 2],
    ]);
  });

  it("una finalización huérfana (la regla cambió) no se pinta, pero tampoco estorba (caso 15)", () => {
    const historial = occurrenceHistory(cocina, {
      fromISO: "2026-08-10",
      toISO: "2026-08-20",
      todayISO: "2026-08-20",
      completions: [
        { dueOn: "2026-08-11", completedByName: "Marta" }, // martes: ya no es ocurrencia
        { dueOn: "2026-08-13", completedByName: "Ana" },
      ],
    });
    expect(historial.map((o) => o.dueOn)).toEqual([
      "2026-08-10",
      "2026-08-13",
      "2026-08-17",
      "2026-08-20",
    ]);
    expect(historial.find((o) => o.dueOn === "2026-08-13")?.completion?.completedByName).toBe("Ana");
  });

  it("el historial del pasado se puede pedir entero, hacia atrás (E4)", () => {
    const historial = occurrenceHistory(cocina, {
      fromISO: "2026-06-01",
      toISO: "2026-08-09",
      todayISO: "2026-08-10",
      completions: [],
    });
    // El ancla es el 10 de agosto: antes no había rutina que cumplir.
    expect(historial).toEqual([]);
  });

  it("no devuelve NINGÚN agregado que puntúe a nadie: solo hechos con su autoría (AC-26 revisado)", () => {
    const historial = occurrenceHistory(cocina, {
      fromISO: "2026-08-10",
      toISO: "2026-08-20",
      todayISO: "2026-08-20",
      completions: [{ dueOn: "2026-08-10", completedByName: "Marta" }],
    });
    for (const ocurrencia of historial) {
      expect(Object.keys(ocurrencia).sort()).toEqual([
        "completedLateDays",
        "completion",
        "dueOn",
        "status",
      ]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("la cadencia dicha en lengua de casa", () => {
  it("da las frases exactas del acuerdo (§4.1)", () => {
    expect(cadencePhrase({ pattern: "every_n_days", anchorOn: "2026-08-10", repeatEvery: 1 })).toBe(
      "Toca todos los días.",
    );
    expect(
      cadencePhrase({
        pattern: "days_of_week",
        anchorOn: "2026-08-10",
        repeatEvery: 1,
        weekdays: [1, 4],
      }),
    ).toBe("Toca los lunes y los jueves.");
    expect(
      cadencePhrase(
        { pattern: "every_n_days", anchorOn: "2026-08-03", repeatEvery: 14 },
        { todayISO: "2026-08-10" },
      ),
    ).toBe("Toca cada 2 semanas. La próxima, el lunes 17 de agosto.");
    expect(
      cadencePhrase({
        pattern: "months_of_year",
        anchorOn: "2026-06-01",
        months: [6, 12],
        monthDay: 1,
      }),
    ).toBe("Toca al empezar el verano (1 de junio) y al empezar el invierno (1 de diciembre).");
    expect(cadencePhrase(null)).toBe("Sin día todavía. No aparecerá en Hoy.");
  });

  it("no dice «la próxima» cuando la propia frase ya fija el día", () => {
    expect(
      cadencePhrase(
        { pattern: "every_n_days", anchorOn: "2026-08-10", repeatEvery: 1 },
        { todayISO: "2026-08-10" },
      ),
    ).toBe("Toca todos los días.");
    expect(
      cadencePhrase(
        {
          pattern: "months_of_year",
          anchorOn: "2026-03-01",
          months: [3, 9],
          monthDay: 1,
        },
        { todayISO: "2026-08-10" },
      ),
    ).toBe("Toca al empezar la primavera (1 de marzo) y al empezar el otoño (1 de septiembre).");
  });

  it("acepta la próxima fecha ya calculada, para no repetir el trabajo del servidor", () => {
    expect(
      cadencePhrase(
        { pattern: "day_of_month", anchorOn: "2026-01-05", repeatEvery: 1, monthDay: 5 },
        { nextOccurrence: "2026-09-05" },
      ),
    ).toBe("Toca el día 5 de cada mes. La próxima, el sábado 5 de septiembre.");
  });

  it("sin próxima fecha se queda en la cadencia, sin mentir", () => {
    expect(
      cadencePhrase({ pattern: "every_n_days", anchorOn: "2026-08-03", repeatEvery: 14 }),
    ).toBe("Toca cada 2 semanas.");
  });

  it("las cuatro temporadas y los meses sueltos se distinguen", () => {
    expect(
      cadenceClause({
        pattern: "months_of_year",
        anchorOn: "2026-01-01",
        months: [3, 6, 9, 12],
        monthDay: 1,
      }),
    ).toBe("en primavera, en verano, en otoño y en invierno");
    expect(
      cadenceClause({
        pattern: "months_of_year",
        anchorOn: "2026-01-01",
        months: [1, 7],
        monthDay: 1,
      }),
    ).toBe("en enero y en julio");
    expect(
      cadenceClause({
        pattern: "months_of_year",
        anchorOn: "2026-01-01",
        months: [2],
        monthDay: 29,
      }),
    ).toBe("el 29 de febrero");
    expect(
      cadenceClause({
        pattern: "months_of_year",
        anchorOn: "2026-01-01",
        months: [6],
        monthDay: -1,
      }),
    ).toBe("el último día de junio");
  });

  it("la cadencia compacta de la segunda línea de cada fila", () => {
    expect(cadenceClause({ pattern: "every_n_days", anchorOn: "2026-08-10", repeatEvery: 1 })).toBe(
      "todos los días",
    );
    expect(cadenceClause({ pattern: "every_n_days", anchorOn: "2026-08-10", repeatEvery: 3 })).toBe(
      "cada 3 días",
    );
    expect(cadenceClause({ pattern: "every_n_days", anchorOn: "2026-08-10", repeatEvery: 7 })).toBe(
      "cada semana",
    );
    expect(cadenceClause({ pattern: "every_n_days", anchorOn: "2026-08-10", repeatEvery: 14 })).toBe(
      "cada 2 semanas",
    );
    expect(
      cadenceClause({
        pattern: "days_of_week",
        anchorOn: "2026-08-10",
        repeatEvery: 2,
        weekdays: [1],
      }),
    ).toBe("cada 2 semanas, los lunes");
    expect(
      cadenceClause({
        pattern: "days_of_week",
        anchorOn: "2026-08-10",
        repeatEvery: 1,
        weekdays: [6, 7],
      }),
    ).toBe("los sábados y los domingos");
    expect(
      cadenceClause({
        pattern: "day_of_month",
        anchorOn: "2026-08-01",
        repeatEvery: 1,
        monthDay: 1,
      }),
    ).toBe("el día 1 de cada mes");
    expect(
      cadenceClause({
        pattern: "day_of_month",
        anchorOn: "2026-08-31",
        repeatEvery: 3,
        monthDay: -1,
      }),
    ).toBe("cada 3 meses, el último día");
  });

  it("nombra días y meses para las etiquetas accesibles", () => {
    expect(weekdayName(1)).toBe("lunes");
    expect(weekdayName(7)).toBe("domingo");
    expect(monthName(9)).toBe("septiembre");
    expect(spanishDateLabel("2026-08-13")).toBe("jueves 13 de agosto");
    expect(spanishDateLabel("2026-08-13", { weekday: false })).toBe("13 de agosto");
    expect(spanishDateLabel("2026-08-13", { year: true })).toBe("jueves 13 de agosto de 2026");
  });

  it("las temporadas son las meteorológicas, que no se mueven de año en año", () => {
    expect(SEASONS.map((season) => [season.key, season.month])).toEqual([
      ["primavera", 3],
      ["verano", 6],
      ["otono", 9],
      ["invierno", 12],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("topes, ventanas degeneradas y reglas imposibles", () => {
  const diaria: RoutineRule = { pattern: "every_n_days", anchorOn: "2019-01-01", repeatEvery: 1 };

  it("corta en 1000 fechas por rutina y llamada (caso 10)", () => {
    const todas = occurrencesBetween(diaria, "2019-01-01", "2030-12-31");
    expect(todas).toHaveLength(MAX_OCCURRENCES_PER_CALL);
    expect(todas[0]).toBe("2019-01-01");
  });

  it("el tope se puede bajar, y corta por la cola", () => {
    expect(occurrencesBetween(diaria, "2026-08-01", "2026-08-31", { limit: 3 })).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    expect(occurrencesBetween(diaria, "2026-08-01", "2026-08-31", { limit: 0 })).toEqual([]);
  });

  it("una ventana del revés no genera nada", () => {
    expect(occurrencesBetween(diaria, "2026-08-31", "2026-08-01")).toEqual([]);
  });

  it("la ventana de rescate de Hoy es de 400 días", () => {
    expect(PENDING_LOOKBACK_DAYS).toBe(400);
  });

  it("rechaza una repetición de cero, que sería un bucle infinito", () => {
    expect(
      domainCode(() =>
        occurrencesBetween(
          { pattern: "every_n_days", anchorOn: "2026-01-01", repeatEvery: 0 },
          "2026-01-01",
          "2026-12-31",
        ),
      ),
    ).toBe("INVALID_ROUTINE_RULE");
  });

  it("rechaza los límites que la CHECK de la base no admitiría", () => {
    expect(
      domainCode(() =>
        occurrencesBetween(
          { pattern: "every_n_days", anchorOn: "2026-01-01", repeatEvery: 367 },
          "2026-01-01",
          "2026-12-31",
        ),
      ),
    ).toBe("INVALID_ROUTINE_RULE");
    expect(
      domainCode(() =>
        occurrencesBetween(
          { pattern: "days_of_week", anchorOn: "2026-01-01", repeatEvery: 13, weekdays: [1] },
          "2026-01-01",
          "2026-12-31",
        ),
      ),
    ).toBe("INVALID_ROUTINE_RULE");
    expect(
      domainCode(() =>
        occurrencesBetween(
          { pattern: "day_of_month", anchorOn: "2026-01-01", repeatEvery: 37, monthDay: 1 },
          "2026-01-01",
          "2026-12-31",
        ),
      ),
    ).toBe("INVALID_ROUTINE_RULE");
  });

  it("rechaza días de la semana fuera de ISO 1..7 y listas vacías", () => {
    expect(
      domainCode(() =>
        occurrencesBetween(
          { pattern: "days_of_week", anchorOn: "2026-01-01", repeatEvery: 1, weekdays: [0] },
          "2026-01-01",
          "2026-12-31",
        ),
      ),
    ).toBe("INVALID_ROUTINE_RULE");
    expect(
      domainCode(() =>
        occurrencesBetween(
          { pattern: "days_of_week", anchorOn: "2026-01-01", repeatEvery: 1, weekdays: [] },
          "2026-01-01",
          "2026-12-31",
        ),
      ),
    ).toBe("INVALID_ROUTINE_RULE");
  });

  it("rechaza un día del mes imposible y un mes fuera de 1..12", () => {
    expect(
      domainCode(() =>
        occurrencesBetween(
          { pattern: "day_of_month", anchorOn: "2026-01-01", repeatEvery: 1, monthDay: 32 },
          "2026-01-01",
          "2026-12-31",
        ),
      ),
    ).toBe("INVALID_ROUTINE_RULE");
    expect(
      domainCode(() =>
        occurrencesBetween(
          { pattern: "months_of_year", anchorOn: "2026-01-01", months: [13], monthDay: 1 },
          "2026-01-01",
          "2026-12-31",
        ),
      ),
    ).toBe("INVALID_ROUTINE_RULE");
  });

  it("rechaza acabar antes de empezar, igual que la CHECK `routines_ends_after_anchor`", () => {
    expect(
      domainCode(() =>
        occurrencesBetween(
          {
            pattern: "every_n_days",
            anchorOn: "2026-06-01",
            repeatEvery: 1,
            endsOn: "2026-05-31",
          },
          "2026-01-01",
          "2026-12-31",
        ),
      ),
    ).toBe("INVALID_ROUTINE_RULE");
  });

  it("rechaza una fecha que no existe", () => {
    expect(
      domainCode(() =>
        occurrencesBetween(
          { pattern: "every_n_days", anchorOn: "2026-02-30", repeatEvery: 1 },
          "2026-01-01",
          "2026-12-31",
        ),
      ),
    ).toBe("INVALID_ROUTINE_DATE");
    expect(
      domainCode(() =>
        occurrencesBetween(
          { pattern: "every_n_days", anchorOn: "2026-01-01", repeatEvery: 1 },
          "ayer",
          "2026-12-31",
        ),
      ),
    ).toBe("INVALID_ROUTINE_DATE");
  });
});
