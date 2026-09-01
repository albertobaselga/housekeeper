import { describe, expect, it } from "vitest";

import {
  CLOSE_DUE_SWEEP_JOB,
  closeDueTargetDay,
  closeDueTargetDayNextMonth,
  createCloseDueSweepHandler,
  type CloseDueSweepDeps,
} from "./close-due.js";
import type { ClaimedJob } from "./queue.js";

const HOUSEHOLD = "10000000-0000-4000-8000-000000000001";

function sweepJob(): ClaimedJob {
  return { id: "job-sweep", householdId: HOUSEHOLD, type: CLOSE_DUE_SWEEP_JOB, payload: {}, attempts: 1 };
}

describe("closeDueTargetDay", () => {
  it("el penúltimo día de un mes de 31 (agosto)", () => {
    // Hoy es a mitad de mes: el penúltimo día sigue siendo este mismo mes.
    expect(closeDueTargetDay(new Date("2026-08-15T10:00:00.000Z"))).toBe("2026-08-30");
  });

  it("el penúltimo día de un mes de 30 (septiembre)", () => {
    expect(closeDueTargetDay(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09-29");
  });

  it("febrero, incluido bisiesto", () => {
    expect(closeDueTargetDay(new Date("2028-02-01T00:00:00.000Z"))).toBe("2028-02-28"); // 2028 es bisiesto: 29 días, penúltimo = 28
    expect(closeDueTargetDay(new Date("2027-02-01T00:00:00.000Z"))).toBe("2027-02-27"); // 2027 no lo es: 28 días, penúltimo = 27
  });

  it("si hoy es exactamente el penúltimo día, se programa para HOY (no se pospone)", () => {
    expect(closeDueTargetDay(new Date("2026-08-30T00:00:00.000Z"))).toBe("2026-08-30");
  });

  it("si el penúltimo día ya pasó (hoy es el último día del mes), salta al mes siguiente", () => {
    // El worker arranca por primera vez el 31 de agosto: el 30 ya es historia.
    expect(closeDueTargetDay(new Date("2026-08-31T00:00:00.000Z"))).toBe("2026-09-29");
  });

  it("diciembre cruza de año", () => {
    // Enero tiene 31 días: su penúltimo día es el 30, no el 29.
    expect(closeDueTargetDay(new Date("2026-12-31T00:00:00.000Z"))).toBe("2027-01-30");
  });
});

describe("closeDueTargetDayNextMonth", () => {
  it("el penúltimo día del mes SIGUIENTE, sin comprobar si ya pasó", () => {
    expect(closeDueTargetDayNextMonth(new Date("2026-08-05T00:00:00.000Z"))).toBe("2026-09-29");
    // Aunque hoy sea el último día del mes, «el siguiente» es siempre el de
    // después: no hay ambigüedad que resolver, a diferencia de closeDueTargetDay.
    expect(closeDueTargetDayNextMonth(new Date("2026-08-31T00:00:00.000Z"))).toBe("2026-09-29");
  });

  it("cruza de año", () => {
    expect(closeDueTargetDayNextMonth(new Date("2026-12-15T00:00:00.000Z"))).toBe("2027-01-30");
  });
});

function handlerWith(options: {
  households: string[];
  enqueuedPush?: Array<{ householdId: string }>;
  enqueuedSweep?: Array<{ householdId: string; targetDay: string }>;
  now?: Date;
}) {
  // `now` sigue siendo el nombre de la opción de prueba (fija el reloj del
  // escenario); lo que le llega al handler real es `today`, la fecha civil ya
  // resuelta como la devolvería la consulta a Postgres.
  const today = options.now ?? new Date("2026-08-15T10:00:00.000Z");
  const isoToday = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
  const deps: CloseDueSweepDeps = {
    listHouseholds: async () => options.households,
    enqueuePush: async (input) => {
      options.enqueuedPush?.push(input);
    },
    enqueueSweep: async (input) => {
      options.enqueuedSweep?.push(input);
    },
    today: async () => isoToday,
  };
  return createCloseDueSweepHandler(deps);
}

describe("el trabajo notification.close_due_sweep", () => {
  it("encola un aviso por cada hogar con algo por cerrar", async () => {
    const enqueuedPush: Array<{ householdId: string }> = [];
    const handler = handlerWith({
      households: ["household-a", "household-b"],
      enqueuedPush,
      now: new Date("2026-08-15T10:00:00.000Z"),
    });

    await handler(sweepJob());

    expect(enqueuedPush).toEqual([{ householdId: "household-a" }, { householdId: "household-b" }]);
  });

  it("con cero hogares por cerrar no encola ningún aviso, y aun así se re-arma", async () => {
    const enqueuedPush: Array<{ householdId: string }> = [];
    const enqueuedSweep: Array<{ householdId: string; targetDay: string }> = [];
    const handler = handlerWith({
      households: [],
      enqueuedPush,
      enqueuedSweep,
      now: new Date("2026-08-15T10:00:00.000Z"),
    });

    await handler(sweepJob());

    expect(enqueuedPush).toEqual([]);
    // La cadena periódica no debe morir un mes tranquilo sin ningún hogar por
    // cerrar: se re-arma exactamente igual que con hogares.
    expect(enqueuedSweep).toEqual([{ householdId: HOUSEHOLD, targetDay: "2026-09-29" }]);
  });

  it("siempre se re-arma para el mes siguiente, con el household_id del propio job", async () => {
    const enqueuedSweep: Array<{ householdId: string; targetDay: string }> = [];
    const handler = handlerWith({
      households: ["household-a"],
      enqueuedSweep,
      now: new Date("2026-12-30T09:00:00.000Z"),
    });

    await handler(sweepJob());

    expect(enqueuedSweep).toEqual([{ householdId: HOUSEHOLD, targetDay: "2027-01-30" }]);
  });

  // Idempotencia frente a un reintento: si el trabajo se repite entero (p. ej.
  // falló al encolar el tercer hogar de cinco), este handler simplemente vuelve
  // a llamar a `enqueuePush` por cada hogar de la lista. Que la repetición NO
  // duplique avisos es responsabilidad de `enqueuePush`, no de este bucle: en
  // la implementación real (`createCloseDueQueries`) esa llamada es un INSERT
  // que choca con el índice único parcial de la migración 0034
  // (`close_due_push_pending_idx`) mientras el aviso anterior siga
  // `queued`/`running`, y el propio `enqueuePush` trata ese choque (23505) como
  // éxito silencioso. Aquí se comprueba el contrato desde el lado del handler:
  // una `enqueuePush` idempotente (que ignora repeticiones) dos veces con la
  // misma lista de hogares no hace crecer el conjunto de avisos «vivos».
  it("repetir el barrido con una enqueuePush idempotente no acumula avisos", async () => {
    const live = new Set<string>();
    const handler = createCloseDueSweepHandler({
      listHouseholds: async () => ["household-a", "household-b"],
      enqueuePush: async ({ householdId }) => {
        live.add(householdId); // idempotente: un Set no crece con repeticiones
      },
      enqueueSweep: async () => {},
      today: async () => "2026-08-15",
    });

    await handler(sweepJob());
    await handler(sweepJob());

    expect([...live].sort()).toEqual(["household-a", "household-b"]);
  });
});
