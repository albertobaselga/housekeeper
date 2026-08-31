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
const ROBLE_AGREEMENT = "12000000-0000-4000-8000-000000000001";
const ROBLE_EMPLOYEE_MEMBERSHIP = "11000000-0000-4000-8000-000000000003";
const ROBLE_ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };
const FAMILY: AuthenticatedPrincipal = { userId: "fixture:roble:family" };

const HANDLERS: CommandHandlers = {
  leave_request: vacationCommandHandler,
  agreement: agreementCommandHandler,
};

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
    occurredAt: "2026-08-07T11:00:00.000Z",
    payload,
  };
}

// Fechas de 2027: las fixtures viven en 2025 y los otros suites de integración
// reparten los meses de ese año, así que este fichero trabaja en un año que
// nadie más toca. El acuerdo de la fixture está abierto (`ends_on` nulo), de
// modo que 2027 queda dentro sin prorrateo.
describe.runIf(Boolean(adminUrl))("vacaciones: derecho anual y periodos disfrutados", () => {
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

  function record(startsOn: string, endsOn: string, note?: string): CommandEnvelopeV1 {
    return envelope("leave_request", {
      action: "record",
      agreementId: ROBLE_AGREEMENT,
      startsOn,
      endsOn,
      ...(note === undefined ? {} : { note }),
    });
  }

  beforeAll(() => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("la familia apunta un periodo, el replay responde duplicate y los días naturales salen con ambos extremos", async () => {
    const command = record("2027-08-01", "2027-08-15", "Quincena de agosto");
    const accepted = await run(ADMIN, command);
    expect(accepted).toMatchObject({ status: "accepted" });
    const periodId = accepted.resourceId as string;

    const row = await adminPool.query(
      `select employee_membership_id, recorded_by_membership_id, status, calendar_days, note,
              starts_on::text as starts_on, ends_on::text as ends_on
         from app.vacation_periods where id = $1`,
      [periodId],
    );
    expect(row.rows[0]).toEqual({
      employee_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP,
      recorded_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      status: "recorded",
      calendar_days: 15,
      note: "Quincena de agosto",
      starts_on: "2027-08-01",
      ends_on: "2027-08-15",
    });

    const replay = await run(ADMIN, command);
    expect(replay).toMatchObject({
      operationId: command.operationId,
      status: "duplicate",
      resourceId: periodId,
    });

    // Un solo día también es un periodo, y el de al lado no solapa.
    const oneDay = await run(ADMIN, record("2027-08-16", "2027-08-16"));
    expect(oneDay).toMatchObject({ status: "accepted" });
  });

  it("rechaza el solape con un periodo ya apuntado y lo dice con fechas", async () => {
    const first = await run(ADMIN, record("2027-03-01", "2027-03-10"));
    expect(first).toMatchObject({ status: "accepted" });

    // Se pisan por un solo día: sigue siendo solape.
    const clash = await run(ADMIN, record("2027-03-10", "2027-03-14"));
    expect(clash).toMatchObject({ status: "rejected", errorCode: "vacation_overlaps" });

    const inside = await run(ADMIN, record("2027-03-04", "2027-03-06"));
    expect(inside).toMatchObject({ status: "rejected", errorCode: "vacation_overlaps" });

    const after = await run(ADMIN, record("2027-03-11", "2027-03-14"));
    expect(after).toMatchObject({ status: "accepted" });
  });

  it("anular deja rastro, libera el hueco y no se puede repetir", async () => {
    const apuntado = await run(ADMIN, record("2027-05-03", "2027-05-07", "Fechas equivocadas"));
    const periodId = apuntado.resourceId as string;

    const voided = await run(
      ADMIN,
      envelope("leave_request", {
        action: "void",
        vacationPeriodId: periodId,
        reason: "Las fechas eran otras",
      }),
    );
    expect(voided).toMatchObject({ status: "accepted", resourceId: periodId });

    const row = await adminPool.query(
      `select status, voided_by_membership_id, void_reason,
              (voided_at is not null) as has_voided_at,
              starts_on::text as starts_on, note
         from app.vacation_periods where id = $1`,
      [periodId],
    );
    // La fila SIGUE ahí con lo que decía: anular no borra ni reescribe.
    expect(row.rows[0]).toEqual({
      status: "voided",
      voided_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      void_reason: "Las fechas eran otras",
      has_voided_at: true,
      starts_on: "2027-05-03",
      note: "Fechas equivocadas",
    });

    // El hueco queda libre: para eso sirve anular.
    const corregido = await run(ADMIN, record("2027-05-03", "2027-05-05", "Fechas corregidas"));
    expect(corregido).toMatchObject({ status: "accepted" });

    const again = await run(
      ADMIN,
      envelope("leave_request", {
        action: "void",
        vacationPeriodId: periodId,
        reason: "Segundo intento",
      }),
    );
    expect(again).toMatchObject({ status: "rejected", errorCode: "vacation_not_recorded" });

    const missing = await run(
      ADMIN,
      envelope("leave_request", {
        action: "void",
        vacationPeriodId: randomUUID(),
        reason: "No existe",
      }),
    );
    expect(missing).toMatchObject({ status: "rejected", errorCode: "vacation_not_recorded" });
  });

  it("ni la empleada ni la familia no administradora apuntan o anulan vacaciones", async () => {
    const byEmployee = await run(EMPLOYEE, record("2027-09-01", "2027-09-05"));
    expect(byEmployee).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const byFamily = await run(FAMILY, record("2027-09-01", "2027-09-05"));
    expect(byFamily).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const employeeVoid = await run(
      EMPLOYEE,
      envelope("leave_request", {
        action: "void",
        vacationPeriodId: randomUUID(),
        reason: "Intento indebido",
      }),
    );
    expect(employeeVoid).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const leaked = await adminPool.query(
      "select count(*)::int as total from app.vacation_periods where starts_on = '2027-09-01'",
    );
    expect(leaked.rows[0]).toEqual({ total: 0 });
  });

  it("no admite vacaciones anteriores al acuerdo ni periodos mal formados", async () => {
    // La fixture arranca el 2025-02-03.
    const before = await run(ADMIN, record("2025-01-10", "2025-01-14"));
    expect(before).toMatchObject({ status: "rejected", errorCode: "vacation_before_agreement" });

    const backwards = await run(ADMIN, record("2027-10-10", "2027-10-01"));
    expect(backwards).toMatchObject({ status: "rejected", errorCode: "invalid_payload" });

    const unknownAgreement = await run(
      ADMIN,
      envelope("leave_request", {
        action: "record",
        agreementId: randomUUID(),
        startsOn: "2027-11-01",
        endsOn: "2027-11-05",
      }),
    );
    expect(unknownAgreement).toMatchObject({
      status: "rejected",
      errorCode: "agreement_not_found",
    });
  });

  it("pasarse del derecho anual NO se rechaza: el exceso se apunta y el saldo lo enseña", async () => {
    // 40 días naturales seguidos contra un derecho de 30. La decisión de
    // producto es admitirlo y enseñar el saldo en negativo, no negar el hecho.
    const excess = await run(ADMIN, record("2027-06-01", "2027-07-10", "Excedencia pactada"));
    expect(excess).toMatchObject({ status: "accepted" });

    const row = await adminPool.query(
      "select calendar_days from app.vacation_periods where id = $1",
      [excess.resourceId],
    );
    expect(row.rows[0]).toEqual({ calendar_days: 40 });
  });

  it("cambiar el derecho anual apila una versión nueva que copia el resto de los términos", async () => {
    const before = await adminPool.query(
      `select version_number, monthly_salary_cents::text as salary, annual_vacation_days
         from app.agreement_versions
        where agreement_id = $1 order by version_number desc limit 1`,
      [ROBLE_AGREEMENT],
    );
    const previous = before.rows[0] as {
      version_number: number;
      salary: string;
      annual_vacation_days: number;
    };
    expect(previous.annual_vacation_days).toBe(30);

    const changed = await run(
      ADMIN,
      envelope("agreement", {
        action: "set_vacation_entitlement",
        agreementId: ROBLE_AGREEMENT,
        annualVacationDays: 32,
        effectiveFrom: "2027-01-01",
        reason: "Dos días más por convenio de la casa",
      }),
    );
    expect(changed).toMatchObject({ status: "accepted" });

    const created = await adminPool.query(
      `select version_number, effective_from::text as effective_from,
              monthly_salary_cents::text as salary, annual_vacation_days, reason,
              created_by_membership_id
         from app.agreement_versions where id = $1`,
      [changed.resourceId],
    );
    expect(created.rows[0]).toEqual({
      version_number: previous.version_number + 1,
      effective_from: "2027-01-01",
      // El salario viaja intacto: este comando cambia una cosa y solo una.
      salary: previous.salary,
      annual_vacation_days: 32,
      reason: "Dos días más por convenio de la casa",
      created_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
    });

    // La versión anterior sigue diciendo lo que decía: son inmutables.
    const untouched = await adminPool.query(
      "select annual_vacation_days from app.agreement_versions where version_number = $1 and agreement_id = $2",
      [previous.version_number, ROBLE_AGREEMENT],
    );
    expect(untouched.rows[0]).toEqual({ annual_vacation_days: previous.annual_vacation_days });
  });

  it("el derecho no se cambia hacia atrás, ni por quien no administra, ni para dejarlo igual", async () => {
    const retroactive = await run(
      ADMIN,
      envelope("agreement", {
        action: "set_vacation_entitlement",
        agreementId: ROBLE_AGREEMENT,
        annualVacationDays: 25,
        effectiveFrom: "2026-01-01",
        reason: "Intento retroactivo",
      }),
    );
    expect(retroactive).toMatchObject({
      status: "rejected",
      errorCode: "retroactive_agreement_version",
    });

    const unchanged = await run(
      ADMIN,
      envelope("agreement", {
        action: "set_vacation_entitlement",
        agreementId: ROBLE_AGREEMENT,
        annualVacationDays: 32,
        effectiveFrom: "2028-01-01",
        reason: "Lo mismo que ya hay",
      }),
    );
    expect(unchanged).toMatchObject({
      status: "rejected",
      errorCode: "vacation_entitlement_unchanged",
    });

    const byEmployee = await run(
      EMPLOYEE,
      envelope("agreement", {
        action: "set_vacation_entitlement",
        agreementId: ROBLE_AGREEMENT,
        annualVacationDays: 45,
        effectiveFrom: "2028-01-01",
        reason: "Me subo los días",
      }),
    );
    expect(byEmployee).toMatchObject({ status: "rejected", errorCode: "not_allowed" });
  });
});
