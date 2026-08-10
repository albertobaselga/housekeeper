import { createHash, randomBytes } from "node:crypto";

import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import {
  icsFeedCommandPayloadSchema,
  routineCompletePayloadSchema,
  routineUpsertPayloadSchema,
  type RoutineUpsertPayload,
  type RoutineUpsertV2Payload,
} from "@casa-clara/contracts/schemas";
import {
  nextOccurrenceOnOrAfter,
  overduePolicyFor,
  pendingFor,
  PENDING_LOOKBACK_DAYS,
  type RoutineOverduePolicy,
  type RoutinePattern,
  type RoutineRule,
  type RoutineSchedule,
} from "@casa-clara/domain";

import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler, type CommandHandlers } from "../sync.js";
import { addDays } from "./shared.js";

export const ROUTINE_DUE_JOB = "notification.routine_due";
export const ICS_SYNC_JOB = "ics.sync_source";

type RoutineAudience = "family" | "employee" | "all";
type RoutineFrequency = "daily" | "weekly" | "monthly" | "quarterly";

/**
 * El día del hogar. Una ocurrencia es un DÍA de calendario, no un instante: si
 * la caché se calculara en UTC, entre medianoche y las 02:00 de Madrid el
 * servidor creería que aún es ayer y una rutina diaria se quedaría un día
 * atrás. La aplicación es de una sola zona (no hay columna de zona en
 * `app.households`), así que la constante es el modelo correcto y no un atajo.
 */
const HOUSEHOLD_TIME_ZONE = "Europe/Madrid";

/** Hoy según el reloj del hogar, preguntado a la base para no depender del proceso. */
async function householdToday(client: PoolClient): Promise<string> {
  const result = await client.query<{ today: string }>(
    "select (statement_timestamp() at time zone $1)::date::text as today",
    [HOUSEHOLD_TIME_ZONE],
  );
  const today = result.rows[0]?.today;
  if (!today) throw new Error("La base no devolvió la fecha del hogar");
  return today;
}

/** ISO 1=lunes … 7=domingo, la convención de `extract(isodow …)`, sin zona. */
function isoWeekdayOf(isoDate: string): number {
  const weekday = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/**
 * Traducción de la forma ANTIGUA a la regla de la 0023 (§3.2), el único sitio
 * donde vive esa tabla:
 *
 *   daily,     k  →  every_n_days,  repeat_every = k
 *   weekly,    k  →  days_of_week,  repeat_every = k,   weekdays = [isodow]
 *   monthly,   k  →  day_of_month,  repeat_every = k,   month_day = day
 *   quarterly, k  →  day_of_month,  repeat_every = 3·k, month_day = day
 *
 * `anchorOn = nextDueOn` no es una elección estética: hace que la fecha que la
 * rutina tenía pendiente sea, por construcción, una ocurrencia de la regla
 * nueva. Es la misma tabla que aplicó la migración a las filas ya escritas, de
 * modo que un envelope encolado sin conexión antes del despliegue aterriza
 * exactamente donde habría aterrizado de haberse enviado a tiempo.
 */
function legacyRoutineRule(
  frequency: RoutineFrequency,
  intervalCount: number,
  nextDueOn: string,
): RoutineRule {
  switch (frequency) {
    case "daily":
      return { pattern: "every_n_days", anchorOn: nextDueOn, repeatEvery: intervalCount };
    case "weekly":
      return {
        pattern: "days_of_week",
        anchorOn: nextDueOn,
        repeatEvery: intervalCount,
        weekdays: [isoWeekdayOf(nextDueOn)],
      };
    case "monthly":
      return {
        pattern: "day_of_month",
        anchorOn: nextDueOn,
        repeatEvery: intervalCount,
        monthDay: Number(nextDueOn.slice(8, 10)),
      };
    case "quarterly":
      return {
        pattern: "day_of_month",
        anchorOn: nextDueOn,
        repeatEvery: 3 * intervalCount,
        monthDay: Number(nextDueOn.slice(8, 10)),
      };
  }
}

/**
 * Próxima ocurrencia a partir de la actual según la frecuencia heredada.
 *
 * @deprecated Vestigio. Ya NO calcula nada: traduce a la regla de la 0023 y
 * pregunta al generador de `@casa-clara/domain`, que es la única aritmética de
 * recurrencia que queda en pie. Sobrevive solo porque
 * `apps/web/src/routes/api/v1/ics/[token]/+server.ts` todavía la importa para
 * proyectar ocurrencias sueltas; **T8 la borra** al emitir RRULE de verdad
 * (§5.4). Ningún comando de este fichero la llama.
 */
export function advanceDueDate(
  isoDate: string,
  frequency: RoutineFrequency,
  intervalCount: number,
): string {
  const rule = legacyRoutineRule(frequency, intervalCount, isoDate);
  return nextOccurrenceOnOrAfter(rule, addDays(isoDate, 1)) ?? isoDate;
}

/**
 * Roles cuyo correo recibe el aviso de una rutina según su audiencia. El rol
 * `helper` puede ver rutinas 'all' pero deliberadamente NO recibe avisos, y la
 * audiencia 'family' JAMÁS incluye a la empleada (AC-25).
 */
const AUDIENCE_ROLES: Readonly<Record<RoutineAudience, readonly string[]>> = {
  family: ["family_admin", "family_member"],
  employee: ["employee_live_in"],
  all: ["family_admin", "family_member", "employee_live_in"],
};

/**
 * Correos de los destinatarios vivos de la audiencia EN el momento del
 * encolado, leídos bajo RLS del actor. Un administrador familiar ve todos los
 * perfiles del hogar; un `family_member` o la empleada solo ven el suyo propio,
 * así que sus encolados salen con la lista parcial que su RLS permite.
 */
async function resolveAudienceRecipients(
  client: PoolClient,
  householdId: UUID,
  audience: RoutineAudience,
): Promise<string[]> {
  const result = await client.query<{ email: string }>(
    `select distinct profile.email
       from app.household_memberships as membership
       join app.user_profiles as profile on profile.user_id = membership.user_id
      where membership.household_id = $1
        and membership.role::text = any($2::text[])
        and membership.starts_at <= now()
        and membership.revoked_at is null
        and (membership.expires_at is null or membership.expires_at > now())
        and profile.email is not null
        and length(btrim(profile.email)) > 0
      order by profile.email`,
    [householdId, AUDIENCE_ROLES[audience]],
  );
  return result.rows.map((row) => row.email);
}

/** Encola el aviso de una ocurrencia con run_at = su fecha de vencimiento. */
async function enqueueRoutineDue(
  client: PoolClient,
  householdId: UUID,
  routine: { id: UUID; title: string; audience: RoutineAudience },
  dueOn: string,
): Promise<void> {
  const recipients = await resolveAudienceRecipients(client, householdId, routine.audience);
  await client.query(
    `select app.enqueue_job($1, $2::jsonb, greatest($3::date::timestamptz, statement_timestamp()))`,
    [
      ROUTINE_DUE_JOB,
      JSON.stringify({
        routineId: routine.id,
        title: routine.title,
        audience: routine.audience,
        recipients,
      }),
      dueOn,
    ],
  );
}

function requireFamilyRole(membership: ActiveMembership): void {
  if (membership.role !== "family_admin" && membership.role !== "family_member") {
    throw new CommandRejectedError("not_allowed", "Solo la familia gestiona las rutinas");
  }
}

function requireAdmin(membership: ActiveMembership): void {
  if (membership.role !== "family_admin") {
    throw new CommandRejectedError("not_allowed", "Solo la familia administradora gestiona los feeds ICS");
  }
}

/** Las columnas de patrón de `app.routines`, tal y como viajan al SQL. */
interface RoutineScheduleColumns {
  pattern: RoutinePattern | null;
  anchorOn: string | null;
  repeatEvery: number | null;
  weekdays: number[] | null;
  monthDay: number | null;
  months: number[] | null;
  endsOn: string | null;
}

const NO_SCHEDULE_COLUMNS: RoutineScheduleColumns = {
  pattern: null,
  anchorOn: null,
  repeatEvery: null,
  weekdays: null,
  monthDay: null,
  months: null,
  endsOn: null,
};

/**
 * Regla → columnas. Cada patrón deja explícitamente en `null` lo que no le
 * corresponde: la CHECK `routines_pattern_shape` no solo exige que estén los
 * campos del patrón, exige que NO estén los de los demás, de modo que una
 * edición que cambia «los lunes» por «cada 3 días» tiene que borrar `weekdays`
 * y no solo escribir `repeat_every`.
 */
function scheduleColumns(schedule: RoutineSchedule): RoutineScheduleColumns {
  if (schedule === null) return NO_SCHEDULE_COLUMNS;
  return {
    pattern: schedule.pattern,
    anchorOn: schedule.anchorOn,
    repeatEvery: schedule.pattern === "months_of_year" ? null : schedule.repeatEvery,
    weekdays: schedule.pattern === "days_of_week" ? [...schedule.weekdays] : null,
    monthDay:
      schedule.pattern === "day_of_month" || schedule.pattern === "months_of_year"
        ? schedule.monthDay
        : null,
    months: schedule.pattern === "months_of_year" ? [...schedule.months] : null,
    endsOn: schedule.endsOn ?? null,
  };
}

/**
 * Valor para `frequency` e `interval_count`, que siguen siendo NOT NULL hasta
 * que la 0024 las borre (§3.5). No son estado: son sombra. Se eligen para que
 * un lector heredado que todavía no se haya reescrito —la página de Rutinas
 * hasta T5, el feed ICS hasta T8— enseñe algo parecido en vez de un absurdo,
 * pero NADIE debe volver a decidir nada con ellas: la verdad son las columnas
 * de patrón. Cuando la cadencia rica no cabe en el vocabulario viejo («cada 15
 * días», «en junio y en diciembre») la sombra miente a conciencia, porque el
 * vocabulario viejo no puede decirlo y esa es precisamente la razón de la ola.
 */
function legacyShadowColumns(schedule: RoutineSchedule): {
  frequency: RoutineFrequency;
  intervalCount: number;
} {
  if (schedule === null) return { frequency: "daily", intervalCount: 1 };
  switch (schedule.pattern) {
    case "every_n_days":
      return schedule.repeatEvery % 7 === 0 && schedule.repeatEvery / 7 <= 12
        ? { frequency: "weekly", intervalCount: schedule.repeatEvery / 7 }
        : { frequency: "daily", intervalCount: Math.min(schedule.repeatEvery, 12) };
    case "days_of_week":
      return { frequency: "weekly", intervalCount: schedule.repeatEvery };
    case "day_of_month":
      return schedule.repeatEvery > 12 && schedule.repeatEvery % 3 === 0
        ? { frequency: "quarterly", intervalCount: schedule.repeatEvery / 3 }
        : { frequency: "monthly", intervalCount: Math.min(schedule.repeatEvery, 12) };
    case "months_of_year": {
      const monthsApart = 12 / schedule.months.length;
      return Number.isInteger(monthsApart)
        ? { frequency: "monthly", intervalCount: monthsApart }
        : { frequency: "monthly", intervalCount: 1 };
    }
  }
}

/** Carga rica → regla del generador. */
function scheduleFromPayload(payload: RoutineUpsertV2Payload): RoutineSchedule {
  switch (payload.pattern) {
    case null:
      return null;
    case "every_n_days":
      return {
        pattern: "every_n_days",
        anchorOn: payload.anchorOn,
        repeatEvery: payload.repeatEvery,
        endsOn: payload.endsOn ?? null,
      };
    case "days_of_week":
      return {
        pattern: "days_of_week",
        anchorOn: payload.anchorOn,
        repeatEvery: payload.repeatEvery,
        weekdays: payload.weekdays,
        endsOn: payload.endsOn ?? null,
      };
    case "day_of_month":
      return {
        pattern: "day_of_month",
        anchorOn: payload.anchorOn,
        repeatEvery: payload.repeatEvery,
        monthDay: payload.monthDay,
        endsOn: payload.endsOn ?? null,
      };
    case "months_of_year":
      return {
        pattern: "months_of_year",
        anchorOn: payload.anchorOn,
        months: payload.months,
        monthDay: payload.monthDay,
        endsOn: payload.endsOn ?? null,
      };
  }
}

interface RoutineUpsertRequest {
  routineId?: UUID | undefined;
  title: string;
  details: string;
  audience: RoutineAudience;
  schedule: RoutineSchedule;
}

/**
 * Las dos formas del contrato colapsan aquí en una sola (§3.4). A partir de
 * esta línea el comando no sabe —ni tiene por qué saber— si el envelope venía
 * de un dispositivo con la app nueva o de uno que quedó encolado antes del
 * despliegue.
 */
function routineUpsertRequest(payload: RoutineUpsertPayload): RoutineUpsertRequest {
  const identity = {
    routineId: payload.routineId as UUID | undefined,
    title: payload.title,
    details: payload.details ?? "",
    audience: payload.audience,
  };
  return "pattern" in payload
    ? { ...identity, schedule: scheduleFromPayload(payload) }
    : {
        ...identity,
        schedule: legacyRoutineRule(payload.frequency, payload.intervalCount, payload.nextDueOn),
      };
}

/** Los `due_on` ya registrados, dentro de la ventana que mira el generador. */
async function completedDueOns(
  client: PoolClient,
  householdId: UUID,
  routineId: UUID,
  todayISO: string,
): Promise<Set<string>> {
  const result = await client.query<{ due_on: string }>(
    `select due_on::text as due_on
       from app.routine_completions
      where household_id = $1 and routine_id = $2 and due_on >= $3::date`,
    [householdId, routineId, addDays(todayISO, -PENDING_LOOKBACK_DAYS)],
  );
  return new Set(result.rows.map((row) => row.due_on));
}

/**
 * La caché `next_due_on` (§2.7): cota INFERIOR de la próxima ocurrencia
 * pendiente. `pendingFor` ya la devuelve calculada —la atrasada más antigua si
 * la hay, si no la de hoy, si no la siguiente—, así que aquí no se recalcula
 * nada. `null` significa «no queda nada pendiente» y saca la rutina de los
 * prefiltros `next_due_on <= hoy`, que es exactamente lo que se quiere.
 */
function nextDueHintFor(
  schedule: RoutineSchedule,
  policy: RoutineOverduePolicy,
  completed: ReadonlySet<string>,
  todayISO: string,
): string | null {
  return pendingFor(schedule, policy, completed, todayISO).nextDueHint;
}

async function upsertRoutine(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: RoutineUpsertPayload,
): Promise<{ resourceId: UUID }> {
  requireFamilyRole(membership);

  const request = routineUpsertRequest(payload);
  const columns = scheduleColumns(request.schedule);
  const shadow = legacyShadowColumns(request.schedule);
  // La política de atrasadas se DERIVA del patrón (§2.5) y en un único sitio:
  // `overduePolicyFor` vive en el módulo puro. Aquí no se pregunta ni se
  // acepta del cliente, porque en fase 1 no hay control que la ofrezca y la
  // regla acierta en el 100 % de los casos del manual.
  const overduePolicy = overduePolicyFor(request.schedule);
  const today = await householdToday(client);
  // Al editar hay que contar con lo ya marcado: si la familia cambia «los
  // lunes» por «los lunes y los jueves» y el lunes ya está hecho, la caché
  // tiene que apuntar al jueves, no volver al lunes.
  const completed = request.routineId
    ? await completedDueOns(client, householdId, request.routineId, today)
    : new Set<string>();
  const nextDueOn = nextDueHintFor(request.schedule, overduePolicy, completed, today);

  const scheduleValues = [
    columns.pattern,
    columns.anchorOn,
    columns.repeatEvery,
    columns.weekdays,
    columns.monthDay,
    columns.months,
    columns.endsOn,
    overduePolicy,
    nextDueOn,
    shadow.frequency,
    shadow.intervalCount,
  ];

  if (request.routineId) {
    const updated = await client.query<{ id: string }>(
      `update app.routines
          set title = $3, details = $4, audience = $5::app.routine_audience,
              pattern = $6::app.routine_pattern, anchor_on = $7::date, repeat_every = $8,
              weekdays = $9::smallint[], month_day = $10::smallint, months = $11::smallint[],
              ends_on = $12::date, overdue_policy = $13::app.routine_overdue_policy,
              next_due_on = $14::date,
              frequency = $15::app.routine_frequency, interval_count = $16
        where household_id = $1 and id = $2 and archived_at is null
        returning id`,
      [
        householdId,
        request.routineId,
        request.title,
        request.details,
        request.audience,
        ...scheduleValues,
      ],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new CommandRejectedError("routine_not_found", "La rutina no existe o está archivada");
    }
    // Editar la regla NO rearma el aviso encolado: el job antiguo seguiría
    // apuntando a la fecha vieja y encolar otro dejaría dos. Lo arregla el
    // barrido diario de T4 (§5.2), que no depende de encolados por ocurrencia.
    return { resourceId: request.routineId };
  }

  const inserted = await client.query<{ id: string }>(
    `insert into app.routines
       (household_id, title, details, audience,
        pattern, anchor_on, repeat_every, weekdays, month_day, months, ends_on,
        overdue_policy, next_due_on, frequency, interval_count,
        created_by_membership_id)
     values ($1, $2, $3, $4::app.routine_audience,
             $5::app.routine_pattern, $6::date, $7, $8::smallint[], $9::smallint, $10::smallint[],
             $11::date, $12::app.routine_overdue_policy, $13::date,
             $14::app.routine_frequency, $15, $16)
     returning id`,
    [householdId, request.title, request.details, request.audience, ...scheduleValues, membership.id],
  );
  const routineId = inserted.rows[0]?.id;
  if (!routineId) throw new Error("La inserción de la rutina no devolvió identificador");

  // Primer aviso de la rutina recién creada, para su primera ocurrencia. Una
  // rutina sin cadencia confirmada no encola nada: no aparece en Hoy, no avisa
  // (§2.3).
  if (nextDueOn) {
    await enqueueRoutineDue(
      client,
      householdId,
      { id: routineId, title: request.title, audience: request.audience },
      nextDueOn,
    );
  }
  return { resourceId: routineId };
}

interface RoutineCompletePayload {
  routineId: UUID;
  dueOn: string;
}

/** Fila de patrón ya leída → regla del generador. */
function scheduleFromRow(row: {
  pattern: string | null;
  anchor_on: string | null;
  repeat_every: number | null;
  weekdays: number[] | null;
  month_day: number | null;
  months: number[] | null;
  ends_on: string | null;
}): RoutineSchedule {
  if (row.pattern === null) return null;
  // La CHECK `routines_pattern_shape` hace imposible llegar aquí con un hueco.
  // Si aun así llegara (fila escrita antes de la 0023 por una vía que ya no
  // existe), se rechaza el comando en vez de lanzar: un `internal` haría que el
  // cliente reintentara para siempre un envelope que nunca va a entrar.
  const invalid = (): never => {
    throw new CommandRejectedError(
      "routine_rule_invalid",
      "La rutina tiene una cadencia incompleta en la base",
    );
  };
  const anchorOn = row.anchor_on ?? invalid();
  const endsOn = row.ends_on;
  switch (row.pattern) {
    case "every_n_days":
      return { pattern: "every_n_days", anchorOn, repeatEvery: row.repeat_every ?? invalid(), endsOn };
    case "days_of_week":
      return {
        pattern: "days_of_week",
        anchorOn,
        repeatEvery: row.repeat_every ?? invalid(),
        weekdays: row.weekdays ?? invalid(),
        endsOn,
      };
    case "day_of_month":
      return {
        pattern: "day_of_month",
        anchorOn,
        repeatEvery: row.repeat_every ?? invalid(),
        monthDay: row.month_day ?? invalid(),
        endsOn,
      };
    case "months_of_year":
      return {
        pattern: "months_of_year",
        anchorOn,
        months: row.months ?? invalid(),
        monthDay: row.month_day ?? invalid(),
        endsOn,
      };
    default:
      return invalid();
  }
}

async function completeRoutine(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: RoutineCompletePayload,
): Promise<{ resourceId: UUID }> {
  // La audiencia manda vía RLS: si la rutina no es visible para el actor
  // (p. ej. helper ante una rutina 'employee'), "no visible" y "no existe"
  // colapsan en el mismo rechazo.
  const loaded = await client.query<{
    id: string;
    title: string;
    audience: RoutineAudience;
    pattern: string | null;
    anchor_on: string | null;
    repeat_every: number | null;
    weekdays: number[] | null;
    month_day: number | null;
    months: number[] | null;
    ends_on: string | null;
    overdue_policy: RoutineOverduePolicy;
    next_due_on: string | null;
    archived: boolean;
  }>(
    `select id, title, audience::text as audience,
            pattern::text as pattern, anchor_on::text as anchor_on, repeat_every,
            weekdays::int[] as weekdays, month_day::int as month_day, months::int[] as months,
            ends_on::text as ends_on, overdue_policy::text as overdue_policy,
            next_due_on::text as next_due_on,
            archived_at is not null as archived
       from app.routines
      where household_id = $1 and id = $2`,
    [householdId, payload.routineId],
  );
  const routine = loaded.rows[0];
  if (!routine || routine.archived) {
    throw new CommandRejectedError("routine_not_found", "La rutina no existe o no es visible");
  }
  // Único rechazo nuevo de §2.9: una rutina que aún no tiene día no se puede
  // dar por hecha, porque no hay ocurrencia que marcar. El `dueOn` en cambio
  // sigue siendo deliberadamente permisivo (una finalización es un hecho).
  if (routine.pattern === null) {
    throw new CommandRejectedError(
      "routine_has_no_schedule",
      "La rutina todavía no tiene cadencia: primero hay que ponerle día",
    );
  }
  const schedule = scheduleFromRow(routine);

  const existing = await client.query(
    `select 1 from app.routine_completions
      where household_id = $1 and routine_id = $2 and due_on = $3`,
    [householdId, payload.routineId, payload.dueOn],
  );
  if ((existing.rowCount ?? 0) > 0) {
    throw new CommandRejectedError("already_completed", "La ocurrencia ya está completada");
  }

  try {
    await client.query(
      `insert into app.routine_completions
         (household_id, routine_id, due_on, completed_by_membership_id)
       values ($1, $2, $3, $4)`,
      [householdId, payload.routineId, payload.dueOn, membership.id],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new CommandRejectedError("already_completed", "La ocurrencia ya está completada");
    }
    throw error;
  }

  // El calendario NO se mueve al marcar: las ocurrencias se generan desde el
  // ancla, así que lo único que hay que refrescar es la caché. Se recalcula
  // desde la regla y TODAS las finalizaciones, no desde la ocurrencia que
  // acaba de entrar: así marcar tarde deja de empujar la serie un intervalo
  // por toque (la cinta de correr de §2.9) y completar una atrasada limpia la
  // atrasada en vez de inventarse una fecha.
  //
  // La escritura de `app.routines` es solo familiar por RLS, pero la empleada y
  // el apoyo también completan; `app.set_routine_due_hint` (0023) es la definer
  // que lo permite, y ahora solo actualiza una columna: exige contexto y una
  // finalización real de este hogar, que es la que se acaba de insertar.
  const today = await householdToday(client);
  const completed = await completedDueOns(client, householdId, payload.routineId, today);
  const nextDueOn = nextDueHintFor(schedule, routine.overdue_policy, completed, today);
  if (nextDueOn !== null && nextDueOn !== routine.next_due_on) {
    await client.query("select app.set_routine_due_hint($1, $2::date)", [
      payload.routineId,
      nextDueOn,
    ]);
    await enqueueRoutineDue(
      client,
      householdId,
      { id: routine.id, title: routine.title, audience: routine.audience },
      nextDueOn,
    );
  }

  return { resourceId: routine.id };
}

/**
 * `routine`: alta/edición (solo familia) y finalización por ocurrencia (según
 * audiencia, que hace cumplir la RLS).
 *
 * El alta acepta LAS DOS formas del contrato (§3.4): la cadencia rica de la
 * 0023 y la de antes del despliegue, que se traduce. No es cortesía —un
 * dispositivo con la app vieja puede tener envelopes en su cola desde antes, y
 * rechazarlos perdería el trabajo de quien lo hizo sin conexión—. La rama vieja
 * se retira en T10, un despliegue después.
 *
 * Completar ya no avanza nada: refresca la caché `next_due_on` recalculada
 * desde la regla con `pendingFor`, y encola el aviso de la siguiente si cambió.
 */
export const routineCommandHandler: CommandHandler = async (client, membership, envelope) => {
  const action = (envelope.payload as { action?: unknown } | null | undefined)?.action;
  if (action === "upsert") {
    const parsed = routineUpsertPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
    }
    return upsertRoutine(client, membership, envelope.householdId, parsed.data);
  }
  if (action === "complete") {
    const parsed = routineCompletePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
    }
    return completeRoutine(client, membership, envelope.householdId, parsed.data);
  }
  throw new CommandRejectedError("invalid_payload", "Acción de rutina no soportada");
};

interface IcsFeedCreatePayload {
  audience: RoutineAudience;
}

async function createIcsFeed(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: IcsFeedCreatePayload,
): Promise<{ resourceId: UUID; feedToken: string }> {
  // El token solo existe en claro aquí y en el ACK persistido en el recibo
  // idempotente (app.command_receipts, legible únicamente bajo la RLS del
  // hogar); la base guarda exclusivamente su sha-256. Un replay `duplicate`
  // de la misma operación devuelve el mismo ACK y por tanto el mismo token.
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const inserted = await client.query<{ id: string }>(
    `insert into app.ics_feeds (household_id, audience, token_hash, created_by_membership_id)
     values ($1, $2::app.routine_audience, $3, $4)
     returning id`,
    [householdId, payload.audience, tokenHash, membership.id],
  );
  const feedId = inserted.rows[0]?.id;
  if (!feedId) throw new Error("La inserción del feed ICS no devolvió identificador");
  return { resourceId: feedId, feedToken: token };
}

async function revokeIcsFeed(
  client: PoolClient,
  householdId: UUID,
  feedId: UUID,
): Promise<{ resourceId: UUID }> {
  const revoked = await client.query(
    `update app.ics_feeds
        set revoked_at = statement_timestamp()
      where household_id = $1 and id = $2 and revoked_at is null`,
    [householdId, feedId],
  );
  if ((revoked.rowCount ?? 0) === 0) {
    const exists = await client.query(
      `select 1 from app.ics_feeds where household_id = $1 and id = $2`,
      [householdId, feedId],
    );
    if ((exists.rowCount ?? 0) === 0) {
      throw new CommandRejectedError("feed_not_found", "El feed no existe en este hogar");
    }
    // Ya estaba revocado: la revocación es idempotente.
  }
  return { resourceId: feedId };
}

interface IcsSourceUpsertPayload {
  sourceId?: UUID | undefined;
  url: string;
  label: string;
  enabled: boolean;
}

async function upsertIcsSource(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: IcsSourceUpsertPayload,
): Promise<{ resourceId: UUID }> {
  let sourceId: UUID;
  if (payload.sourceId) {
    const updated = await client.query<{ id: string }>(
      `update app.ics_sources
          set url = $3, label = $4, enabled = $5
        where household_id = $1 and id = $2
        returning id`,
      [householdId, payload.sourceId, payload.url, payload.label, payload.enabled],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new CommandRejectedError("source_not_found", "La fuente ICS no existe en este hogar");
    }
    sourceId = payload.sourceId;
  } else {
    const inserted = await client.query<{ id: string }>(
      `insert into app.ics_sources (household_id, url, label, enabled, created_by_membership_id)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [householdId, payload.url, payload.label, payload.enabled, membership.id],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("La inserción de la fuente ICS no devolvió identificador");
    sourceId = id;
  }

  // El worker no tiene grant sobre app.ics_sources, así que la URL viaja en el
  // propio job y la sincronización arranca de inmediato tras el alta/edición.
  // Al desactivar la fuente, el mismo job con `clear` vacía sus eventos ya
  // persistidos (0015) para que el Calendario no siga mostrando un calendario
  // que la familia dejó de enlazar.
  const jobPayload = payload.enabled
    ? { sourceId, url: payload.url }
    : { sourceId, url: payload.url, clear: true };
  await client.query(`select app.enqueue_job($1, $2::jsonb)`, [
    ICS_SYNC_JOB,
    JSON.stringify(jobPayload),
  ]);
  return { resourceId: sourceId };
}

/**
 * `ics_feed` (solo family_admin): creación de feeds de salida con token de un
 * solo vistazo (en base solo el sha-256), revocación idempotente y alta/edición
 * de fuentes https de entrada con encolado inmediato de su sincronización.
 */
export const icsFeedCommandHandler: CommandHandler = async (client, membership, envelope) => {
  const parsed = icsFeedCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  requireAdmin(membership);
  const payload = parsed.data;
  switch (payload.action) {
    case "create":
      return createIcsFeed(client, membership, envelope.householdId, payload);
    case "revoke":
      return revokeIcsFeed(client, envelope.householdId, payload.feedId);
    case "upsert_source":
      return upsertIcsSource(client, membership, envelope.householdId, payload);
  }
};

/**
 * Mapa de handlers del ritmo doméstico (oleada 4) listo para enchufarse a la
 * ruta de sync junto al resto: rutinas con audiencia y fontanería ICS.
 */
export const rhythmCommandHandlers: CommandHandlers = {
  routine: routineCommandHandler,
  ics_feed: icsFeedCommandHandler,
};
