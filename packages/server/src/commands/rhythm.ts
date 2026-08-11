import { createHash, randomBytes } from "node:crypto";

import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import {
  icsFeedCommandPayloadSchema,
  retiredRoutineUpsertPayloadSchema,
  routineCompletePayloadSchema,
  routineUncompletePayloadSchema,
  routineUpsertPayloadSchema,
  type RoutineUpsertPayload,
} from "@casa-clara/contracts/schemas";
import {
  overduePolicyFor,
  pendingFor,
  PENDING_LOOKBACK_DAYS,
  type RoutineOverduePolicy,
  type RoutinePattern,
  type RoutineSchedule,
} from "@casa-clara/domain";

import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler, type CommandHandlers } from "../sync.js";
import { addDays } from "./shared.js";

export const ICS_SYNC_JOB = "ics.sync_source";

type RoutineAudience = "family" | "employee" | "all";

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

/*
 * Aquí vivían `legacyRoutineRule` —la tabla que traducía
 * `frequency`/`intervalCount`/`nextDueOn` a la regla de la 0023— y
 * `advanceDueDate`, el último vestigio del avance de fecha a la manera vieja.
 *
 * Las retira la 0033 (§3.5). La traducción existió durante exactamente un
 * despliegue, para que un envelope encolado sin conexión antes de la 0023
 * aterrizara donde habría aterrizado de haberse enviado a tiempo. Pasado ese
 * plazo deja de ser una red y pasa a ser un riesgo: la tabla no sabe expresar
 * «cada 15 días» ni «en junio y en diciembre», así que seguir aplicándola
 * escribiría una cadencia que nadie pidió. Una carga con la forma antigua que
 * llegue ahora se RECHAZA por su nombre (`routine_cadence_format_retired`),
 * que es lo honesto: no se guarda, y se dice por qué.
 *
 * `advanceDueDate` solo seguía viva porque el feed ICS la importaba. El feed
 * genera ahora sus ocurrencias con el motor puro de `@casa-clara/domain`, que
 * es la única aritmética de recurrencia que queda en pie en todo el árbol.
 */

/*
 * Aquí vivía `enqueueRoutineDue`: el aviso `notification.routine_due` que
 * encolaba, con la lista de correos de la audiencia dentro del payload, un
 * trabajo cuyo único efecto era mandar un correo.
 *
 * Se retiró con la migración 0029. No hay canal de correo —el canal es la
 * aplicación— y un trabajo que no puede hacer nada no debe encolarse: se
 * reintentaría, moriría y ensuciaría el log. De paso deja de copiarse una lista
 * de direcciones personales dentro de una fila de la cola.
 *
 * La rutina que vence se ve donde siempre se vio: en Hoy y en el calendario.
 * Cuando existan las notificaciones al móvil, el aviso vuelve por ahí y no por
 * aquí; queda anotado en docs/notificaciones.md.
 */

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

/*
 * Aquí vivía `legacyShadowColumns`, que elegía el valor de `frequency` e
 * `interval_count` en cada escritura. No eran estado: eran SOMBRA, escrita por
 * si un lector heredado las miraba, y mentían a conciencia en cuanto la
 * cadencia rica no cabía en el vocabulario viejo («cada 15 días» se guardaba
 * como `daily × 12`). La 0033 borra las dos columnas, así que ya no hay nada
 * que ensombrecer: la verdad son las columnas de patrón, y ahora es lo único
 * que se escribe.
 */

/** Carga rica → regla del generador. Ya no hay otra forma que traducir. */
function scheduleFromPayload(payload: RoutineUpsertPayload): RoutineSchedule {
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
 * Ya solo entra una forma (§3.5): la cadencia rica. La unión del contrato
 * desapareció con la 0033 y con ella el punto en que las dos colapsaban.
 */
function routineUpsertRequest(payload: RoutineUpsertPayload): RoutineUpsertRequest {
  return {
    routineId: payload.routineId as UUID | undefined,
    title: payload.title,
    details: payload.details ?? "",
    audience: payload.audience,
    schedule: scheduleFromPayload(payload),
  };
}

/**
 * Los `due_on` VIVOS ya registrados, dentro de la ventana que mira el
 * generador. Las finalizaciones anuladas (0031) no cuentan: es justamente lo
 * que hace que deshacer devuelva la rutina al día que le tocaba sin que nadie
 * recalcule una fecha nueva.
 */
async function completedDueOns(
  client: PoolClient,
  householdId: UUID,
  routineId: UUID,
  todayISO: string,
): Promise<Set<string>> {
  const result = await client.query<{ due_on: string }>(
    `select due_on::text as due_on
       from app.routine_completions
      where household_id = $1 and routine_id = $2 and due_on >= $3::date
        and voided_at is null`,
    [householdId, routineId, addDays(todayISO, -PENDING_LOOKBACK_DAYS)],
  );
  return new Set(result.rows.map((row) => row.due_on));
}

/**
 * La caché `next_due_hint` (§2.7): cota INFERIOR de la próxima ocurrencia
 * pendiente. `pendingFor` ya la devuelve calculada —la atrasada más antigua si
 * la hay, si no la de hoy, si no la siguiente—, así que aquí no se recalcula
 * nada. `null` significa «no queda nada pendiente» y saca la rutina de los
 * prefiltros `next_due_hint <= hoy`, que es exactamente lo que se quiere.
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
  const nextDueHint = nextDueHintFor(request.schedule, overduePolicy, completed, today);

  // Los mismos nueve valores para el UPDATE y el INSERT, pero con distinto
  // desplazamiento: en el UPDATE empiezan en $6 y en el INSERT en $5. Los casts
  // van pegados a la posición, no al valor, así que si tocas la lista tienes
  // que recontar AMBAS sentencias.
  const scheduleValues = [
    columns.pattern,
    columns.anchorOn,
    columns.repeatEvery,
    columns.weekdays,
    columns.monthDay,
    columns.months,
    columns.endsOn,
    overduePolicy,
    nextDueHint,
  ];

  if (request.routineId) {
    const updated = await client.query<{ id: string }>(
      `update app.routines
          set title = $3, details = $4, audience = $5::app.routine_audience,
              pattern = $6::app.routine_pattern, anchor_on = $7::date, repeat_every = $8,
              weekdays = $9::smallint[], month_day = $10::smallint, months = $11::smallint[],
              ends_on = $12::date, overdue_policy = $13::app.routine_overdue_policy,
              next_due_hint = $14::date
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
        overdue_policy, next_due_hint,
        created_by_membership_id)
     values ($1, $2, $3, $4::app.routine_audience,
             $5::app.routine_pattern, $6::date, $7, $8::smallint[], $9::smallint, $10::smallint[],
             $11::date, $12::app.routine_overdue_policy, $13::date, $14)
     returning id`,
    [householdId, request.title, request.details, request.audience, ...scheduleValues, membership.id],
  );
  const routineId = inserted.rows[0]?.id;
  if (!routineId) throw new Error("La inserción de la rutina no devolvió identificador");

  return { resourceId: routineId };
}

interface RoutineOccurrencePayload {
  routineId: UUID;
  dueOn: string;
}

/** Las columnas de patrón y política tal y como se leen para completar o deshacer. */
interface RoutineScheduleRow {
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
  next_due_hint: string | null;
  archived: boolean;
}

const ROUTINE_SCHEDULE_SELECT = `select id, title, audience::text as audience,
            pattern::text as pattern, anchor_on::text as anchor_on, repeat_every,
            weekdays::int[] as weekdays, month_day::int as month_day, months::int[] as months,
            ends_on::text as ends_on, overdue_policy::text as overdue_policy,
            next_due_hint::text as next_due_hint,
            archived_at is not null as archived
       from app.routines
      where household_id = $1 and id = $2`;

/**
 * Carga la rutina con su regla. La audiencia manda vía RLS: si la rutina no es
 * visible para el actor (p. ej. el apoyo ante una rutina 'employee'), «no
 * visible» y «no existe» colapsan en el mismo rechazo, que es lo que se quiere.
 */
async function loadRoutineSchedule(
  client: PoolClient,
  householdId: UUID,
  routineId: UUID,
): Promise<RoutineScheduleRow> {
  const loaded = await client.query<RoutineScheduleRow>(ROUTINE_SCHEDULE_SELECT, [
    householdId,
    routineId,
  ]);
  const routine = loaded.rows[0];
  if (!routine || routine.archived) {
    throw new CommandRejectedError("routine_not_found", "La rutina no existe o no es visible");
  }
  return routine;
}

/**
 * Refresca la caché `next_due_hint` desde la regla y TODAS las finalizaciones
 * vivas. Es el mismo cálculo tras marcar y tras deshacer, y por eso vive en un
 * solo sitio: si las dos rutas calcularan la fecha por su cuenta, deshacer
 * podría dejar la casa mirando un día distinto del que tenía.
 *
 * La escritura de `app.routines` es solo familiar por RLS, pero la empleada y
 * el apoyo también marcan; `app.set_routine_due_hint` (0023) es la definer que
 * lo permite y solo actualiza una columna. Su guardián exige que exista alguna
 * finalización de la rutina en este hogar: una anulada sigue existiendo, así
 * que deshacer también puede refrescar.
 */
async function refreshDueHint(
  client: PoolClient,
  householdId: UUID,
  routine: RoutineScheduleRow,
  schedule: RoutineSchedule,
): Promise<string | null> {
  const today = await householdToday(client);
  const completed = await completedDueOns(client, householdId, routine.id as UUID, today);
  const nextDueHint = nextDueHintFor(schedule, routine.overdue_policy, completed, today);
  if (nextDueHint !== null && nextDueHint !== routine.next_due_hint) {
    await client.query("select app.set_routine_due_hint($1, $2::date)", [routine.id, nextDueHint]);
  }
  return nextDueHint;
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
  payload: RoutineOccurrencePayload,
): Promise<{ resourceId: UUID }> {
  const routine = await loadRoutineSchedule(client, householdId, payload.routineId);
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

  const existing = await client.query<{ voided: boolean }>(
    `select voided_at is not null as voided
       from app.routine_completions
      where household_id = $1 and routine_id = $2 and due_on = $3`,
    [householdId, payload.routineId, payload.dueOn],
  );
  const previous = existing.rows[0];
  if (previous && !previous.voided) {
    throw new CommandRejectedError("already_completed", "La ocurrencia ya está completada");
  }

  if (previous) {
    // La ocurrencia se marcó, se deshizo y ahora se hace de verdad. La clave
    // primaria es (hogar, rutina, ocurrencia): no cabe una fila más, así que se
    // REVIVE la que hay. Sin esto, deshacer sería una trampa —la ocurrencia
    // quedaría bloqueada para siempre— y esa es la mitad silenciosa de E5.1.
    const revived = await client.query(
      `update app.routine_completions
          set voided_at = null,
              voided_by_membership_id = null,
              completed_at = statement_timestamp(),
              completed_by_membership_id = $4
        where household_id = $1 and routine_id = $2 and due_on = $3
          and voided_at is not null`,
      [householdId, payload.routineId, payload.dueOn, membership.id],
    );
    if ((revived.rowCount ?? 0) === 0) {
      // La RLS no devolvió fila: o alguien la revivió entre medias (y entonces
      // ya está completada) o el actor no puede escribirla.
      throw new CommandRejectedError("already_completed", "La ocurrencia ya está completada");
    }
  } else {
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
  }

  // El calendario NO se mueve al marcar: las ocurrencias se generan desde el
  // ancla, así que lo único que hay que refrescar es la caché. Se recalcula
  // desde la regla y TODAS las finalizaciones vivas, no desde la ocurrencia que
  // acaba de entrar: así marcar tarde deja de empujar la serie un intervalo
  // por toque (la cinta de correr de §2.9) y completar una atrasada limpia la
  // atrasada en vez de inventarse una fecha.
  await refreshDueHint(client, householdId, routine, schedule);

  return { resourceId: routine.id };
}

/**
 * Deshacer un marcado hecho por error (E5.1). No es una operación de auditoría
 * con motivo: es la salida de un toque accidental, y por eso no pide nada más
 * que qué ocurrencia era.
 *
 * Tres cosas que este comando hace y conviene no confundir:
 *
 *   · NO BORRA. Anota la anulación con su autoría (`voided_at`,
 *     `voided_by_membership_id`) y la finalización deja de contar. El historial
 *     de E2 sigue pudiendo enseñar que alguien la marcó y quién la deshizo.
 *   · RESTAURA la fecha, no la recalcula. `refreshDueHint` vuelve a preguntar a
 *     `pendingFor` con el conjunto de finalizaciones vivas SIN la anulada, que
 *     es exactamente el conjunto que había antes de marcar; el resultado es,
 *     por construcción, la fecha que la rutina tenía.
 *   · NO decide quién puede. Eso lo decide la política `routine_completions_void`
 *     de la 0031: su autor o `family_admin`. Aquí solo se traduce «la RLS no me
 *     dejó tocar la fila» a un rechazo con nombre, porque un `UPDATE` que no
 *     afecta filas no distingue solo por sí mismo entre «no existe» y «no es
 *     tuya».
 */
async function uncompleteRoutine(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: RoutineOccurrencePayload,
): Promise<{ resourceId: UUID }> {
  const routine = await loadRoutineSchedule(client, householdId, payload.routineId);
  const schedule = scheduleFromRow(routine);

  const existing = await client.query<{ voided: boolean; mine: boolean }>(
    `select voided_at is not null as voided,
            completed_by_membership_id = $4 as mine
       from app.routine_completions
      where household_id = $1 and routine_id = $2 and due_on = $3`,
    [householdId, payload.routineId, payload.dueOn, membership.id],
  );
  const previous = existing.rows[0];
  if (!previous) {
    throw new CommandRejectedError(
      "completion_not_found",
      "Esa ocurrencia no está marcada como hecha",
    );
  }
  // Deshacer dos veces es un no-op idempotente y no un error: el segundo toque
  // suele ser el mismo dedo, o un envelope que la cola sin conexión reintenta.
  if (previous.voided) return { resourceId: routine.id };
  if (!previous.mine && membership.role !== "family_admin") {
    throw new CommandRejectedError(
      "not_allowed",
      "Solo quien marcó la rutina, o la administración, puede deshacerlo",
    );
  }

  const voided = await client.query(
    `update app.routine_completions
        set voided_at = statement_timestamp(),
            voided_by_membership_id = $4
      where household_id = $1 and routine_id = $2 and due_on = $3
        and voided_at is null`,
    [householdId, payload.routineId, payload.dueOn, membership.id],
  );
  if ((voided.rowCount ?? 0) === 0) {
    throw new CommandRejectedError(
      "not_allowed",
      "Solo quien marcó la rutina, o la administración, puede deshacerlo",
    );
  }

  // La rutina vuelve a estar pendiente para el día que le tocaba: la caché se
  // recalcula desde la regla y las finalizaciones VIVAS, que sin la anulada son
  // exactamente las que había antes de marcar.
  await refreshDueHint(client, householdId, routine, schedule);

  return { resourceId: routine.id };
}

/**
 * `routine`: alta/edición (solo familia) y finalización por ocurrencia (según
 * audiencia, que hace cumplir la RLS).
 *
 * El alta acepta UNA sola forma del contrato: la cadencia rica de la 0023. La
 * de antes del despliegue se aceptaba y se traducía durante la ventana de esa
 * migración; la 0033 la retira (§3.5).
 *
 * Completar ya no avanza nada: refresca la caché `next_due_hint` recalculada
 * desde la regla con `pendingFor`, y encola el aviso de la siguiente si cambió.
 * Deshacer (E5.1) hace el mismo cálculo sin la finalización anulada, de modo
 * que la rutina recupera la fecha que tenía en vez de estrenar una.
 */
export const routineCommandHandler: CommandHandler = async (client, membership, envelope) => {
  const action = (envelope.payload as { action?: unknown } | null | undefined)?.action;
  if (action === "upsert") {
    const parsed = routineUpsertPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      // Un envelope con la forma ANTIGUA que llegue tarde no se traduce ni se
      // deja morir en un «falta pattern» que no explicaría nada. Se reconoce y
      // se rechaza por su nombre: es lo único honesto que queda por hacer con
      // él. Rechazado —y no `transient` ni `internal`— a propósito: el cliente
      // debe dejar de reintentarlo y enseñárselo a quien lo escribió, porque
      // ningún reintento va a arreglarlo. El texto de la rutina y su fecha
      // siguen en el dispositivo, en el registro parado del outbox, así que
      // volver a darla de alta con la app al día es copiar dos campos.
      if (retiredRoutineUpsertPayloadSchema.safeParse(envelope.payload).success) {
        throw new CommandRejectedError(
          "routine_cadence_format_retired",
          "Esa rutina se guardó con el formato de cadencia anterior, que la casa ya no admite: vuelve a darla de alta",
        );
      }
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
  if (action === "uncomplete") {
    const parsed = routineUncompletePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
    }
    return uncompleteRoutine(client, membership, envelope.householdId, parsed.data);
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
