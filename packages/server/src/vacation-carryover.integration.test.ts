import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type AggregateType,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@housekeeper/contracts";

import { agreementCommandHandler, vacationCommandHandler } from "./commands/vacation.js";
import { processSyncBatch, type CommandHandlers } from "./sync.js";
import type { AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const ROBLE_ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
/** El acuerdo de la fixture, que NO pacta el precio del día de vacaciones. */
const UNPRICED_AGREEMENT = "12000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };
const FAMILY: AuthenticatedPrincipal = { userId: "fixture:roble:family" };

const HANDLERS: CommandHandlers = {
  leave_request: vacationCommandHandler,
  agreement: agreementCommandHandler,
};

/*
 * Contrato PROPIO de esta suite, sembrado aquí y no en las fixtures.
 *
 * Hacen falta varios años de contrato ya cerrados y una tarifa del día de
 * vacaciones PACTADA, y ninguna de las dos cosas se puede añadir a los acuerdos
 * de la fixture sin mover por debajo los totales que comprueban otras suites:
 * apilar una versión nueva sobre el acuerdo del roble dejaría sus complementos
 * (que cuelgan de la versión) fuera de las cuentas de 2028, y ponerle tarifa a
 * la versión vigente rompería la batería de la pantalla del acuerdo, que
 * comprueba que ahí pone «Sin pactar».
 *
 * Empieza el 5 de marzo de 2021, así que sus cinco primeros años de contrato
 * están cerrados y el sexto corre:
 *
 *   1º  5-mar-2021 … 4-mar-2022      4º  5-mar-2024 … 4-mar-2025
 *   2º  5-mar-2022 … 4-mar-2023      5º  5-mar-2025 … 4-mar-2026
 *   3º  5-mar-2023 … 4-mar-2024      6º  5-mar-2026 … 4-mar-2027  (en curso)
 */
const CARRYOVER_EMPLOYEE = "1e000000-0000-4000-8000-000000000001";
const CARRYOVER_AGREEMENT = "1e100000-0000-4000-8000-000000000001";
const CARRYOVER_V1 = "1e200000-0000-4000-8000-000000000001";
const CARRYOVER_V2 = "1e200000-0000-4000-8000-000000000002";
/** 46,15 € el día. 18 días sin disfrutar = 830,70 €. */
const DAY_RATE_CENTS = 4615n;

function envelope(
  aggregateType: AggregateType,
  payload: unknown,
  operationId = randomUUID(),
): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId,
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType,
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-09-01T10:00:00.000Z",
    payload,
  };
}

interface CarryoverRow {
  id: string;
  status: string;
  source_year_index: number;
  source_year_starts_on: string;
  source_year_ends_on: string;
  entitled_days: number;
  taken_days: number;
  unused_days: number;
  agreement_version_id: string;
  compensation_cents: string | null;
  compensation_basis: string | null;
  deadline_on: string | null;
  decision_reason: string | null;
  decided_by_membership_id: string | null;
  manual_adjustment_id: string | null;
}

describe.runIf(Boolean(adminUrl))("arrastre de vacaciones sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(
    principal: AuthenticatedPrincipal,
    command: CommandEnvelopeV1,
  ): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [command], HANDLERS);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
  }

  function decide(
    action: "carry_over" | "compensate_carryover" | "reject_carryover",
    sourceYearIndex: number,
    extra: Record<string, unknown> = {},
    agreementId: string = CARRYOVER_AGREEMENT,
  ): CommandEnvelopeV1 {
    return envelope("leave_request", { action, agreementId, sourceYearIndex, ...extra });
  }

  async function carryoverFor(sourceYearIndex: number): Promise<CarryoverRow | undefined> {
    const rows = await adminPool.query<CarryoverRow>(
      `select id, status::text as status, source_year_index,
              source_year_starts_on::text as source_year_starts_on,
              source_year_ends_on::text as source_year_ends_on,
              entitled_days, taken_days, unused_days, agreement_version_id,
              compensation_cents::text as compensation_cents, compensation_basis,
              deadline_on::text as deadline_on, decision_reason,
              decided_by_membership_id, manual_adjustment_id
         from app.vacation_carryovers
        where agreement_id = $1 and source_year_index = $2`,
      [CARRYOVER_AGREEMENT, sourceYearIndex],
    );
    return rows.rows[0];
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 4 });
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 4 });

    await adminPool.query("begin");
    await adminPool.query("set local row_security = off");
    await adminPool.query(
      `insert into app.user_profiles (user_id, display_name)
       values ('fixture:roble:carryover', 'Fixture Empleada del Arrastre')
       on conflict (user_id) do nothing`,
    );
    await adminPool.query(
      `insert into app.household_memberships (id, household_id, user_id, role)
       values ($1, $2, 'fixture:roble:carryover', 'employee_live_in')
       on conflict (id) do nothing`,
      [CARRYOVER_EMPLOYEE, ROBLE_HOUSEHOLD],
    );
    await adminPool.query(
      `insert into app.employment_agreements
         (id, household_id, employee_membership_id, starts_on, created_by_membership_id)
       values ($1, $2, $3, '2021-03-05', $4)
       on conflict (id) do nothing`,
      [CARRYOVER_AGREEMENT, ROBLE_HOUSEHOLD, CARRYOVER_EMPLOYEE, ROBLE_ADMIN_MEMBERSHIP],
    );
    // v1 sin tarifa y con la caducidad por omisión (terms vacío = seis meses).
    // v2 pacta el precio del día, sube el derecho a 32 y dice que los días
    // arrastrados NO expiran: con eso, el 5º año —cuyo derecho fija v2— sale con
    // 32 días y sin fecha límite, y los anteriores siguen con 30 y con margen.
    await adminPool.query(
      `insert into app.agreement_versions
         (id, household_id, agreement_id, version_number, effective_from,
          monthly_salary_cents, overtime_hourly_rate_cents, worked_rest_day_rate_cents,
          contracted_weekly_minutes, annual_vacation_days, unused_vacation_day_rate_cents,
          terms, reason, created_by_membership_id)
       values
         ($1, $3, $4, 1, '2021-03-05', 100000, 0, 0, 2400, 30, NULL,
          '{}'::jsonb, 'Alta del contrato del arrastre', $5),
         ($2, $3, $4, 2, '2026-01-01', 110000, 0, 0, 2400, 32, $6,
          '{"vacationCarryoverExpiry":{"mode":"never"}}'::jsonb,
          'Se pacta el precio del día de vacaciones no disfrutado', $5)
       on conflict (id) do nothing`,
      [
        CARRYOVER_V1,
        CARRYOVER_V2,
        ROBLE_HOUSEHOLD,
        CARRYOVER_AGREEMENT,
        ROBLE_ADMIN_MEMBERSHIP,
        DAY_RATE_CENTS.toString(),
      ],
    );
    await adminPool.query("commit");
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("arrastrar congela los días, la versión y el importe, y el precio sale de la versión VIGENTE", async () => {
    // Doce días disfrutados dentro del primer año de contrato: quedan 18.
    const apuntado = await run(
      ADMIN,
      envelope("leave_request", {
        action: "record",
        agreementId: CARRYOVER_AGREEMENT,
        startsOn: "2021-08-01",
        endsOn: "2021-08-12",
        note: "Quincena corta del primer año",
      }),
    );
    expect(apuntado).toMatchObject({ status: "accepted" });

    const accepted = await run(ADMIN, decide("carry_over", 1));
    expect(accepted).toMatchObject({ status: "accepted" });

    const row = await carryoverFor(1);
    expect(row).toMatchObject({
      status: "carried",
      source_year_starts_on: "2021-03-05",
      source_year_ends_on: "2022-03-04",
      entitled_days: 30,
      taken_days: 12,
      unused_days: 18,
      // El DERECHO lo fijó la versión vigente al terminar aquel año, no la de
      // hoy: cambiar los días pactados en 2026 no reescribe un año ya vivido.
      agreement_version_id: CARRYOVER_V1,
      // Seis meses desde el fin del año de contrato: v1 no pacta otra cosa.
      deadline_on: "2022-09-04",
      decided_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      manual_adjustment_id: null,
    });
    // 18 × 46,15 € = 830,70 €. El PRECIO sí sale de la versión vigente HOY
    // (apartado 4.4 del diseño), y la frase congelada dice desde cuándo rige.
    expect(row?.compensation_cents).toBe((DAY_RATE_CENTS * 18n).toString());
    expect(row?.compensation_basis).toContain("18 días sin disfrutar");
    expect(row?.compensation_basis).toContain("vigentes desde el 1 de enero de 2026");
    expect(row?.compensation_basis).toContain("830,70");
  });

  it("anular un periodo del año origen DESPUÉS de decidir no mueve la fila", async () => {
    const periodo = await adminPool.query<{ id: string }>(
      `select id from app.vacation_periods
        where agreement_id = $1 and starts_on = '2021-08-01' and status = 'recorded'`,
      [CARRYOVER_AGREEMENT],
    );
    const periodId = periodo.rows[0]?.id;
    expect(periodId).toBeDefined();

    const voided = await run(
      ADMIN,
      envelope("leave_request", {
        action: "void",
        vacationPeriodId: periodId,
        reason: "Al final no se cogieron",
      }),
    );
    expect(voided).toMatchObject({ status: "accepted" });

    // Recalcular ahora daría 30 días sin disfrutar y 1.384,50 €. La fila sigue
    // diciendo lo que se decidió: es la promesa entera de esta tabla.
    const row = await carryoverFor(1);
    expect(row).toMatchObject({ taken_days: 12, unused_days: 18, entitled_days: 30 });
    expect(row?.compensation_cents).toBe((DAY_RATE_CENTS * 18n).toString());
  });

  it("compensar crea el concepto en la misma transacción y enlaza las dos direcciones", async () => {
    const accepted = await run(
      ADMIN,
      decide("compensate_carryover", 2, { period: "2026-09" }),
    );
    expect(accepted).toMatchObject({ status: "accepted" });

    const row = await carryoverFor(2);
    expect(row).toMatchObject({ status: "compensated", entitled_days: 30, unused_days: 30 });
    expect(row?.manual_adjustment_id).not.toBeNull();

    const concept = await adminPool.query<{
      label: string;
      reason: string;
      amount: string;
      adds_to_pay: boolean;
      period: string;
      vacation_carryover_id: string | null;
    }>(
      `select label, reason, amount_cents::text as amount, adds_to_pay,
              to_char(period_month, 'YYYY-MM') as period, vacation_carryover_id
         from app.manual_adjustments where id = $1`,
      [row?.manual_adjustment_id],
    );
    expect(concept.rows[0]).toEqual({
      label: "Vacaciones del segundo año no disfrutadas",
      // El motivo del concepto ES la frase congelada del arrastre: la cuenta del
      // mes explica de dónde sale el importe sin salir de la línea.
      reason: row?.compensation_basis,
      amount: (DAY_RATE_CENTS * 30n).toString(),
      adds_to_pay: true,
      period: "2026-09",
      // La otra dirección del enlace: ningún concepto de vacaciones queda
      // huérfano y ningún arrastre se puede pagar dos veces.
      vacation_carryover_id: row?.id,
    });
  });

  it("rechazar exige motivo, lo guarda y no mueve ni un céntimo", async () => {
    const mudo = await run(ADMIN, decide("reject_carryover", 3));
    expect(mudo).toMatchObject({ status: "rejected", errorCode: "invalid_payload" });

    const accepted = await run(
      ADMIN,
      decide("reject_carryover", 3, { reason: "Se habló con ella y prefirió no arrastrarlos" }),
    );
    expect(accepted).toMatchObject({ status: "accepted" });

    const row = await carryoverFor(3);
    expect(row).toMatchObject({
      status: "rejected",
      decision_reason: "Se habló con ella y prefirió no arrastrarlos",
      manual_adjustment_id: null,
    });
  });

  it("«nunca expiran» no pone fecha límite, y el derecho lo fija la versión del año que cierra", async () => {
    const accepted = await run(ADMIN, decide("carry_over", 5));
    expect(accepted).toMatchObject({ status: "accepted" });

    const row = await carryoverFor(5);
    expect(row).toMatchObject({
      status: "carried",
      source_year_ends_on: "2026-03-04",
      // v2 rige desde el 1 de enero de 2026, así que es la que fija el derecho
      // del quinto año: 32 días, no los 30 de v1.
      entitled_days: 32,
      agreement_version_id: CARRYOVER_V2,
      // …y también la política: v2 dice que los días arrastrados nunca expiran.
      deadline_on: null,
    });
  });

  it("un año ya decidido no se decide dos veces, ni siquiera a la vez", async () => {
    const repetido = await run(ADMIN, decide("carry_over", 5));
    expect(repetido).toMatchObject({
      status: "rejected",
      errorCode: "vacation_carryover_decided",
    });

    // Y ahora de verdad a la vez, sobre un año todavía sin decidir: dos
    // administradores (o dos pestañas) pulsando «Compensar» en el mismo
    // instante. El cerrojo consultivo del espacio 6 serializa las dos
    // transacciones; la segunda encuentra la fila y se rechaza. Sin él saldrían
    // dos conceptos por los mismos días.
    const [uno, otro] = await Promise.all([
      run(ADMIN, decide("compensate_carryover", 4, { period: "2026-09" })),
      run(ADMIN, decide("compensate_carryover", 4, { period: "2026-09" })),
    ]);
    const estados = [uno.status, otro.status].sort();
    expect(estados).toEqual(["accepted", "rejected"]);

    const filas = await adminPool.query<{ total: string }>(
      `select count(*)::text as total from app.vacation_carryovers
        where agreement_id = $1 and source_year_index = 4`,
      [CARRYOVER_AGREEMENT],
    );
    expect(filas.rows[0]?.total).toBe("1");

    const conceptos = await adminPool.query<{ total: string }>(
      `select count(*)::text as total
         from app.manual_adjustments as concepto
         join app.vacation_carryovers as arrastre
           on arrastre.id = concepto.vacation_carryover_id
        where arrastre.agreement_id = $1 and arrastre.source_year_index = 4`,
      [CARRYOVER_AGREEMENT],
    );
    expect(conceptos.rows[0]?.total).toBe("1");
  });

  it("sin tarifa pactada no hay compensación: se dice lo que falta y no se inventa un importe", async () => {
    const rechazado = await run(
      ADMIN,
      decide("compensate_carryover", 1, { period: "2026-09" }, UNPRICED_AGREEMENT),
    );
    expect(rechazado).toMatchObject({
      status: "rejected",
      errorCode: "vacation_day_rate_not_agreed",
    });

    // Ni fila, ni concepto, ni un cero escrito en ninguna parte.
    const filas = await adminPool.query<{ total: string }>(
      `select count(*)::text as total from app.vacation_carryovers where agreement_id = $1`,
      [UNPRICED_AGREEMENT],
    );
    expect(filas.rows[0]?.total).toBe("0");

    // Pero arrastrarlos sí se puede, y la fila queda SIN importe: es la
    // diferencia entre «no se pactó» y «vale cero euros».
    const arrastrado = await run(ADMIN, decide("carry_over", 1, {}, UNPRICED_AGREEMENT));
    expect(arrastrado).toMatchObject({ status: "accepted" });
    const row = await adminPool.query<{
      compensation_cents: string | null;
      compensation_basis: string | null;
    }>(
      `select compensation_cents::text as compensation_cents, compensation_basis
         from app.vacation_carryovers where agreement_id = $1 and source_year_index = 1`,
      [UNPRICED_AGREEMENT],
    );
    expect(row.rows[0]).toEqual({ compensation_cents: null, compensation_basis: null });
  });

  it("el año de contrato en curso no se cierra: hasta que acabe, los días se pueden coger", async () => {
    const rechazado = await run(ADMIN, decide("carry_over", 6));
    expect(rechazado).toMatchObject({
      status: "rejected",
      errorCode: "vacation_year_not_closed",
    });
  });

  it("cambiar el derecho anual NO borra el precio del día ya pactado", async () => {
    // Apilar una versión copia lo pactado; si la tarifa se quedara fuera de esa
    // copia, el contrato pasaría de tener precio a no tenerlo sin que nadie lo
    // decidiera y la pantalla dejaría de ofrecer compensar sin explicar por qué.
    const accepted = await run(
      ADMIN,
      envelope("agreement", {
        action: "set_vacation_entitlement",
        agreementId: CARRYOVER_AGREEMENT,
        annualVacationDays: 33,
        effectiveFrom: "2026-10-01",
        reason: "Un día más de vacaciones al año",
      }),
    );
    expect(accepted).toMatchObject({ status: "accepted" });

    const version = await adminPool.query<{
      annual_vacation_days: number;
      rate: string | null;
      terms: unknown;
    }>(
      `select annual_vacation_days,
              unused_vacation_day_rate_cents::text as rate, terms
         from app.agreement_versions where id = $1`,
      [accepted.resourceId],
    );
    expect(version.rows[0]).toEqual({
      annual_vacation_days: 33,
      rate: DAY_RATE_CENTS.toString(),
      terms: { vacationCarryoverExpiry: { mode: "never" } },
    });
  });

  it("ni la empleada ni la familia no administradora deciden sobre los días", async () => {
    for (const principal of [EMPLOYEE, FAMILY]) {
      const rechazado = await run(
        principal,
        decide("reject_carryover", 7, { reason: "No debería entrar" }),
      );
      expect(rechazado).toMatchObject({ status: "rejected", errorCode: "not_allowed" });
    }
    const filas = await adminPool.query<{ total: string }>(
      `select count(*)::text as total from app.vacation_carryovers
        where agreement_id = $1 and source_year_index = 7`,
      [CARRYOVER_AGREEMENT],
    );
    expect(filas.rows[0]?.total).toBe("0");
  });
});
