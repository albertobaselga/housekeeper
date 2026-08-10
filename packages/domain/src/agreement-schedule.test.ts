import { describe, expect, it } from "vitest";

import {
  describeSchedule,
  minutesOfDay,
  resolveDay,
  restDays,
  scheduleCoherence,
  spokenDuration,
  spokenTime,
  weeklyEffectiveMinutes,
  type AgreementSchedule,
  type ScheduleDay,
} from "./agreement-schedule.js";
import { DomainRuleError } from "./errors.js";

function day(overrides: Partial<ScheduleDay> & { weekday: ScheduleDay["weekday"] }): ScheduleDay {
  return {
    works: true,
    startsAt: null,
    endsAt: null,
    longBreakMinutes: null,
    note: "",
    ...overrides,
  };
}

function schedule(overrides: Partial<AgreementSchedule> = {}): AgreementSchedule {
  return {
    startsAt: "08:00",
    endsAt: "16:30",
    longBreakMinutes: 90,
    note: "",
    days: [],
    ...overrides,
  };
}

describe("horas y ratos en palabras", () => {
  it("lee una hora del día y rechaza lo que no lo es", () => {
    expect(minutesOfDay("08:30")).toBe(510);
    expect(minutesOfDay("00:00")).toBe(0);
    expect(minutesOfDay("23:59")).toBe(1439);
    for (const bad of ["24:00", "8:30", "07:60", "", "mediodía", "08:30:00"]) {
      expect(() => minutesOfDay(bad)).toThrow(DomainRuleError);
    }
  });

  it("quita el cero de cortesía, que nadie pronuncia", () => {
    expect(spokenTime("07:30")).toBe("7:30");
    expect(spokenTime("15:00")).toBe("15:00");
  });

  it("dice los descansos corrientes con palabras y el resto con números", () => {
    expect(spokenDuration(90)).toBe("hora y media");
    expect(spokenDuration(60)).toBe("una hora");
    expect(spokenDuration(30)).toBe("media hora");
    expect(spokenDuration(120)).toBe("dos horas");
    // Sin forma corriente de decirlo: mejor el número que un invento.
    expect(spokenDuration(80)).toBe("1 h 20 min");
    expect(spokenDuration(20)).toBe("20 min");
    expect(spokenDuration(240)).toBe("4 h");
  });
});

describe("resolver un día contra la jornada tipo", () => {
  it("un día sin fila propia trabaja exactamente la jornada tipo", () => {
    const resolved = resolveDay(schedule(), 1);
    expect(resolved).toMatchObject({
      works: true,
      startsAt: "08:00",
      endsAt: "16:30",
      longBreakMinutes: 90,
      // 8 h 30 min de presencia menos hora y media.
      effectiveMinutes: 420,
      differs: false,
    });
  });

  it("una excepción cambia SOLO lo que dice y hereda lo demás", () => {
    const resolved = resolveDay(
      schedule({ days: [day({ weekday: 6, endsAt: "14:30" })] }),
      6,
    );
    // Ni repitió la hora de entrada ni el descanso, y los conserva.
    expect(resolved).toMatchObject({
      startsAt: "08:00",
      endsAt: "14:30",
      longBreakMinutes: 90,
      effectiveMinutes: 300,
      differs: true,
    });
  });

  it("un día de libranza no tiene horas ni suma minutos", () => {
    const resolved = resolveDay(schedule({ days: [day({ weekday: 7, works: false })] }), 7);
    expect(resolved).toMatchObject({
      works: false,
      startsAt: null,
      endsAt: null,
      effectiveMinutes: 0,
      differs: true,
    });
  });

  it("rechaza un día que termina antes de empezar o cuyo descanso no cabe", () => {
    expect(() =>
      resolveDay(schedule({ days: [day({ weekday: 4, endsAt: "07:00" })] }), 4),
    ).toThrow(DomainRuleError);
    expect(() =>
      resolveDay(schedule({ days: [day({ weekday: 4, endsAt: "09:00" })] }), 4),
    ).toThrow(DomainRuleError);
  });
});

describe("la semana", () => {
  const casaSintetica = schedule({
    days: [day({ weekday: 6, endsAt: "14:30" }), day({ weekday: 7, works: false })],
  });

  it("suma los minutos efectivos de los siete días", () => {
    // Cinco días de 420 + el sábado de 300 + el domingo libre.
    expect(weeklyEffectiveMinutes(casaSintetica)).toBe(2400);
  });

  it("enumera las libranzas en orden de lunes a domingo", () => {
    expect(restDays(casaSintetica)).toEqual([7]);
    expect(
      restDays(
        schedule({ days: [day({ weekday: 7, works: false }), day({ weekday: 3, works: false })] }),
      ),
    ).toEqual([3, 7]);
  });

  it("sin ninguna libranza declarada, la semana son siete días", () => {
    // Decisión deliberada: no se inventa un «de lunes a viernes» que nadie
    // pactó. La semana sale enorme, no cuadra, y eso es lo que hay que decir.
    expect(weeklyEffectiveMinutes(schedule())).toBe(7 * 420);
    expect(restDays(schedule())).toEqual([]);
  });
});

describe("coherencia con la jornada contratada", () => {
  const casaSintetica = schedule({
    days: [day({ weekday: 6, endsAt: "14:30" }), day({ weekday: 7, works: false })],
  });

  it("cuadra sin tolerancia cuando los dos números coinciden", () => {
    expect(scheduleCoherence(casaSintetica, 2400)).toEqual({
      weeklyMinutes: 2400,
      contractedWeeklyMinutes: 2400,
      differenceMinutes: 0,
      matches: true,
    });
  });

  it("cuenta la diferencia con signo y no la corrige ni lanza", () => {
    const exceso = scheduleCoherence(casaSintetica, 2100);
    expect(exceso.differenceMinutes).toBe(300);
    expect(exceso.matches).toBe(false);

    const defecto = scheduleCoherence(casaSintetica, 2700);
    expect(defecto.differenceMinutes).toBe(-300);
    expect(defecto.matches).toBe(false);
  });
});

describe("el horario en castellano llano", () => {
  it("dice la jornada tipo, los días distintos y las libranzas", () => {
    expect(
      describeSchedule(
        schedule({
          days: [day({ weekday: 6, endsAt: "14:30" }), day({ weekday: 7, works: false })],
        }),
      ),
    ).toBe("De 8:00 a 16:30, con hora y media de descanso al mediodía. Sábado hasta las 14:30. Domingo libre.");
  });

  it("agrupa los días que terminan a la misma hora en una sola frase", () => {
    expect(
      describeSchedule(
        schedule({
          startsAt: "07:30",
          endsAt: "20:30",
          days: [
            day({ weekday: 4, endsAt: "15:00" }),
            day({ weekday: 6, endsAt: "15:00" }),
            day({ weekday: 7, works: false }),
          ],
        }),
      ),
    ).toBe(
      "De 7:30 a 20:30, con hora y media de descanso al mediodía. Jueves y sábado hasta las 15:00. Domingo libre.",
    );
  });

  it("calla el descanso que no se pactó y la frase de días si no hay ninguno", () => {
    expect(describeSchedule(schedule({ longBreakMinutes: 0 }))).toBe("De 8:00 a 16:30.");
  });

  it("sabe decir un día que empieza más tarde, uno entero distinto y varias libranzas", () => {
    expect(
      describeSchedule(
        schedule({
          days: [
            day({ weekday: 1, startsAt: "10:00" }),
            day({ weekday: 3, startsAt: "09:00", endsAt: "14:00" }),
            day({ weekday: 6, works: false }),
            day({ weekday: 7, works: false }),
          ],
        }),
      ),
    ).toBe(
      "De 8:00 a 16:30, con hora y media de descanso al mediodía. Lunes desde las 10:00. Miércoles de 9:00 a 14:00. Sábado y domingo libres.",
    );
  });

  it("cuenta un día sin descanso largo cuando el tipo sí lo tiene", () => {
    expect(
      describeSchedule(schedule({ days: [day({ weekday: 5, longBreakMinutes: 0 })] })),
    ).toBe(
      "De 8:00 a 16:30, con hora y media de descanso al mediodía. Viernes sin descanso al mediodía.",
    );
  });
});
