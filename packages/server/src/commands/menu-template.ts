import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import { menuTemplateCommandPayloadSchema } from "@casa-clara/contracts/schemas";

import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler } from "../sync.js";
import { requireFamilyRole } from "./food.js";

/**
 * Semanas de menú plantilla con nombre («Semana de cole», «Semana de
 * verano»): `save` captura el snapshot normalizado de una semana existente,
 * `apply` lo vuelca sobre una semana VACÍA y `delete` la retira. Todo
 * escritura de familia (RLS lo respalda; aquí se rechaza antes con
 * `not_allowed`).
 */

async function saveTemplate(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: { name: string; fromWeekStartsOn: string },
): Promise<{ resourceId: UUID }> {
  const clash = await client.query(
    `select 1 from app.menu_week_templates
      where household_id = $1 and lower(name) = lower($2)`,
    [householdId, payload.name],
  );
  if ((clash.rowCount ?? 0) > 0) {
    throw new CommandRejectedError(
      "template_name_taken",
      `Ya hay una plantilla llamada «${payload.name}» en este hogar`,
    );
  }

  // Snapshot de la semana origen con el título vigente de cada receta: si la
  // receta desaparece después, `apply` degrada el hueco a texto con ese título.
  const slots = await client.query<{
    group_id: string;
    day_offset: number;
    meal: string;
    recipe_page_id: string | null;
    recipe_title: string;
    free_text: string;
    notes: string;
    servings_override: number | null;
  }>(
    `select slot.group_id,
            (slot.on_date - $2::date)::int as day_offset,
            slot.meal::text as meal,
            slot.recipe_page_id,
            coalesce(revision.title, '') as recipe_title,
            slot.free_text, slot.notes, slot.servings_override
       from app.menu_slots as slot
       left join app.wiki_pages as page
         on page.household_id = slot.household_id and page.id = slot.recipe_page_id
       left join app.wiki_revisions as revision
         on revision.household_id = page.household_id and revision.id = page.current_revision_id
      where slot.household_id = $1
        and slot.on_date >= $2::date and slot.on_date <= $2::date + 6`,
    [householdId, payload.fromWeekStartsOn],
  );
  if ((slots.rowCount ?? 0) === 0) {
    throw new CommandRejectedError(
      "menu_week_empty",
      "La semana elegida no tiene ningún hueco que guardar",
    );
  }

  const inserted = await client.query<{ id: string }>(
    `insert into app.menu_week_templates
       (household_id, name, source_week_starts_on, created_by_membership_id)
     values ($1, $2, $3, $4)
     returning id`,
    [householdId, payload.name, payload.fromWeekStartsOn, membership.id],
  );
  const template = inserted.rows[0];
  if (!template) throw new Error("La inserción de la plantilla no devolvió identificador");

  for (const slot of slots.rows) {
    await client.query(
      `insert into app.menu_week_template_slots
         (household_id, template_id, day_offset, meal, group_id, recipe_page_id,
          recipe_title, free_text, notes, servings_override)
       values ($1, $2, $3, $4::app.meal_slot, $5, $6, $7, $8, $9, $10)`,
      [
        householdId,
        template.id,
        slot.day_offset,
        slot.meal,
        slot.group_id,
        slot.recipe_page_id,
        slot.recipe_title,
        slot.free_text,
        slot.notes,
        slot.servings_override,
      ],
    );
  }
  return { resourceId: template.id };
}

/**
 * Vuelca la plantilla sobre el lunes destino. La semana destino debe estar
 * VACÍA: si ya tiene cualquier hueco se rechaza con `week_overlap`, la misma
 * familia de rechazo que protege el duplicado semanal (AC-23) — aquí no hay
 * semana origen que solapar, así que la condición equivalente es «no pisar
 * contenido existente».
 *
 * Degradación con gracia, nunca un error:
 *   · grupo archivado o borrado → sus huecos se saltan;
 *   · receta borrada (recipe_page_id NULL por SET NULL) o con página wiki
 *     archivada → el hueco se aplica como texto libre con el título capturado.
 */
async function applyTemplate(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: { templateId: UUID; toWeekStartsOn: string },
): Promise<{ resourceId: UUID }> {
  const template = await client.query(
    `select 1 from app.menu_week_templates
      where household_id = $1 and id = $2
      for update`,
    [householdId, payload.templateId],
  );
  if ((template.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("template_not_found", "La plantilla no existe en este hogar");
  }

  const occupied = await client.query(
    `select 1 from app.menu_slots
      where household_id = $1
        and on_date >= $2::date and on_date <= $2::date + 6
      limit 1`,
    [householdId, payload.toWeekStartsOn],
  );
  if ((occupied.rowCount ?? 0) > 0) {
    throw new CommandRejectedError(
      "week_overlap",
      "La semana destino ya tiene contenido; elige una semana vacía",
    );
  }

  const slots = await client.query<{
    day_offset: number;
    meal: string;
    group_id: string;
    recipe_page_id: string | null;
    recipe_title: string;
    free_text: string;
    notes: string;
    servings_override: number | null;
    recipe_alive: boolean;
  }>(
    `select slot.day_offset, slot.meal::text as meal, slot.group_id,
            slot.recipe_page_id, slot.recipe_title, slot.free_text, slot.notes,
            slot.servings_override,
            (slot.recipe_page_id is not null and page.id is not null
             and page.archived_at is null) as recipe_alive
       from app.menu_week_template_slots as slot
       join app.menu_groups as menu_group
         on menu_group.household_id = slot.household_id and menu_group.id = slot.group_id
        and menu_group.archived_at is null
       left join app.wiki_pages as page
         on page.household_id = slot.household_id and page.id = slot.recipe_page_id
      where slot.household_id = $1 and slot.template_id = $2
      order by slot.day_offset, slot.meal, slot.group_id`,
    [householdId, payload.templateId],
  );

  for (const slot of slots.rows) {
    const recipePageId = slot.recipe_alive ? slot.recipe_page_id : null;
    // La receta perdida se aplica como texto libre con el título capturado; un
    // hueco sin receta ni texto alguno no puede insertarse y se salta.
    const freeText =
      recipePageId !== null ? "" : slot.free_text.trim() || slot.recipe_title.trim();
    if (recipePageId === null && freeText.length === 0) continue;
    await client.query(
      `insert into app.menu_slots
         (household_id, group_id, on_date, meal, recipe_page_id, free_text, notes,
          servings_override, updated_by_membership_id)
       values ($1, $2, $3::date + $4::int, $5::app.meal_slot, $6, $7, $8, $9, $10)`,
      [
        householdId,
        slot.group_id,
        payload.toWeekStartsOn,
        slot.day_offset,
        slot.meal,
        recipePageId,
        freeText,
        slot.notes,
        slot.servings_override,
        membership.id,
      ],
    );
  }
  return { resourceId: payload.templateId };
}

async function deleteTemplate(
  client: PoolClient,
  householdId: UUID,
  templateId: UUID,
): Promise<{ resourceId: UUID }> {
  // Los huecos de la plantilla caen por ON DELETE CASCADE.
  const deleted = await client.query(
    `delete from app.menu_week_templates where household_id = $1 and id = $2 returning id`,
    [householdId, templateId],
  );
  if ((deleted.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("template_not_found", "La plantilla no existe en este hogar");
  }
  return { resourceId: templateId };
}

/** `menu_template` — save / apply / delete, solo familia. */
export const menuTemplateCommandHandler: CommandHandler = async (client, membership, envelope) => {
  requireFamilyRole(membership.role, "las plantillas del menú");
  const parsed = menuTemplateCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  const householdId = envelope.householdId;

  switch (payload.action) {
    case "save":
      return saveTemplate(client, membership, householdId, payload);
    case "apply":
      return applyTemplate(client, membership, householdId, payload);
    case "delete":
      return deleteTemplate(client, householdId, payload.templateId);
  }
};
