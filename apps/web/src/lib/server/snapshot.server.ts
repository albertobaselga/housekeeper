import type { Pool } from 'pg';

import { API_VERSION, CRITICAL_SNAPSHOT_TTL_MS, type CriticalSnapshotV1 } from '@casa-clara/contracts';
import {
  canonicalSha256,
  computeMenuSlotHash,
  createLogger,
  signCriticalSnapshot,
  withAuthorizedTransaction
} from '@casa-clara/server';

import { pendingFor, PENDING_LOOKBACK_DAYS } from '@casa-clara/domain';

import { dateLabel } from '$lib/employment/model';
import type { MealSlot } from '$lib/food/commands';
import { addDays } from '$lib/food/dates';

import type { SnapshotContact } from './contacts.server';
import { fixturesAllowed, unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';
import {
  ROUTINE_RULE_COLUMNS,
  routineScheduleFrom,
  type RoutineRuleRow
} from './routine-rules.server';
import {
  getCriticalSnapshotPayload,
  type SnapshotHouseholdData,
  type SnapshotMenuSlot,
  type SnapshotRoutine,
  type SnapshotWikiPage
} from './fixtures.server';
import { getSnapshotKeys } from './keys.server';
import { MEAL_LABELS, headerDateLabel } from './today.server';

const log = createLogger('web:snapshot');

const MADRID_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });

/** Tope de notas fijadas que viajan enteras: el snapshot va firmado y cabe en IndexedDB. */
const PINNED_PAGE_LIMIT = 12;

/**
 * Datos REALES del hogar que van dentro del snapshot crítico: el menú de hoy
 * con su estado de confirmación, las rutinas que vencen hoy o antes y las
 * notas FIJADAS y publicadas de la Guía con su contenido entero (para poder
 * leerlas sin conexión). Todo en UNA withAuthorizedTransaction: es la base de
 * datos quien decide qué filas ve cada rol, así que el paquete offline de una
 * empleada nunca lleva lo que su rol no puede ver.
 *
 * Devuelve null solo sin pool (demo sin DATABASE_URL) o sin membresía: el
 * snapshot conserva entonces la fixture de demostración.
 */
export async function loadSnapshotHousehold(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  now: Date = new Date()
): Promise<SnapshotHouseholdData | null> {
  if (!pool) return null;
  const todayISO = MADRID_DATE.format(now);
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const slotResult = await client.query<{
        id: string;
        meal: MealSlot;
        groupName: string;
        freeText: string;
        recipeTitle: string | null;
        confirmedHash: string | null;
      }>(
        `select slot.id,
                slot.meal::text as "meal",
                menu_group.name as "groupName",
                slot.free_text as "freeText",
                coalesce(revision.title, page.current_slug) as "recipeTitle",
                confirmation.content_hash as "confirmedHash"
           from app.menu_slots as slot
           join app.menu_groups as menu_group
             on menu_group.household_id = slot.household_id and menu_group.id = slot.group_id
           left join app.wiki_pages as page
             on page.household_id = slot.household_id and page.id = slot.recipe_page_id
           left join app.wiki_revisions as revision
             on revision.household_id = page.household_id and revision.id = page.current_revision_id
           left join app.menu_confirmations as confirmation
             on confirmation.household_id = slot.household_id and confirmation.slot_id = slot.id
          where slot.household_id = $1 and slot.on_date = $2
          order by menu_group.name, slot.meal`,
        [householdId, todayISO]
      );

      const menu: SnapshotMenuSlot[] = [];
      for (const slot of slotResult.rows) {
        const dish = slot.recipeTitle ?? slot.freeText;
        if (!dish) continue;
        const contentHash = await computeMenuSlotHash(client, householdId, slot.id);
        menu.push({
          id: slot.id,
          mealLabel: MEAL_LABELS[slot.meal] ?? slot.meal,
          groupName: slot.groupName,
          dish,
          confirmed: Boolean(contentHash && slot.confirmedHash === contentHash)
        });
      }

      // El snapshot sigue llevando OCURRENCIAS ya resueltas, no reglas (§5.3):
      // la página sin conexión no debería tener que expandir nada. Lo que
      // cambia es de dónde salen: del generador y no de una columna, y con
      // `dueOn` explícito, que es lo que permite encolar la finalización
      // correcta desde el dispositivo sin adivinar qué ocurrencia era.
      const routineResult = await client.query<
        RoutineRuleRow & { id: string; title: string; details: string }
      >(
        `select routine.id,
                routine.title,
                routine.details,
                ${ROUTINE_RULE_COLUMNS}
           from app.routines as routine
          where routine.household_id = $1
            and routine.archived_at is null
            and routine.pattern is not null
            and routine.next_due_hint <= $2::date
          order by routine.title`,
        [householdId, todayISO]
      );
      const completionResult = await client.query<{ routineId: string; dueOn: string }>(
        `select completion.routine_id as "routineId", completion.due_on::text as "dueOn"
           from app.routine_completions as completion
          where completion.household_id = $1
            and completion.voided_at is null
            and completion.due_on >= $2::date`,
        [householdId, addDays(todayISO, -PENDING_LOOKBACK_DAYS)]
      );
      const completedByRoutine = new Map<string, Set<string>>();
      for (const row of completionResult.rows) {
        const set = completedByRoutine.get(row.routineId) ?? new Set<string>();
        set.add(row.dueOn);
        completedByRoutine.set(row.routineId, set);
      }

      const routines: SnapshotRoutine[] = [];
      for (const row of routineResult.rows) {
        const schedule = routineScheduleFrom(row);
        if (!schedule) continue;
        const completed = completedByRoutine.get(row.id) ?? new Set<string>();
        const pending = pendingFor(schedule, row.overduePolicy, completed, todayISO);
        // Una fila por rutina: la atrasada manda sobre la de hoy porque es la
        // que se pierde si no se dice. Con `skip` no hay atrasadas y una semana
        // de vacaciones deja de generar siete líneas «Vencía el…».
        const dueOn = pending.overdue ?? pending.due[0] ?? null;
        if (!dueOn) continue;
        routines.push({
          id: row.id,
          title: row.title,
          details: row.details,
          dueOn,
          dueLabel: dueOn === todayISO ? 'Hoy' : `Tocaba el ${dateLabel(dueOn)}`,
          overdue: dueOn < todayISO,
          done: false
        });
      }

      // Solo las notas FIJADAS y publicadas de espacios vivos: son las que la
      // casa ha marcado como imprescindibles y las únicas que merecen viajar
      // con el cuerpo entero.
      const pageResult = await client.query<{ id: string; title: string; space: string; body: string }>(
        `select page.id,
                coalesce(revision.title, page.current_slug) as "title",
                space.name as "space",
                coalesce(revision.body_markdown, '') as "body"
           from app.wiki_pages as page
           join app.wiki_spaces as space
             on space.household_id = page.household_id and space.id = page.space_id
           left join app.wiki_revisions as revision
             on revision.household_id = page.household_id and revision.id = page.current_revision_id
          where page.household_id = $1
            and page.archived_at is null
            and page.pinned
            and page.status = 'published'
            and space.archived_at is null
            and space.is_template = false
          order by space.position, page.position, "title"
          limit ${PINNED_PAGE_LIMIT}`,
        [householdId]
      );
      const wikiPages: SnapshotWikiPage[] = pageResult.rows.map((row) => ({ ...row }));

      return {
        today: { dateISO: todayISO, dateLabel: headerDateLabel(todayISO), menu, routines },
        wikiPages
      } satisfies SnapshotHouseholdData;
    });
  } catch (cause) {
    return unreadable(log, 'snapshot household', cause);
  }
}

/**
 * Construye y firma el snapshot crítico del contrato. Con datos reales
 * (`realContacts` de app.contacts y `realHousehold` de loadSnapshotHousehold,
 * ambos bajo RLS) el paquete offline lleva contactos, menú del día, rutinas
 * que vencen y notas fijadas de la Guía del hogar.
 *
 * La marca de procedencia va en `version` y es la que el dispositivo lee para
 * saber de qué se puede fiar:
 *
 * - `live-…`   contenido real del hogar.
 * - `partial-…` hay hogar real pero no se pudo leer: solo el 112.
 * - `fixture-…` demostración sin base de datos.
 *
 * La envolvente (etag, caducidad de 24 h y firma Ed25519) es real en los tres
 * casos, y por eso mismo la marca importa: una firma válida sobre datos
 * inventados es peor que no tener paquete.
 */
export function buildCriticalSnapshot(
  householdId: string,
  membershipId: string,
  realContacts?: SnapshotContact[] | null,
  realHousehold?: SnapshotHouseholdData | null
): CriticalSnapshotV1 {
  const payload = getCriticalSnapshotPayload(realContacts ?? null, realHousehold ?? null);
  const etag = canonicalSha256(payload);
  const generatedAt = new Date();
  const expiresAt = new Date(generatedAt.getTime() + CRITICAL_SNAPSHOT_TTL_MS);
  const provenance = realContacts ? 'live' : fixturesAllowed() ? 'fixture' : 'partial';
  return signCriticalSnapshot(
    {
      apiVersion: API_VERSION,
      schemaVersion: 1,
      householdId,
      membershipId,
      version: `${provenance}-${etag.slice(0, 12)}`,
      etag,
      cursor: generatedAt.toISOString(),
      generatedAt: generatedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      payload
    },
    getSnapshotKeys().privateKeyPem
  );
}
