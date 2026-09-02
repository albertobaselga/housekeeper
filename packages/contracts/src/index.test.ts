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
  agreementScheduleInputSchema,
  agreementTermsInputSchema,
  commandEnvelopeSchema,
  extraWorkCommandPayloadSchema,
  extraWorkTypeInputSchema,
  financeCommandPayloadSchema,
  recurringSupplementInputSchema,
  retiredRoutineUpsertPayloadSchema,
  routineUpsertPayloadSchema,
  scheduleDayInputSchema,
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
  it("no reexporta el modelo de autorización: vive en @housekeeper/contracts/capabilities", () => {
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
    // Sin la clave `schedule`, unos términos válidos siguen siéndolo y el
    // horario queda explícitamente en null: «este contrato no lo declara».
    expect(agreementTermsInputSchema.parse(terms).schedule).toBeNull();
  });

  it("el día de vacaciones no disfrutado se pacta o no se pacta, pero nunca vale cero por omisión", () => {
    const terms = {
      effectiveFrom: "2026-09-01",
      monthlySalaryCents: "150000",
      contractedWeeklyMinutes: 2400,
      annualVacationDays: 30,
      reason: "Subida pactada en agosto",
      extraWorkTypes: [],
      supplements: [],
    };
    // Ausente = no se pactó. Es null y NO cero: la fila es inmutable, y un cero
    // por omisión dejaría escrito para siempre que se acordó pagar cero euros
    // por día, que es falso y que sólo se podría tapar apilando otra versión.
    expect(agreementTermsInputSchema.parse(terms).unusedVacationDayRateCents).toBeNull();
    expect(
      agreementTermsInputSchema.parse({ ...terms, unusedVacationDayRateCents: "4615" })
        .unusedVacationDayRateCents,
    ).toBe("4615");
    // Un precio negativo por día no es un precio.
    expect(
      agreementTermsInputSchema.safeParse({ ...terms, unusedVacationDayRateCents: "-1" }).success,
    ).toBe(false);
  });

  it("la caducidad de los días arrastrados son seis meses, otro número o nunca", () => {
    const terms = {
      effectiveFrom: "2026-09-01",
      monthlySalaryCents: "150000",
      contractedWeeklyMinutes: 2400,
      annualVacationDays: 30,
      reason: "Subida pactada en agosto",
      extraWorkTypes: [],
      supplements: [],
    };
    // Ausente son seis meses, y por eso ningún contrato ya firmado se toca.
    expect(agreementTermsInputSchema.parse(terms).vacationCarryoverExpiry).toEqual({
      mode: "months",
      months: 6,
    });
    expect(
      agreementTermsInputSchema.parse({
        ...terms,
        vacationCarryoverExpiry: { mode: "months", months: 12 },
      }).vacationCarryoverExpiry,
    ).toEqual({ mode: "months", months: 12 });
    expect(
      agreementTermsInputSchema.parse({ ...terms, vacationCarryoverExpiry: { mode: "never" } })
        .vacationCarryoverExpiry,
    ).toEqual({ mode: "never" });
    // «Nunca expiran, a los seis meses» son dos respuestas a la vez: la unión
    // discriminada no admite el número en la rama que no lo tiene.
    expect(
      agreementTermsInputSchema.safeParse({
        ...terms,
        vacationCarryoverExpiry: { mode: "siempre", months: 6 },
      }).success,
    ).toBe(false);
    // Cero meses de margen no es una política: es «caducan al terminar», y eso
    // se dice sin arrastre.
    expect(
      agreementTermsInputSchema.safeParse({
        ...terms,
        vacationCarryoverExpiry: { mode: "months", months: 0 },
      }).success,
    ).toBe(false);
  });

  it("el horario declara la jornada tipo y solo los días que se desvían", () => {
    const schedule = {
      startsAt: "08:00",
      endsAt: "16:30",
      longBreakMinutes: 90,
      note: "",
      days: [
        { weekday: 6, works: true, startsAt: null, endsAt: "14:30", longBreakMinutes: null, note: "" },
        { weekday: 7, works: false, startsAt: null, endsAt: null, longBreakMinutes: null, note: "" },
      ],
    };
    expect(agreementScheduleInputSchema.safeParse(schedule).success).toBe(true);

    // La jornada tipo tiene que ser una jornada.
    expect(
      agreementScheduleInputSchema.safeParse({ ...schedule, endsAt: "07:00" }).success,
    ).toBe(false);
    // Y el descanso tiene que caber dentro de ella.
    expect(
      agreementScheduleInputSchema.safeParse({ ...schedule, longBreakMinutes: 600 }).success,
    ).toBe(false);
    // Un mismo día no puede decir dos cosas.
    expect(
      agreementScheduleInputSchema.safeParse({
        ...schedule,
        days: [...schedule.days, { ...schedule.days[1]!, works: false }],
      }).success,
    ).toBe(false);
    for (const bad of ["8:00", "24:00", "08:60", "mediodía"]) {
      expect(agreementScheduleInputSchema.safeParse({ ...schedule, startsAt: bad }).success).toBe(
        false,
      );
    }
  });

  it("un día libre no declara horas y un día igual al resto no necesita fila", () => {
    const base = {
      weekday: 4 as const,
      works: true,
      startsAt: null,
      endsAt: null,
      longBreakMinutes: null,
      note: "",
    };
    // Trabaja exactamente como el resto y no explica nada: sobra.
    expect(scheduleDayInputSchema.safeParse(base).success).toBe(false);
    // Basta con una nota para que la fila diga algo.
    expect(scheduleDayInputSchema.safeParse({ ...base, note: "Lleva a los niños" }).success).toBe(
      true,
    );
    // Terminar antes es una sola columna: no hay que repetir la entrada.
    expect(scheduleDayInputSchema.safeParse({ ...base, endsAt: "15:00" }).success).toBe(true);
    // Un día libre con horas sería una contradicción.
    expect(
      scheduleDayInputSchema.safeParse({ ...base, works: false, endsAt: "15:00" }).success,
    ).toBe(false);
    expect(scheduleDayInputSchema.safeParse({ ...base, works: false }).success).toBe(true);
    // Y un día que declara las dos horas tiene que declararlas en orden.
    expect(
      scheduleDayInputSchema.safeParse({ ...base, startsAt: "15:00", endsAt: "09:00" }).success,
    ).toBe(false);
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

describe("alta de rutina: las dos formas conviven (§3.4)", () => {
  const identity = { action: "upsert", title: "Cocina a fondo", audience: "employee" } as const;

  it("acepta la cadencia rica y normaliza los conjuntos como la base", () => {
    // Los días llegan en el orden en que se pulsaron los botones. La base exige
    // el array ordenado y sin repetidos (`app.is_normalized_smallints`), y esa
    // normalización se hace aquí para que un detalle de presentación no
    // convierta un comando de la cola sin conexión en un rechazo.
    expect(
      routineUpsertPayloadSchema.parse({
        ...identity,
        pattern: "days_of_week",
        anchorOn: "2026-08-10",
        repeatEvery: 1,
        weekdays: [4, 1, 4],
      }),
    ).toEqual({
      ...identity,
      pattern: "days_of_week",
      anchorOn: "2026-08-10",
      repeatEvery: 1,
      weekdays: [1, 4],
    });

    expect(
      routineUpsertPayloadSchema.parse({
        ...identity,
        pattern: "months_of_year",
        anchorOn: "2026-06-01",
        months: [12, 6],
        monthDay: 1,
      }),
    ).toMatchObject({ months: [6, 12], monthDay: 1 });
  });

  it("cada patrón declara sus campos y ninguno más, igual que la CHECK de la 0023", () => {
    // `every_n_days` no tiene días de la semana: sobran y se van. Si la unión no
    // discriminara, «cada 3 días los lunes» entraría y el generador no sabría
    // qué hacer con la mitad de la regla.
    expect(
      routineUpsertPayloadSchema.parse({
        ...identity,
        pattern: "every_n_days",
        anchorOn: "2026-08-10",
        repeatEvery: 3,
        weekdays: [1],
        months: [6],
      }),
    ).toEqual({ ...identity, pattern: "every_n_days", anchorOn: "2026-08-10", repeatEvery: 3 });

    // Los mismos límites que la base: 366 días, 12 semanas, 36 meses (una
    // `quarterly` heredada con intervalo 12), y -1 = «el último día del mes».
    for (const impossible of [
      { pattern: "every_n_days", anchorOn: "2026-08-10", repeatEvery: 0 },
      { pattern: "every_n_days", anchorOn: "2026-08-10", repeatEvery: 367 },
      { pattern: "days_of_week", anchorOn: "2026-08-10", repeatEvery: 13, weekdays: [1] },
      { pattern: "days_of_week", anchorOn: "2026-08-10", repeatEvery: 1, weekdays: [] },
      { pattern: "days_of_week", anchorOn: "2026-08-10", repeatEvery: 1, weekdays: [8] },
      { pattern: "day_of_month", anchorOn: "2026-08-10", repeatEvery: 37, monthDay: 1 },
      { pattern: "day_of_month", anchorOn: "2026-08-10", repeatEvery: 1, monthDay: 0 },
      { pattern: "day_of_month", anchorOn: "2026-08-10", repeatEvery: 1, monthDay: -2 },
      { pattern: "months_of_year", anchorOn: "2026-08-10", months: [13], monthDay: 1 },
      { pattern: "every_n_days", repeatEvery: 1 },
    ]) {
      expect(
        routineUpsertPayloadSchema.safeParse({ ...identity, ...impossible }).success,
        JSON.stringify(impossible),
      ).toBe(false);
    }

    expect(
      routineUpsertPayloadSchema.safeParse({
        ...identity,
        pattern: "day_of_month",
        anchorOn: "2026-08-10",
        repeatEvery: 36,
        monthDay: -1,
      }).success,
    ).toBe(true);
  });

  it("una rutina no puede acabar antes de empezar", () => {
    const ends = (endsOn: string) =>
      routineUpsertPayloadSchema.safeParse({
        ...identity,
        pattern: "every_n_days",
        anchorOn: "2026-08-10",
        repeatEvery: 1,
        endsOn,
      }).success;
    expect(ends("2026-08-09")).toBe(false);
    expect(ends("2026-08-10")).toBe(true);
  });

  it("«todavía no lo sabemos» es un valor, no un hueco (§2.3)", () => {
    expect(routineUpsertPayloadSchema.parse({ ...identity, pattern: null })).toEqual({
      ...identity,
      pattern: null,
    });
    // Y sin fecha: `pattern: null` implica que no hay nada más que decir. Lo
    // que sobra se descarta en el borde, que es donde la CHECK de la base
    // esperaría encontrarlo.
    expect(
      routineUpsertPayloadSchema.parse({ ...identity, pattern: null, anchorOn: "2026-08-10" }),
    ).toEqual({ ...identity, pattern: null });
  });

  it("ni la próxima fecha ni la política de atrasadas se pueden dictar desde fuera", () => {
    // `next_due_hint` es caché derivada de la regla (§2.7) y `overdue_policy` se
    // DERIVA del patrón en el servidor (§2.5). Que el contrato no tenga dónde
    // ponerlas es lo que garantiza que nadie las decida por su cuenta.
    const parsed = routineUpsertPayloadSchema.parse({
      ...identity,
      pattern: "every_n_days",
      anchorOn: "2026-08-10",
      repeatEvery: 1,
      nextDueOn: "2030-01-01",
      overduePolicy: "carry",
    });
    expect(parsed).not.toHaveProperty("nextDueOn");
    expect(parsed).not.toHaveProperty("overduePolicy");
  });

  it("ya no acepta la forma anterior al despliegue, pero la sabe reconocer", () => {
    // La contrapartida del caso 21 de §9, un despliegue después (T10, migración
    // 0033). Durante la ventana de la 0023 esta carga se aceptaba y se traducía;
    // ahora no entra. Lo que NO se pierde es la capacidad de identificarla: el
    // comando la reconoce con este esquema para poder rechazarla por su nombre
    // en vez de con un «falta pattern» que no explicaría nada.
    const antigua = {
      ...identity,
      frequency: "quarterly",
      intervalCount: 2,
      nextDueOn: "2026-08-10",
    };
    expect(routineUpsertPayloadSchema.safeParse(antigua).success).toBe(false);
    expect(retiredRoutineUpsertPayloadSchema.safeParse(antigua).success).toBe(true);

    // Un cliente que mande las dos formas sigue entrando por la rica, y los
    // campos retirados se caen: nunca llegan a la base.
    expect(
      routineUpsertPayloadSchema.parse({
        ...identity,
        pattern: "every_n_days",
        anchorOn: "2026-08-10",
        repeatEvery: 1,
        frequency: "daily",
        intervalCount: 1,
        nextDueOn: "2026-08-10",
      }),
    ).toEqual({ ...identity, pattern: "every_n_days", anchorOn: "2026-08-10", repeatEvery: 1 });
  });

  it("una carga sin cadencia rica ni forma antigua no se confunde con la retirada", () => {
    const failed = routineUpsertPayloadSchema.safeParse(identity);
    expect(failed.success).toBe(false);
    // Y tampoco es la forma vieja: el comando solo debe dar
    // `routine_cadence_format_retired` cuando de verdad lo sea.
    expect(retiredRoutineUpsertPayloadSchema.safeParse(identity).success).toBe(false);
  });
});

describe("comandos de finanzas (fase 1: concesión)", () => {
  it("acepta los dos kinds congelados y rechaza cualquier otro", () => {
    expect(
      financeCommandPayloadSchema.parse({
        kind: "finance.grant.write",
        membershipId: "11000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      kind: "finance.grant.write",
      membershipId: "11000000-0000-4000-8000-000000000001",
    });
    expect(
      financeCommandPayloadSchema.parse({
        kind: "finance.revoke.write",
        membershipId: "11000000-0000-4000-8000-000000000001",
      }).kind,
    ).toBe("finance.revoke.write");
    expect(() =>
      financeCommandPayloadSchema.parse({
        kind: "finance.account.update",
        membershipId: "11000000-0000-4000-8000-000000000001",
      }),
    ).toThrow();
  });

  it("el sobre de sync acepta aggregateType finance", () => {
    expect(
      commandEnvelopeSchema.parse({
        apiVersion: API_VERSION,
        operationId: "99999999-0000-4000-8000-000000000001",
        householdId: "10000000-0000-4000-8000-000000000001",
        schemaVersion: 1,
        aggregateType: "finance",
        aggregateId: null,
        baseRevision: null,
        occurredAt: "2026-08-31T10:00:00.000Z",
        payload: {
          kind: "finance.grant.write",
          membershipId: "11000000-0000-4000-8000-000000000001",
        },
      }).aggregateType,
    ).toBe("finance");
  });
});
