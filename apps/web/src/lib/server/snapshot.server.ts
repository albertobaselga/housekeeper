import type { Pool } from 'pg';

import { API_VERSION, CRITICAL_SNAPSHOT_TTL_MS, type CriticalSnapshotV1 } from '@casa-clara/contracts';
import {
  canonicalSha256,
  computeMenuSlotHash,
  createLogger,
  signCriticalSnapshot,
  withAuthorizedTransaction
} from '@casa-clara/server';

import { dateLabel } from '$lib/employment/model';
import type { MealSlot } from '$lib/food/commands';

import type { SnapshotContact } from './contacts.server';
import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';
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

      const routineResult = await client.query<{
        id: string;
        title: string;
        details: string;
        nextDueOn: string;
        completedCurrent: boolean;
      }>(
        `select routine.id,
                routine.title,
                routine.details,
                routine.next_due_on::text as "nextDueOn",
                exists (
                  select 1 from app.routine_completions as completion
                   where completion.household_id = routine.household_id
                     and completion.routine_id = routine.id
                     and completion.due_on = routine.next_due_on
                ) as "completedCurrent"
           from app.routines as routine
          where routine.household_id = $1
            and routine.archived_at is null
            and routine.next_due_on <= $2
          order by routine.next_due_on, routine.title`,
        [householdId, todayISO]
      );
      const routines: SnapshotRoutine[] = routineResult.rows.map((row) => ({
        id: row.id,
        title: row.title,
        details: row.details,
        dueLabel: row.nextDueOn === todayISO ? 'Hoy' : `Vencía el ${dateLabel(row.nextDueOn)}`,
        overdue: row.nextDueOn < todayISO,
        done: row.completedCurrent
      }));

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
 * ambos bajo RLS) el paquete offline deja de servir fixtures: contactos, menú
 * del día, rutinas que vencen y notas fijadas de la Guía son los del hogar.
 * Sin pool (demo) el contenido sigue siendo la fixture sintética; la
 * envolvente (versión, etag, caducidad de 24 h y firma Ed25519) es real en
 * ambos casos.
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
  return signCriticalSnapshot(
    {
      apiVersion: API_VERSION,
      schemaVersion: 1,
      householdId,
      membershipId,
      version: `${realContacts ? 'live' : 'fixture'}-${etag.slice(0, 12)}`,
      etag,
      cursor: generatedAt.toISOString(),
      generatedAt: generatedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      payload
    },
    getSnapshotKeys().privateKeyPem
  );
}
