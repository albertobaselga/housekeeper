import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type AggregateType,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@casa-clara/contracts";

import { extraWorkCommandHandler } from "./commands/extra-work.js";
import { processSyncBatch, type CommandHandlers } from "./sync.js";
import type { AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const AGREEMENT_ONE = "12000000-0000-4000-8000-000000000001";
const AGREEMENT_TWO = "12000000-0000-4000-8000-000000000002";
const EMPLOYEE_ONE = "11000000-0000-4000-8000-000000000003";
const EMPLOYEE_TWO = "11000000-0000-4000-8000-000000000006";
const ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const AGREEMENT_ONE_V2 = "12100000-0000-4000-8000-000000000002";
const AGREEMENT_TWO_V1 = "12100000-0000-4000-8000-000000000003";
// Conceptos del acuerdo de la primera empleada (versión 2, vigente desde abril).
const TYPE_JORNADA_EXTRA = "13000000-0000-4000-8000-000000000005";
const TYPE_NOCHE_DE_GUARDIA = "13000000-0000-4000-8000-000000000006";
const TYPE_SIN_TARIFA = "13000000-0000-4000-8000-000000000007";
// Conceptos del acuerdo de la segunda empleada.
const TYPE_JORNADA_COMPLETA = "13000000-0000-4000-8000-000000000008";
const APP_LOGIN = "it_casa_clara_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE_ONE_USER: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };
const FAMILY: AuthenticatedPrincipal = { userId: "fixture:roble:family" };

const HANDLERS: CommandHandlers = { extra_work: extraWorkCommandHandler };

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
    occurredAt: "2026-08-10T09:00:00.000Z",
    payload,
  };
}

/*
 * Octubre de 2025: mes que ningún otro suite toca (marzo viene de la fixture,
 * abril de la liquidación, junio de gastos, julio del despido). Los suites
 * comparten base y se ordenan alfabéticamente sin paralelismo, así que cada uno
 * trabaja en su propio calendario.
 */
describe.runIf(Boolean(adminUrl))("la administración apunta jornadas extra a nombre de una empleada", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(principal: AuthenticatedPrincipal, command: CommandEnvelopeV1): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [command], HANDLERS);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
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

  it("apunta una jornada del catálogo a nombre de la empleada y la deja pendiente de decidir", async () => {
    const registered = await run(
      ADMIN,
      envelope("extra_work", {
        action: "register",
        agreementId: AGREEMENT_ONE,
        extraWorkTypeId: TYPE_JORNADA_EXTRA,
        kind: "overtime",
        workedOn: "2025-10-06",
        durationMinutes: 60,
        note: "Se quedó con los niños el puente",
      }),
    );
    expect(registered).toMatchObject({ status: "accepted" });
    const eventId = registered.resourceId as string;

    const row = await adminPool.query(
      `select origin::text as origin, status::text as status, employee_membership_id,
              requested_by_membership_id, extra_work_type_id, kind::text as kind, note
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    // El hecho consta a nombre de la empleada del acuerdo, con la familia como
    // quien lo apuntó, y `kind` derivado de la unidad del concepto (per_shift),
    // no del "overtime" que mandó el cliente: el concepto es la verdad.
    expect(row.rows[0]).toEqual({
      origin: "family_request",
      status: "requested",
      employee_membership_id: EMPLOYEE_ONE,
      requested_by_membership_id: ADMIN_MEMBERSHIP,
      extra_work_type_id: TYPE_JORNADA_EXTRA,
      kind: "worked_rest_day",
      note: "Se quedó con los niños el puente",
    });

    const transitions = await adminPool.query(
      `select sequence_number, from_status::text as from_status, to_status::text as to_status,
              actor_membership_id
         from app.extra_work_transitions
        where extra_work_event_id = $1 order by sequence_number`,
      [eventId],
    );
    expect(transitions.rows).toEqual([
      {
        sequence_number: 1,
        from_status: null,
        to_status: "requested",
        actor_membership_id: ADMIN_MEMBERSHIP,
      },
    ]);
  });

  it("apunta y resuelve en el acto: valora con la tarifa del concepto vigente ese día y firma cada transición", async () => {
    const registered = await run(
      ADMIN,
      envelope("extra_work", {
        action: "register",
        agreementId: AGREEMENT_ONE,
        extraWorkTypeId: TYPE_JORNADA_EXTRA,
        kind: "worked_rest_day",
        workedOn: "2025-10-13",
        durationMinutes: 600,
        note: "Jornada completa del lunes festivo",
        resolveNow: { resolution: "money", reason: "Se le paga con la nómina de octubre" },
      }),
    );
    expect(registered).toMatchObject({ status: "accepted" });
    const eventId = registered.resourceId as string;

    const row = await adminPool.query(
      `select status::text as status, resolution::text as resolution, resolved_agreement_version_id,
              frozen_unit_rate_cents::text as unit, frozen_amount_cents::text as amount,
              balance_minutes, approved_by_membership_id, performed_by_membership_id,
              resolved_by_membership_id, resolution_reason
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    // 5000 cts es la tarifa de «Jornada extra» en la versión 2 del acuerdo, la
    // vigente en octubre. Nadie tecleó ese importe: sale del catálogo.
    expect(row.rows[0]).toEqual({
      status: "resolved",
      resolution: "money",
      resolved_agreement_version_id: AGREEMENT_ONE_V2,
      unit: "5000",
      amount: "5000",
      balance_minutes: 0,
      approved_by_membership_id: ADMIN_MEMBERSHIP,
      // El trabajo lo hizo ella aunque lo apunte y lo resuelva la familia.
      performed_by_membership_id: EMPLOYEE_ONE,
      resolved_by_membership_id: ADMIN_MEMBERSHIP,
      resolution_reason: "Se le paga con la nómina de octubre",
    });

    // Nada de saltos: el expediente conserva los tres pasos, firmados.
    const transitions = await adminPool.query(
      `select sequence_number, from_status::text as from_status, to_status::text as to_status,
              actor_membership_id, reason
         from app.extra_work_transitions
        where extra_work_event_id = $1 order by sequence_number`,
      [eventId],
    );
    expect(transitions.rows).toEqual([
      {
        sequence_number: 1,
        from_status: null,
        to_status: "requested",
        actor_membership_id: ADMIN_MEMBERSHIP,
        reason: "Jornada extra apuntada por la familia",
      },
      {
        sequence_number: 2,
        from_status: "requested",
        to_status: "performed_pending_resolution",
        actor_membership_id: ADMIN_MEMBERSHIP,
        reason: "Trabajo reconocido al resolver",
      },
      {
        sequence_number: 3,
        from_status: "performed_pending_resolution",
        to_status: "resolved",
        actor_membership_id: ADMIN_MEMBERSHIP,
        reason: "Se le paga con la nómina de octubre",
      },
    ]);
  });

  it("resuelta en descanso, el crédito permanente entra en el libro de compensaciones de esa empleada", async () => {
    const registered = await run(
      ADMIN,
      envelope("extra_work", {
        action: "register",
        agreementId: AGREEMENT_ONE,
        extraWorkTypeId: TYPE_NOCHE_DE_GUARDIA,
        kind: "worked_rest_day",
        workedOn: "2025-10-20",
        durationMinutes: 720,
        resolveNow: { resolution: "time_off", reason: "Prefiere el día libre" },
      }),
    );
    expect(registered).toMatchObject({ status: "accepted" });
    const eventId = registered.resourceId as string;

    const row = await adminPool.query(
      `select status::text as status, resolution::text as resolution,
              frozen_amount_cents::text as amount, balance_minutes
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    // Descanso: cero dinero y los 720 minutos de referencia del concepto.
    expect(row.rows[0]).toEqual({
      status: "resolved",
      resolution: "time_off",
      amount: "0",
      balance_minutes: 720,
    });

    const entry = await adminPool.query(
      `select entry.delta_minutes::text as delta_minutes, entry.effective_on::text as effective_on,
              account.employee_membership_id
         from app.compensation_ledger_entries as entry
         join app.compensation_accounts as account on account.id = entry.account_id
        where entry.source_id = $1`,
      [eventId],
    );
    expect(entry.rows).toEqual([
      { delta_minutes: "720", effective_on: "2025-10-20", employee_membership_id: EMPLOYEE_ONE },
    ]);
  });

  it("elige a la empleada por su acuerdo y no deja cruzar el catálogo de una con el de la otra", async () => {
    const registered = await run(
      ADMIN,
      envelope("extra_work", {
        action: "register",
        agreementId: AGREEMENT_TWO,
        extraWorkTypeId: TYPE_JORNADA_COMPLETA,
        kind: "worked_rest_day",
        workedOn: "2025-10-07",
        durationMinutes: 600,
        resolveNow: { resolution: "money", reason: "Cubrió el turno de la compañera" },
      }),
    );
    expect(registered).toMatchObject({ status: "accepted" });

    const row = await adminPool.query(
      `select employee_membership_id, resolved_agreement_version_id,
              frozen_amount_cents::text as amount
         from app.extra_work_events where id = $1`,
      [registered.resourceId as string],
    );
    expect(row.rows[0]).toEqual({
      employee_membership_id: EMPLOYEE_TWO,
      resolved_agreement_version_id: AGREEMENT_TWO_V1,
      amount: "6000",
    });

    // El concepto de una no vale para el acuerdo de la otra aunque quien
    // administra vea los dos catálogos.
    const crossed = await run(
      ADMIN,
      envelope("extra_work", {
        action: "register",
        agreementId: AGREEMENT_TWO,
        extraWorkTypeId: TYPE_JORNADA_EXTRA,
        kind: "worked_rest_day",
        workedOn: "2025-10-08",
        durationMinutes: 600,
      }),
    );
    expect(crossed).toMatchObject({ status: "rejected", errorCode: "extra_work_type_not_available" });
  });

  it("rechaza lo que el catálogo no permite: sin tarifa, fuera de vigencia y con motivo vacío", async () => {
    const withoutRate = await run(
      ADMIN,
      envelope("extra_work", {
        action: "register",
        agreementId: AGREEMENT_ONE,
        extraWorkTypeId: TYPE_SIN_TARIFA,
        kind: "worked_rest_day",
        workedOn: "2025-10-09",
        durationMinutes: 120,
        resolveNow: { resolution: "money", reason: "Acompañamiento al médico" },
      }),
    );
    // El concepto existe pactado pero sin precio: el motor puro se niega a
    // inventarle uno y la transacción entera se deshace.
    expect(withoutRate).toMatchObject({ status: "rejected" });

    const notInForce = await run(
      ADMIN,
      envelope("extra_work", {
        action: "register",
        agreementId: AGREEMENT_ONE,
        extraWorkTypeId: TYPE_JORNADA_EXTRA,
        // La versión 2 entra en vigor el 1 de abril de 2025: en marzo ese
        // concepto todavía no estaba pactado.
        kind: "worked_rest_day",
        workedOn: "2025-03-05",
        durationMinutes: 600,
      }),
    );
    expect(notInForce).toMatchObject({ status: "rejected", errorCode: "extra_work_type_not_in_force" });

    const emptyReason = await run(
      ADMIN,
      envelope("extra_work", {
        action: "register",
        agreementId: AGREEMENT_ONE,
        extraWorkTypeId: TYPE_JORNADA_EXTRA,
        kind: "worked_rest_day",
        workedOn: "2025-10-10",
        durationMinutes: 600,
        resolveNow: { resolution: "money", reason: "   " },
      }),
    );
    expect(emptyReason).toMatchObject({ status: "rejected", errorCode: "invalid_payload" });
  });

  it("la empleada no puede apuntar trabajo a su compañera ni resolver el suyo en el acto", async () => {
    const otherAgreement = await run(
      EMPLOYEE_ONE_USER,
      envelope("extra_work", {
        action: "register",
        agreementId: AGREEMENT_TWO,
        extraWorkTypeId: TYPE_JORNADA_COMPLETA,
        kind: "worked_rest_day",
        workedOn: "2025-10-14",
        durationMinutes: 600,
      }),
    );
    expect(otherAgreement).toMatchObject({ status: "rejected", errorCode: "agreement_not_found" });

    const selfResolve = await run(
      EMPLOYEE_ONE_USER,
      envelope("extra_work", {
        action: "register",
        agreementId: AGREEMENT_ONE,
        extraWorkTypeId: TYPE_JORNADA_EXTRA,
        kind: "worked_rest_day",
        workedOn: "2025-10-15",
        durationMinutes: 600,
        resolveNow: { resolution: "money", reason: "Me la pago yo" },
      }),
    );
    expect(selfResolve).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    // Y nada de lo rechazado dejó rastro: la transacción se deshizo entera.
    const leftovers = await adminPool.query(
      `select count(*)::int as total from app.extra_work_events
        where agreement_id = $1 and worked_on = '2025-10-15'`,
      [AGREEMENT_ONE],
    );
    expect(leftovers.rows[0]).toEqual({ total: 0 });

    const familyMember = await run(
      FAMILY,
      envelope("extra_work", {
        action: "register",
        agreementId: AGREEMENT_ONE,
        extraWorkTypeId: TYPE_JORNADA_EXTRA,
        kind: "worked_rest_day",
        workedOn: "2025-10-16",
        durationMinutes: 600,
      }),
    );
    expect(familyMember).toMatchObject({ status: "rejected", errorCode: "not_allowed" });
  });

  it("la segunda empleada ve en su expediente la jornada que le apuntó la familia, y solo la suya", async () => {
    // Sobre el pool SIN BYPASSRLS y con el contexto de ella: lo que se lee aquí
    // es exactamente lo que Postgres le deja salir a su navegador.
    const client = await appPool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.user_id', $1, true)", ["fixture:roble:employee2"]);
      await client.query("select app.set_household_context($1, $2)", [ROBLE_HOUSEHOLD, EMPLOYEE_TWO]);
      const mine = await client.query(
        `select origin::text as origin, worked_on::text as worked_on,
                frozen_amount_cents::text as amount, employee_membership_id
           from app.extra_work_events
          order by worked_on`,
      );
      expect(mine.rows).toEqual([
        {
          origin: "family_request",
          worked_on: "2025-10-07",
          amount: "6000",
          employee_membership_id: EMPLOYEE_TWO,
        },
      ]);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});
