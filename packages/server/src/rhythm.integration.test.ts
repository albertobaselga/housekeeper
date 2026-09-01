import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type AggregateType,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@housekeeper/contracts";

import { rhythmCommandHandlers } from "./commands/rhythm.js";
import { processSyncBatch } from "./sync.js";
import type { AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };
const HELPER: AuthenticatedPrincipal = { userId: "fixture:roble:helper" };

// Los correos de admin y empleada coinciden con los del suite de recordatorios
// (misma base compartida); familiar y apoyo son exclusivos de este suite.
const ADMIN_EMAIL = "admin.roble@example.com";
const FAMILY_EMAIL = "familiar.roble@example.com";
const EMPLOYEE_EMAIL = "empleada.roble@example.com";
const HELPER_EMAIL = "apoyo.roble@example.com";

function envelope(aggregateType: AggregateType, payload: unknown): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType,
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-07T10:00:00.000Z",
    payload,
  };
}

describe.runIf(Boolean(adminUrl))("rutinas con audiencia y feeds ICS sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(principal: AuthenticatedPrincipal, command: CommandEnvelopeV1): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [command], rhythmCommandHandlers);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
  }

  async function upsertRoutine(
    payload: Record<string, unknown>,
  ): Promise<string> {
    const ack = await run(ADMIN, envelope("routine", { action: "upsert", ...payload }));
    expect(ack).toMatchObject({ status: "accepted" });
    return ack.resourceId as string;
  }

  async function nextDueHint(routineId: string): Promise<string | null> {
    const row = await adminPool.query<{ next_due_hint: string | null }>(
      "select next_due_hint::text as next_due_hint from app.routines where id = $1",
      [routineId],
    );
    return row.rows[0]?.next_due_hint ?? null;
  }

  interface RoutineRow {
    pattern: string | null;
    anchor_on: string | null;
    repeat_every: number | null;
    weekdays: number[] | null;
    month_day: number | null;
    months: number[] | null;
    ends_on: string | null;
    overdue_policy: string;
    next_due_hint: string | null;
  }

  async function routineRow(routineId: string): Promise<RoutineRow> {
    const row = await adminPool.query<RoutineRow>(
      `select pattern::text as pattern, anchor_on::text as anchor_on, repeat_every,
              weekdays::int[] as weekdays, month_day::int as month_day, months::int[] as months,
              ends_on::text as ends_on, overdue_policy::text as overdue_policy,
              next_due_hint::text as next_due_hint
         from app.routines where id = $1`,
      [routineId],
    );
    return row.rows[0] as RoutineRow;
  }

  async function completionsOf(routineId: string): Promise<string[]> {
    const rows = await adminPool.query<{ due_on: string }>(
      `select due_on::text as due_on
         from app.routine_completions
        where household_id = $1 and routine_id = $2
        order by due_on`,
      [ROBLE_HOUSEHOLD, routineId],
    );
    return rows.rows.map((row) => row.due_on);
  }

  /**
   * Hoy según el reloj del hogar, preguntado a la MISMA base que usa el
   * comando: una prueba con la fecha del proceso se rompería sola cada vez que
   * el reloj de Madrid y el UTC no coinciden de madrugada.
   */
  async function householdToday(): Promise<string> {
    const row = await adminPool.query<{ today: string }>(
      "select (statement_timestamp() at time zone 'Europe/Madrid')::date::text as today",
    );
    return row.rows[0]?.today as string;
  }

  function shiftDays(isoDate: string, days: number): string {
    const date = new Date(`${isoDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  /**
   * Avisos `notification.routine_due` de una rutina. Desde la migración 0029 la
   * respuesta correcta es siempre CERO: el aviso solo sabía mandar correo, no
   * hay canal de correo, y encolarlo además copiaba las direcciones de la
   * audiencia dentro de la fila de la cola. La consulta se queda justamente
   * para vigilar que no vuelva.
   */
  async function routineDueJobs(routineId: string): Promise<Array<{ payload: Record<string, unknown>; runAt: Date }>> {
    const rows = await adminPool.query<{ payload: Record<string, unknown>; run_at: Date }>(
      `select payload, run_at
         from app_private.job_queue
        where household_id = $1 and job_type = 'notification.routine_due'
          and payload ->> 'routineId' = $2
        order by created_at`,
      [ROBLE_HOUSEHOLD, routineId],
    );
    return rows.rows.map((row) => ({ payload: row.payload, runAt: row.run_at }));
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

    const appUrl = new URL(adminUrl as string);
    appUrl.username = APP_LOGIN;
    appUrl.password = "integration-only";
    appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 2 });

    // Correos de contacto sembrados en los perfiles (columna de la 0006).
    for (const [userId, email] of [
      ["fixture:roble:admin", ADMIN_EMAIL],
      ["fixture:roble:family", FAMILY_EMAIL],
      ["fixture:roble:employee", EMPLOYEE_EMAIL],
      ["fixture:roble:helper", HELPER_EMAIL],
    ]) {
      await adminPool.query("update app.user_profiles set email = $2 where user_id = $1", [userId, email]);
    }
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("completar la ocurrencia vigente refresca next_due_hint en cada patrón", async () => {
    // Las mismas cuatro cadencias que antes se decían con el vocabulario de
    // cuatro palabras, dichas ahora con la regla que las expresa de verdad.
    const cases = [
      {
        label: "cada 3 días",
        rule: { pattern: "every_n_days", anchorOn: "2027-06-01", repeatEvery: 3 },
        dueOn: "2027-06-01",
        expected: "2027-06-04",
      },
      {
        label: "cada 2 semanas, los lunes",
        rule: {
          pattern: "days_of_week",
          anchorOn: "2027-06-07",
          repeatEvery: 2,
          weekdays: [1],
        },
        dueOn: "2027-06-07",
        expected: "2027-06-21",
      },
      {
        // El día 31 sigue siendo el día 31: febrero solo recorta SU ocurrencia.
        label: "el día 31 de cada mes",
        rule: { pattern: "day_of_month", anchorOn: "2027-01-31", repeatEvery: 1, monthDay: 31 },
        dueOn: "2027-01-31",
        expected: "2027-02-28",
      },
      {
        label: "el día 15 cada 6 meses",
        rule: { pattern: "day_of_month", anchorOn: "2027-03-15", repeatEvery: 6, monthDay: 15 },
        dueOn: "2027-03-15",
        expected: "2027-09-15",
      },
    ] as const;

    for (const testCase of cases) {
      const routineId = await upsertRoutine({
        title: `Rutina ${testCase.label}`,
        audience: "all",
        ...testCase.rule,
      });

      const completed = await run(
        ADMIN,
        envelope("routine", { action: "complete", routineId, dueOn: testCase.dueOn }),
      );
      expect(completed).toMatchObject({ status: "accepted", resourceId: routineId });
      expect(await nextDueHint(routineId), testCase.label).toBe(testCase.expected);

      // Y ni un aviso encolado: crear y completar movían antes dos trabajos de
      // correo por rutina (0029 los retiró). La fecha se sigue viendo en Hoy y
      // en el calendario, que es de donde salía el trabajo de verdad.
      expect(await routineDueJobs(routineId), testCase.label).toHaveLength(0);
    }
  });

  it("repetir la misma ocurrencia se rechaza con already_completed", async () => {
    const routineId = await upsertRoutine({
      title: "Rutina duplicable",
      audience: "all",
      pattern: "days_of_week",
      anchorOn: "2027-07-05",
      repeatEvery: 1,
      weekdays: [1],
    });
    const first = await run(ADMIN, envelope("routine", { action: "complete", routineId, dueOn: "2027-07-05" }));
    expect(first).toMatchObject({ status: "accepted" });

    const replayed = await run(ADMIN, envelope("routine", { action: "complete", routineId, dueOn: "2027-07-05" }));
    expect(replayed).toMatchObject({ status: "rejected", errorCode: "already_completed" });
  });

  it("la empleada completa una rutina 'employee' y la 0009 avanza la recurrencia", async () => {
    const routineId = await upsertRoutine({
      title: "Plancha semanal",
      audience: "employee",
      pattern: "days_of_week",
      anchorOn: "2027-08-02",
      repeatEvery: 1,
      weekdays: [1],
    });

    const completed = await run(
      EMPLOYEE,
      envelope("routine", { action: "complete", routineId, dueOn: "2027-08-02" }),
    );
    expect(completed).toMatchObject({ status: "accepted", resourceId: routineId });

    const completion = await adminPool.query<{ completed_by_membership_id: string }>(
      `select completed_by_membership_id
         from app.routine_completions
        where household_id = $1 and routine_id = $2 and due_on = '2027-08-02'`,
      [ROBLE_HOUSEHOLD, routineId],
    );
    expect(completion.rows).toEqual([
      { completed_by_membership_id: "11000000-0000-4000-8000-000000000003" },
    ]);

    // `app.set_routine_due_hint` (0023) permite refrescar la caché aunque quien
    // completa no tenga escritura sobre app.routines (audiencia empleada): es
    // el mismo motivo estrecho por el que existía la definer de la 0009, ahora
    // reducido a un UPDATE de una columna.
    expect(await nextDueHint(routineId)).toBe("2027-08-09");
    expect(await routineDueJobs(routineId)).toHaveLength(0);
  });

  it("el apoyo no puede completar una 'employee' pero sí una 'all'", async () => {
    const employeeRoutine = await upsertRoutine({
      title: "Rutina solo empleada",
      audience: "employee",
      pattern: "every_n_days",
      anchorOn: "2027-09-01",
      repeatEvery: 1,
    });
    const denied = await run(
      HELPER,
      envelope("routine", { action: "complete", routineId: employeeRoutine, dueOn: "2027-09-01" }),
    );
    expect(denied).toMatchObject({ status: "rejected", errorCode: "routine_not_found" });

    const sharedRoutine = await upsertRoutine({
      title: "Rutina de todos",
      audience: "all",
      pattern: "every_n_days",
      anchorOn: "2027-09-02",
      repeatEvery: 1,
    });
    const completed = await run(
      HELPER,
      envelope("routine", { action: "complete", routineId: sharedRoutine, dueOn: "2027-09-02" }),
    );
    expect(completed).toMatchObject({ status: "accepted", resourceId: sharedRoutine });
  });

  it("AC-25: una rutina 'family' no encola aviso ninguno, y ninguna dirección sale de la base", async () => {
    // La forma de cumplir el AC-25 ya no es «elegir bien los destinatarios»,
    // sino que no haya destinatarios que elegir: el aviso por correo se retiró
    // (0029). La rutina 'family' sigue siendo invisible para la empleada por
    // RLS, que es donde esa garantía debe vivir; aquí se vigila lo que este
    // comando escribía en la cola.
    const routineId = await upsertRoutine({
      title: "Mantenimiento caldera",
      audience: "family",
      pattern: "day_of_month",
      anchorOn: "2027-10-01",
      repeatEvery: 1,
      monthDay: 1,
    });

    const completed = await run(
      ADMIN,
      envelope("routine", { action: "complete", routineId, dueOn: "2027-10-01" }),
    );
    expect(completed).toMatchObject({ status: "accepted" });

    expect(await routineDueJobs(routineId)).toHaveLength(0);

    // Y ninguna fila de la cola de este hogar lleva una dirección de correo,
    // vengan de donde vengan: los `recipients` congelados eran una copia de
    // datos personales en una tabla que el worker lee entera.
    const leaked = await adminPool.query<{ total: number }>(
      `select count(*)::int as total from app_private.job_queue
        where household_id = $1 and payload::text like '%@%'`,
      [ROBLE_HOUSEHOLD],
    );
    expect(leaked.rows[0]?.total).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Cadencia rica (0023): §2.2-2.5, §2.9 y §3.4. Casos 11-17, 21 y 23 de §9.
  // ───────────────────────────────────────────────────────────────────────────

  it("«los lunes y los jueves» es UNA rutina, no dos que se avanzan por separado", async () => {
    // El desbloqueo del modelo nuevo: hasta la 0023 esto exigía dos rutinas
    // que se completaban y avanzaban por su cuenta.
    const routineId = await upsertRoutine({
      title: "Cocina a fondo",
      audience: "employee",
      pattern: "days_of_week",
      anchorOn: "2027-06-07", // lunes
      repeatEvery: 1,
      weekdays: [4, 1],
    });

    expect(await routineRow(routineId)).toMatchObject({
      pattern: "days_of_week",
      anchor_on: "2027-06-07",
      repeat_every: 1,
      weekdays: [1, 4],
      month_day: null,
      months: null,
      ends_on: null,
      // Sub-semanal ⇒ `skip`, derivada del patrón sin preguntar (§2.5).
      overdue_policy: "skip",
      next_due_hint: "2027-06-07",
    });

    // Completar el lunes deja el jueves pendiente EN LA MISMA SEMANA (caso 1):
    // la caché no salta al lunes siguiente.
    const completed = await run(
      ADMIN,
      envelope("routine", { action: "complete", routineId, dueOn: "2027-06-07" }),
    );
    expect(completed).toMatchObject({ status: "accepted" });
    expect(await nextDueHint(routineId)).toBe("2027-06-10");
  });

  it("la política de atrasadas se DERIVA del patrón y no se pregunta (§2.5)", async () => {
    const cases = [
      // Sub-semanal: la ocurrencia caduca al acabar su día.
      { rule: { pattern: "every_n_days", anchorOn: "2027-06-01", repeatEvery: 1 }, policy: "skip" },
      { rule: { pattern: "every_n_days", anchorOn: "2027-06-01", repeatEvery: 6 }, policy: "skip" },
      // De semanal para arriba: se arrastra.
      { rule: { pattern: "every_n_days", anchorOn: "2027-06-01", repeatEvery: 7 }, policy: "carry" },
      {
        rule: { pattern: "day_of_month", anchorOn: "2027-06-01", repeatEvery: 1, monthDay: 1 },
        policy: "carry",
      },
      {
        rule: { pattern: "months_of_year", anchorOn: "2027-06-01", months: [6, 12], monthDay: 1 },
        policy: "carry",
      },
      // Los días fijos son `skip` SEA CUAL SEA el intervalo: la compra personal
      // quincenal de §6.2 («cada 2 semanas, los lunes») tampoco arrastra. Es la
      // tabla de §2.5 al pie de la letra, y conviene que sea una decisión
      // escrita y no una sorpresa.
      {
        rule: { pattern: "days_of_week", anchorOn: "2027-06-07", repeatEvery: 2, weekdays: [1] },
        policy: "skip",
      },
    ] as const;

    for (const testCase of cases) {
      const routineId = await upsertRoutine({
        title: `Política ${testCase.rule.pattern} ${JSON.stringify(testCase.rule)}`.slice(0, 160),
        audience: "all",
        ...testCase.rule,
        // Aunque el cliente insista, no hay dónde ponerla: el contrato la
        // descarta y el servidor la deriva.
        overduePolicy: testCase.policy === "skip" ? "carry" : "skip",
      });
      const row = await routineRow(routineId);
      expect(row.overdue_policy, JSON.stringify(testCase.rule)).toBe(testCase.policy);
    }
  });

  it("«todavía no lo sabemos» se guarda sin fecha, no avisa y no se puede completar", async () => {
    // Casos 23 y 17 de §9. Es la razón de ser de §2.3: unas 21 tareas del
    // manual se hacen pero nadie ha decidido cuándo, y hasta ahora no había
    // dónde apuntarlas.
    const routineId = await upsertRoutine({
      title: "Limpieza a fondo del garaje",
      details: "Falta acordar cada cuánto.",
      audience: "employee",
      pattern: null,
    });

    expect(await routineRow(routineId)).toMatchObject({
      pattern: null,
      anchor_on: null,
      repeat_every: null,
      weekdays: null,
      month_day: null,
      months: null,
      ends_on: null,
      next_due_hint: null,
    });
    // Sin fecha no hay aviso que encolar: no aparece en Hoy y tampoco en el
    // correo. Los prefiltros `next_due_hint <= hoy` la excluyen solos.
    expect(await routineDueJobs(routineId)).toHaveLength(0);

    const rejected = await run(
      ADMIN,
      envelope("routine", { action: "complete", routineId, dueOn: "2027-06-01" }),
    );
    expect(rejected).toMatchObject({ status: "rejected", errorCode: "routine_has_no_schedule" });
    expect(await completionsOf(routineId)).toEqual([]);
  });

  it("una rutina que ya terminó se guarda sin próxima fecha (caso 9)", async () => {
    // `ends_on` es la forma de decir «dejad de pedirme esto»: la rutina existe,
    // se puede consultar, y su caché queda en NULL para que ningún prefiltro
    // `next_due_hint <= hoy` la traiga de vuelta.
    const today = await householdToday();
    const routineId = await upsertRoutine({
      title: "Riego del huerto de verano",
      audience: "employee",
      pattern: "every_n_days",
      anchorOn: shiftDays(today, -60),
      repeatEvery: 1,
      endsOn: shiftDays(today, -30),
    });

    expect(await routineRow(routineId)).toMatchObject({
      pattern: "every_n_days",
      ends_on: shiftDays(today, -30),
      next_due_hint: null,
    });
    expect(await routineDueJobs(routineId)).toHaveLength(0);
  });

  it("un envelope de la app anterior se RECHAZA por su nombre, no se adivina", async () => {
    // La contrapartida del caso 21, un despliegue después (T10, migración
    // 0033). Durante la ventana de la 0023 estas cargas se traducían con la
    // tabla de §3.2 para no perder lo que alguien hubiera dado de alta sin
    // conexión; pasado ese plazo ninguna cola las guarda ya, y seguir
    // traduciendo sería peor que rechazar: la tabla no sabe expresar «cada 15
    // días» ni «en junio y en diciembre», así que aplicarla escribiría una
    // cadencia que nadie pidió.
    //
    // Lo que sí se conserva es la HONESTIDAD del rechazo. No es un
    // `invalid_payload` genérico quejándose de que falta `pattern`: es un
    // código propio con su frase, para que quien lo escribió sepa qué pasó y
    // pueda volver a darla de alta. El texto y la fecha siguen en su outbox.
    const legacyPayloads = [
      { frequency: "daily", intervalCount: 3, nextDueOn: "2027-06-01" },
      { frequency: "weekly", intervalCount: 2, nextDueOn: "2027-06-07" },
      { frequency: "monthly", intervalCount: 1, nextDueOn: "2027-01-31" },
      { frequency: "quarterly", intervalCount: 12, nextDueOn: "2027-03-15" },
    ] as const;

    for (const legacy of legacyPayloads) {
      const ack = await run(
        ADMIN,
        envelope("routine", {
          action: "upsert",
          title: `Heredada ${legacy.frequency} ${legacy.intervalCount}`,
          audience: "all",
          ...legacy,
        }),
      );
      expect(ack, legacy.frequency).toMatchObject({
        status: "rejected",
        errorCode: "routine_cadence_format_retired",
      });
    }

    // Y no se coló ninguna: rechazar significa no escribir.
    const written = await adminPool.query<{ total: number }>(
      `select count(*)::int as total from app.routines
        where household_id = $1 and title like 'Heredada %'`,
      [ROBLE_HOUSEHOLD],
    );
    expect(written.rows[0]?.total).toBe(0);
  });

  it("una carga sin cadencia ninguna sigue siendo invalid_payload, no el código de la retirada", async () => {
    // El código nuevo solo debe salir cuando la carga es DE VERDAD la antigua.
    // Si cubriera cualquier alta mal formada, dejaría de informar de nada.
    const ack = await run(
      ADMIN,
      envelope("routine", { action: "upsert", title: "Sin cadencia ninguna", audience: "all" }),
    );
    expect(ack).toMatchObject({ status: "rejected", errorCode: "invalid_payload" });
  });

  it("con `skip`, diez días sin hacer no dejan diez deudas: la de hoy sustituye a la de ayer", async () => {
    // Caso 12 de §9. Hoy una semana de vacaciones deja siete líneas «Vencía
    // el…» por cada rutina diaria; eso es lo que se arregla.
    const today = await householdToday();
    const routineId = await upsertRoutine({
      title: "Ventilación de la mañana",
      audience: "employee",
      pattern: "every_n_days",
      anchorOn: shiftDays(today, -10),
      repeatEvery: 1,
    });

    const row = await routineRow(routineId);
    expect(row.overdue_policy).toBe("skip");
    // La caché apunta a HOY, nunca a una fecha de hace diez días.
    expect(row.next_due_hint).toBe(today);
  });

  it("con `carry` se arrastra UNA sola atrasada, la más antigua, y avanza de una en una", async () => {
    // Caso 11 de §9: nunca una lista de noventa. Semanal (`every_n_days` de 7)
    // para caer del lado `carry` de la tabla de §2.5.
    const today = await householdToday();
    const anchor = shiftDays(today, -28);
    const routineId = await upsertRoutine({
      title: "Cambio de sábanas",
      audience: "employee",
      pattern: "every_n_days",
      anchorOn: anchor,
      repeatEvery: 7,
    });

    expect(await routineRow(routineId)).toMatchObject({
      overdue_policy: "carry",
      next_due_hint: anchor,
    });

    // Marcar la más antigua descubre la siguiente, no salta a hoy ni borra las
    // de en medio.
    for (const [index, dueOn] of [anchor, shiftDays(anchor, 7), shiftDays(anchor, 14)].entries()) {
      const ack = await run(ADMIN, envelope("routine", { action: "complete", routineId, dueOn }));
      expect(ack, dueOn).toMatchObject({ status: "accepted" });
      expect(await nextDueHint(routineId), `tras marcar ${dueOn}`).toBe(
        shiftDays(anchor, 7 * (index + 1)),
      );
    }
  });

  it("marcar tarde NO mueve el calendario (caso 13)", async () => {
    // La cinta de correr que se retira: hoy `advance_routine_after_completion`
    // avanza desde la ocurrencia completada, así que una rutina diaria con
    // cinco días perdidos avanza un día por marcado y sigue vencida para
    // siempre. Generando desde el ancla, la ocurrencia perdida se marca y la
    // siguiente se queda donde estaba.
    const today = await householdToday();
    const routineId = await upsertRoutine({
      title: "Hacer las camas",
      audience: "employee",
      pattern: "every_n_days",
      anchorOn: shiftDays(today, -10),
      repeatEvery: 1,
    });
    expect(await nextDueHint(routineId)).toBe(today);

    const late = shiftDays(today, -5);
    const ack = await run(ADMIN, envelope("routine", { action: "complete", routineId, dueOn: late }));
    expect(ack).toMatchObject({ status: "accepted" });
    expect(await completionsOf(routineId)).toEqual([late]);
    // La ocurrencia de hoy sigue pendiente: marcar una perdida no la consume.
    expect(await nextDueHint(routineId)).toBe(today);

    const done = await run(ADMIN, envelope("routine", { action: "complete", routineId, dueOn: today }));
    expect(done).toMatchObject({ status: "accepted" });
    expect(await nextDueHint(routineId)).toBe(shiftDays(today, 1));
  });

  it("una rutina anclada el 31 deja de degradarse a 28 para siempre (caso 4)", async () => {
    // Contraprueba escrita: con la aritmética anterior, marcar 31/01 y luego
    // 28/02 dejaba la serie en 28/03 y ahí se quedaba. Desde el ancla, marzo
    // vuelve al 31.
    const routineId = await upsertRoutine({
      title: "Revisión de la caldera",
      audience: "family",
      pattern: "day_of_month",
      anchorOn: "2027-01-31",
      repeatEvery: 1,
      monthDay: 31,
    });
    expect(await nextDueHint(routineId)).toBe("2027-01-31");

    for (const [dueOn, expected] of [
      ["2027-01-31", "2027-02-28"],
      ["2027-02-28", "2027-03-31"],
    ]) {
      const ack = await run(
        ADMIN,
        envelope("routine", { action: "complete", routineId, dueOn: dueOn as string }),
      );
      expect(ack, dueOn).toMatchObject({ status: "accepted" });
      expect(await nextDueHint(routineId), `tras marcar ${dueOn}`).toBe(expected);
    }
  });

  it("editar la regla no revive ni borra lo ya marcado (caso 15)", async () => {
    const routineId = await upsertRoutine({
      title: "Plan de zona",
      audience: "all",
      pattern: "day_of_month",
      anchorOn: "2027-04-15",
      repeatEvery: 1,
      monthDay: 15,
    });
    for (const dueOn of ["2027-04-15", "2027-05-15"]) {
      expect(await run(ADMIN, envelope("routine", { action: "complete", routineId, dueOn }))).toMatchObject({
        status: "accepted",
      });
    }

    // La misma rutina pasa a «los lunes»: las columnas del patrón anterior
    // tienen que quedar en NULL o la CHECK de forma rechazaría la fila.
    await upsertRoutine({
      routineId,
      title: "Plan de zona",
      audience: "all",
      pattern: "days_of_week",
      anchorOn: "2027-06-07",
      repeatEvery: 1,
      weekdays: [1],
    });
    expect(await routineRow(routineId)).toMatchObject({
      pattern: "days_of_week",
      month_day: null,
      weekdays: [1],
      overdue_policy: "skip",
      next_due_hint: "2027-06-07",
    });

    // Las finalizaciones son hechos: siguen ahí aunque sus `due_on` ya no sean
    // ocurrencias de la regla nueva. No se pintan, pero no se pierden.
    expect(await completionsOf(routineId)).toEqual(["2027-04-15", "2027-05-15"]);
  });

  it("un `dueOn` que ya no es ocurrencia se acepta igual (caso 16)", async () => {
    // Cliente sin conexión que quedó con la regla anterior. Una finalización es
    // un hecho —«esto se hizo tal día»— y rechazarla rompería su cola; si ya no
    // es ocurrencia, simplemente no se pinta.
    const routineId = await upsertRoutine({
      title: "Colada de la semana",
      audience: "employee",
      pattern: "days_of_week",
      anchorOn: "2027-06-07", // lunes
      repeatEvery: 1,
      weekdays: [1],
    });

    const wednesday = "2027-06-09";
    const ack = await run(
      ADMIN,
      envelope("routine", { action: "complete", routineId, dueOn: wednesday }),
    );
    expect(ack).toMatchObject({ status: "accepted", resourceId: routineId });
    expect(await completionsOf(routineId)).toEqual([wednesday]);
    // Y la caché no se mueve por una finalización huérfana.
    expect(await nextDueHint(routineId)).toBe("2027-06-07");
  });

  it("deshacer devuelve la fecha que tenía, no calcula una nueva (E5.1)", async () => {
    // La corrección del propietario: marcar era irreversible y —peor— movía la
    // próxima fecha, así que la casa dejaba de ver la tarea cuando le tocaba.
    // Un semanal (`carry`) es donde más se nota: la fecha restaurada es la
    // atrasada, no «hoy más siete».
    const today = await householdToday();
    const anchor = shiftDays(today, -14);
    const routineId = await upsertRoutine({
      title: "Cambio de toallas",
      audience: "employee",
      pattern: "every_n_days",
      anchorOn: anchor,
      repeatEvery: 7,
    });
    expect(await nextDueHint(routineId)).toBe(anchor);

    const marked = await run(
      EMPLOYEE,
      envelope("routine", { action: "complete", routineId, dueOn: anchor }),
    );
    expect(marked).toMatchObject({ status: "accepted" });
    expect(await nextDueHint(routineId)).toBe(shiftDays(anchor, 7));

    const undone = await run(
      EMPLOYEE,
      envelope("routine", { action: "uncomplete", routineId, dueOn: anchor }),
    );
    expect(undone).toMatchObject({ status: "accepted", resourceId: routineId });
    // Exactamente la fecha que tenía antes de marcar.
    expect(await nextDueHint(routineId)).toBe(anchor);
  });

  it("un completado anulado se anota como anulado, con su autoría, y no se borra", async () => {
    const routineId = await upsertRoutine({
      title: "Revisión del filtro",
      audience: "all",
      pattern: "every_n_days",
      anchorOn: "2027-09-06",
      repeatEvery: 7,
    });
    await run(EMPLOYEE, envelope("routine", { action: "complete", routineId, dueOn: "2027-09-06" }));
    await run(EMPLOYEE, envelope("routine", { action: "uncomplete", routineId, dueOn: "2027-09-06" }));

    // La fila sigue ahí: el historial de E2 puede enseñar quién la marcó y
    // quién la deshizo. Lo que cambia es que deja de contar.
    const stored = await adminPool.query<{
      due_on: string;
      voided: boolean;
      completed_by: string;
      voided_by: string | null;
    }>(
      `select due_on::text as due_on,
              voided_at is not null as voided,
              completed_by_membership_id::text as completed_by,
              voided_by_membership_id::text as voided_by
         from app.routine_completions
        where household_id = $1 and routine_id = $2`,
      [ROBLE_HOUSEHOLD, routineId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ due_on: "2027-09-06", voided: true });
    expect(stored.rows[0]?.voided_by).toBe(stored.rows[0]?.completed_by);
  });

  it("la empleada no deshace lo que marcó otra persona; la administración sí", async () => {
    const routineId = await upsertRoutine({
      title: "Limpieza de campana",
      audience: "all",
      pattern: "every_n_days",
      anchorOn: "2027-10-04",
      repeatEvery: 7,
    });
    await run(ADMIN, envelope("routine", { action: "complete", routineId, dueOn: "2027-10-04" }));

    const refused = await run(
      EMPLOYEE,
      envelope("routine", { action: "uncomplete", routineId, dueOn: "2027-10-04" }),
    );
    expect(refused).toMatchObject({ status: "rejected", errorCode: "not_allowed" });
    expect(await nextDueHint(routineId)).toBe("2027-10-11");

    const allowed = await run(
      ADMIN,
      envelope("routine", { action: "uncomplete", routineId, dueOn: "2027-10-04" }),
    );
    expect(allowed).toMatchObject({ status: "accepted" });
    expect(await nextDueHint(routineId)).toBe("2027-10-04");
  });

  it("tras deshacer se puede volver a marcar de verdad la misma ocurrencia", async () => {
    // La mitad silenciosa de E5.1: la clave primaria es (hogar, rutina,
    // ocurrencia), así que sin revivir la fila anulada deshacer dejaría la
    // ocurrencia bloqueada para siempre.
    const routineId = await upsertRoutine({
      title: "Cristales del salón",
      audience: "all",
      pattern: "every_n_days",
      anchorOn: "2027-11-01",
      repeatEvery: 7,
    });
    await run(ADMIN, envelope("routine", { action: "complete", routineId, dueOn: "2027-11-01" }));
    await run(ADMIN, envelope("routine", { action: "uncomplete", routineId, dueOn: "2027-11-01" }));

    const again = await run(
      EMPLOYEE,
      envelope("routine", { action: "complete", routineId, dueOn: "2027-11-01" }),
    );
    expect(again).toMatchObject({ status: "accepted" });
    expect(await nextDueHint(routineId)).toBe("2027-11-08");
    // Sigue habiendo UNA fila por ocurrencia; la anulada revivió a nombre de
    // quien la hizo de verdad.
    const rows = await adminPool.query<{ voided: boolean }>(
      `select voided_at is not null as voided
         from app.routine_completions where household_id = $1 and routine_id = $2`,
      [ROBLE_HOUSEHOLD, routineId],
    );
    expect(rows.rows).toEqual([{ voided: false }]);
  });

  it("deshacer algo que no está marcado se rechaza; deshacerlo dos veces, no", async () => {
    const routineId = await upsertRoutine({
      title: "Poda de la buganvilla",
      audience: "all",
      pattern: "every_n_days",
      anchorOn: "2027-12-06",
      repeatEvery: 7,
    });

    const nothing = await run(
      ADMIN,
      envelope("routine", { action: "uncomplete", routineId, dueOn: "2027-12-06" }),
    );
    expect(nothing).toMatchObject({ status: "rejected", errorCode: "completion_not_found" });

    await run(ADMIN, envelope("routine", { action: "complete", routineId, dueOn: "2027-12-06" }));
    await run(ADMIN, envelope("routine", { action: "uncomplete", routineId, dueOn: "2027-12-06" }));
    // El segundo toque suele ser el mismo dedo, o un envelope que la cola sin
    // conexión reintenta: no es un error, es un no-op.
    const twice = await run(
      ADMIN,
      envelope("routine", { action: "uncomplete", routineId, dueOn: "2027-12-06" }),
    );
    expect(twice).toMatchObject({ status: "accepted", resourceId: routineId });
  });

  it("el replay del mismo envelope no marca dos veces ni encola un segundo aviso", async () => {
    const routineId = await upsertRoutine({
      title: "Riego del porche",
      audience: "all",
      pattern: "every_n_days",
      anchorOn: "2027-07-05",
      repeatEvery: 7,
    });
    const command = envelope("routine", { action: "complete", routineId, dueOn: "2027-07-05" });

    const first = await run(ADMIN, command);
    expect(first).toMatchObject({ status: "accepted", resourceId: routineId });
    const jobsAfterFirst = (await routineDueJobs(routineId)).length;

    // Idempotencia por recibo: el mismo operationId devuelve el mismo ACK sin
    // volver a ejecutar el comando. Sin esto, un reintento de la cola sin
    // conexión daría `already_completed` y el cliente lo leería como error.
    const replayed = await run(ADMIN, command);
    expect(replayed).toMatchObject({ status: "duplicate", resourceId: routineId });
    expect(await completionsOf(routineId)).toEqual(["2027-07-05"]);
    expect(await routineDueJobs(routineId)).toHaveLength(jobsAfterFirst);
  });

  it("crear un feed devuelve el token una sola vez y la base guarda solo su sha-256", async () => {
    const command = envelope("ics_feed", { action: "create", audience: "employee" });
    const created = await run(ADMIN, command);
    expect(created).toMatchObject({ status: "accepted" });
    const feedId = created.resourceId as string;
    const token = (created as CommandAckV1 & { feedToken?: string }).feedToken as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await adminPool.query<{ token_hash: string; audience: string; revoked_at: Date | null }>(
      "select token_hash, audience::text as audience, revoked_at from app.ics_feeds where id = $1",
      [feedId],
    );
    expect(stored.rows).toEqual([
      {
        token_hash: createHash("sha256").update(token, "utf8").digest("hex"),
        audience: "employee",
        revoked_at: null,
      },
    ]);

    // El replay idempotente del MISMO comando devuelve el MISMO token desde el
    // recibo persistido, sin crear un segundo feed.
    const replayed = await run(ADMIN, command);
    expect(replayed).toMatchObject({ status: "duplicate", resourceId: feedId });
    expect((replayed as CommandAckV1 & { feedToken?: string }).feedToken).toBe(token);
    const count = await adminPool.query(
      "select count(*)::int as feeds from app.ics_feeds where token_hash = $1",
      [createHash("sha256").update(token, "utf8").digest("hex")],
    );
    expect(count.rows[0]).toEqual({ feeds: 1 });

    // La revocación invalida el feed y es idempotente.
    const revoked = await run(ADMIN, envelope("ics_feed", { action: "revoke", feedId }));
    expect(revoked).toMatchObject({ status: "accepted", resourceId: feedId });
    const afterRevoke = await adminPool.query<{ revoked: boolean }>(
      "select revoked_at is not null as revoked from app.ics_feeds where id = $1",
      [feedId],
    );
    expect(afterRevoke.rows[0]).toEqual({ revoked: true });

    const revokedAgain = await run(ADMIN, envelope("ics_feed", { action: "revoke", feedId }));
    expect(revokedAgain).toMatchObject({ status: "accepted", resourceId: feedId });
  });

  it("solo family_admin gestiona feeds; la empleada es rechazada", async () => {
    const denied = await run(EMPLOYEE, envelope("ics_feed", { action: "create", audience: "employee" }));
    expect(denied).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const missing = await run(ADMIN, envelope("ics_feed", { action: "revoke", feedId: randomUUID() }));
    expect(missing).toMatchObject({ status: "rejected", errorCode: "feed_not_found" });
  });

  it("el alta de una fuente https encola ics.sync_source con la URL en el payload", async () => {
    const created = await run(
      ADMIN,
      envelope("ics_feed", {
        action: "upsert_source",
        url: "https://calendario.example.com/colegio.ics",
        label: "Calendario del colegio",
        enabled: true,
      }),
    );
    expect(created).toMatchObject({ status: "accepted" });
    const sourceId = created.resourceId as string;

    const source = await adminPool.query<{ url: string; label: string; enabled: boolean }>(
      "select url, label, enabled from app.ics_sources where id = $1",
      [sourceId],
    );
    expect(source.rows).toEqual([
      { url: "https://calendario.example.com/colegio.ics", label: "Calendario del colegio", enabled: true },
    ]);

    const jobs = await adminPool.query<{ payload: Record<string, unknown> }>(
      `select payload from app_private.job_queue
        where household_id = $1 and job_type = 'ics.sync_source'
          and payload ->> 'sourceId' = $2`,
      [ROBLE_HOUSEHOLD, sourceId],
    );
    expect(jobs.rows).toEqual([
      { payload: { sourceId, url: "https://calendario.example.com/colegio.ics" } },
    ]);
  });
});
