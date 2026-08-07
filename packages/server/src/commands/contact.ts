import type { UUID } from "@casa-clara/contracts";
import { contactCommandPayloadSchema } from "@casa-clara/contracts/schemas";

import { CommandRejectedError, type CommandHandler, type CommandHandlers } from "../sync.js";
import { requireFamilyRole } from "./food.js";

/**
 * `contact` — directorio real del hogar (P2-2 de la re-auditoría UX v2).
 * Payload CONGELADO en @casa-clara/contracts (contactCommandPayloadSchema):
 * upsert (alta/edición, familia) y archive (baja lógica, familia). La lectura
 * es de los cinco roles vía RLS; la escritura la limita este handler además de
 * la policy contacts_family_write de 0013_contacts.sql.
 */
export const contactCommandHandler: CommandHandler = async (client, membership, envelope) => {
  requireFamilyRole(membership.role, "los contactos del hogar");
  const parsed = contactCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  const householdId = envelope.householdId;

  if (payload.action === "archive") {
    const archived = await client.query<{ id: string }>(
      `update app.contacts
          set archived_at = statement_timestamp()
        where household_id = $1 and id = $2 and archived_at is null
        returning id`,
      [householdId, payload.contactId],
    );
    if (!archived.rows[0]) {
      throw new CommandRejectedError("contact_not_found", "El contacto no existe o ya está archivado");
    }
    return { resourceId: payload.contactId };
  }

  let contactId: UUID;
  if (payload.contactId !== undefined) {
    const updated = await client.query<{ id: string }>(
      `update app.contacts
          set name = $3, role_label = $4, phone = $5, kind = $6, featured = $7, notes = $8
        where household_id = $1 and id = $2 and archived_at is null
        returning id`,
      [
        householdId,
        payload.contactId,
        payload.name,
        payload.roleLabel ?? "",
        payload.phone,
        payload.kind,
        payload.featured,
        payload.notes ?? "",
      ],
    );
    const row = updated.rows[0];
    if (!row) {
      throw new CommandRejectedError("contact_not_found", "El contacto no existe en este hogar");
    }
    contactId = row.id;
  } else {
    const inserted = await client.query<{ id: string }>(
      `insert into app.contacts
         (household_id, name, role_label, phone, kind, featured, notes, position, created_by_membership_id)
       values ($1, $2, $3, $4, $5, $6, $7,
               coalesce((select max(position) + 1 from app.contacts where household_id = $1), 0),
               $8)
       returning id`,
      [
        householdId,
        payload.name,
        payload.roleLabel ?? "",
        payload.phone,
        payload.kind,
        payload.featured,
        payload.notes ?? "",
        membership.id,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("La inserción del contacto no devolvió identificador");
    contactId = row.id;
  }
  return { resourceId: contactId };
};

/** Handler de contactos listo para `processSyncBatch` (spread en la ruta de sync). */
export const contactCommandHandlers: CommandHandlers = {
  contact: contactCommandHandler,
};
