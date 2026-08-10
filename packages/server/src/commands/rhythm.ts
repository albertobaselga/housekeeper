import { createHash, randomBytes } from "node:crypto";

import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import {
  icsFeedCommandPayloadSchema,
  routineCompletePayloadSchema,
  routineUpsertPayloadSchema,
} from "@casa-clara/contracts/schemas";

import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler, type CommandHandlers } from "../sync.js";
import { addDays } from "./shared.js";

export const ROUTINE_DUE_JOB = "notification.routine_due";
export const ICS_SYNC_JOB = "ics.sync_source";

type RoutineAudience = "family" | "employee" | "all";
type RoutineFrequency = "daily" | "weekly" | "monthly" | "quarterly";

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

/** Suma meses en UTC con la convención de calendario: el día se recorta al último del mes destino (31/01 + 1 mes → 28/02). */
function addMonthsClamped(isoDate: string, months: number): string {
  const year = Number(isoDate.slice(0, 4));
  const monthIndex = Number(isoDate.slice(5, 7)) - 1;
  const day = Number(isoDate.slice(8, 10));
  const total = monthIndex + months;
  const targetYear = year + Math.floor(total / 12);
  const targetMonth = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

/** Próxima ocurrencia a partir de la actual según frecuencia e intervalo. */
export function advanceDueDate(
  isoDate: string,
  frequency: RoutineFrequency,
  intervalCount: number,
): string {
  switch (frequency) {
    case "daily":
      return addDays(isoDate, intervalCount);
    case "weekly":
      return addDays(isoDate, 7 * intervalCount);
    case "monthly":
      return addMonthsClamped(isoDate, intervalCount);
    case "quarterly":
      return addMonthsClamped(isoDate, 3 * intervalCount);
  }
}

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

/**
 * Encola el aviso de una ocurrencia para la mañana de su fecha de vencimiento.
 *
 * `app.job_run_at` (migración 0027) traduce la fecha civil al instante real en
 * la zona del hogar. Antes se usaba `::date::timestamptz`, que resuelve la
 * medianoche en la zona de la SESIÓN: con el servidor en UTC el aviso salía a
 * las 02:00 de la madrugada de Madrid.
 */
async function enqueueRoutineDue(
  client: PoolClient,
  householdId: UUID,
  routine: { id: UUID; title: string; audience: RoutineAudience },
  dueOn: string,
): Promise<void> {
  const recipients = await resolveAudienceRecipients(client, householdId, routine.audience);
  await client.query(
    `select app.enqueue_job($1, $2::jsonb, greatest(app.job_run_at($3::date), statement_timestamp()))`,
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

interface RoutineUpsertPayload {
  routineId?: UUID | undefined;
  title: string;
  details?: string | undefined;
  audience: RoutineAudience;
  frequency: RoutineFrequency;
  intervalCount: number;
  nextDueOn: string;
}

async function upsertRoutine(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: RoutineUpsertPayload,
): Promise<{ resourceId: UUID }> {
  requireFamilyRole(membership);

  if (payload.routineId) {
    const updated = await client.query<{ id: string }>(
      `update app.routines
          set title = $3, details = $4, audience = $5::app.routine_audience,
              frequency = $6::app.routine_frequency, interval_count = $7, next_due_on = $8
        where household_id = $1 and id = $2 and archived_at is null
        returning id`,
      [
        householdId,
        payload.routineId,
        payload.title,
        payload.details ?? "",
        payload.audience,
        payload.frequency,
        payload.intervalCount,
        payload.nextDueOn,
      ],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new CommandRejectedError("routine_not_found", "La rutina no existe o está archivada");
    }
    return { resourceId: payload.routineId };
  }

  const inserted = await client.query<{ id: string }>(
    `insert into app.routines
       (household_id, title, details, audience, frequency, interval_count, next_due_on,
        created_by_membership_id)
     values ($1, $2, $3, $4::app.routine_audience, $5::app.routine_frequency, $6, $7, $8)
     returning id`,
    [
      householdId,
      payload.title,
      payload.details ?? "",
      payload.audience,
      payload.frequency,
      payload.intervalCount,
      payload.nextDueOn,
      membership.id,
    ],
  );
  const routineId = inserted.rows[0]?.id;
  if (!routineId) throw new Error("La inserción de la rutina no devolvió identificador");

  // Primer aviso de la rutina recién creada, para su primera ocurrencia.
  await enqueueRoutineDue(
    client,
    householdId,
    { id: routineId, title: payload.title, audience: payload.audience },
    payload.nextDueOn,
  );
  return { resourceId: routineId };
}

interface RoutineCompletePayload {
  routineId: UUID;
  dueOn: string;
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
    frequency: RoutineFrequency;
    interval_count: number;
    next_due_on: string;
    archived: boolean;
  }>(
    `select id, title, audience::text as audience, frequency::text as frequency,
            interval_count, next_due_on::text as next_due_on,
            archived_at is not null as archived
       from app.routines
      where household_id = $1 and id = $2`,
    [householdId, payload.routineId],
  );
  const routine = loaded.rows[0];
  if (!routine || routine.archived) {
    throw new CommandRejectedError("routine_not_found", "La rutina no existe o no es visible");
  }

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

  // Completar la ocurrencia vigente avanza la recurrencia y deja encolado el
  // aviso de la siguiente. La escritura de app.routines es solo familiar por
  // RLS, pero la función definer de la 0009 permite el avance también cuando
  // completan la empleada o el apoyo (exige contexto y la finalización recién
  // registrada del propio hogar).
  if (payload.dueOn === routine.next_due_on) {
    const advanced = await client.query<{ next_due_on: string | null }>(
      "select app.advance_routine_after_completion($1, $2)::text as next_due_on",
      [payload.routineId, payload.dueOn],
    );
    const nextDueOn = advanced.rows[0]?.next_due_on;
    if (nextDueOn) {
      await enqueueRoutineDue(
        client,
        householdId,
        { id: routine.id, title: routine.title, audience: routine.audience },
        nextDueOn,
      );
    }
  }

  return { resourceId: routine.id };
}

/**
 * `routine`: alta/edición (solo familia) y finalización por ocurrencia (según
 * audiencia, que hace cumplir la RLS). Completar la ocurrencia vigente avanza
 * `next_due_on` y encola `notification.routine_due` para la siguiente.
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
