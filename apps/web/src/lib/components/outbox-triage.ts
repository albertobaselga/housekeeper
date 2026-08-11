import type { CommandEnvelopeV1 } from '@casa-clara/contracts';

import { describeEmploymentCommand, describeErrorCode as describeEmploymentErrorCode, EMPLOYMENT_AGGREGATES } from '$lib/employment/outbox';
import type { OutboxRecord } from '$lib/offline/schema';

/**
 * Triaje GENÉRICO del outbox (UX-P1-2/H-03): descripciones humanas para
 * cualquier agregado —no solo los laborales— de los registros conflict/rejected
 * que exigen decisión humana (reintentar con operationId nuevo o descartar).
 * Los agregados del expediente laboral delegan en el descriptor de
 * $lib/employment/outbox para no duplicar sus textos.
 */

/** Registros que la sección «Cambios sin sincronizar» debe listar: todos los que ya no van a fluir solos. */
export function triageableRecords(records: readonly OutboxRecord[]): OutboxRecord[] {
  return records.filter((record) => record.status !== 'pending');
}

function payloadField(envelope: CommandEnvelopeV1, field: string): string | null {
  const payload = envelope.payload;
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
  }
  return null;
}

/**
 * Descripción humana por aggregateType + action. Nunca lanza: un comando
 * desconocido degrada a una etiqueta genérica.
 */
export function describeCommand(envelope: CommandEnvelopeV1): string {
  if ((EMPLOYMENT_AGGREGATES as readonly string[]).includes(envelope.aggregateType)) {
    return describeEmploymentCommand(envelope);
  }
  const action = payloadField(envelope, 'action');
  switch (envelope.aggregateType) {
    case 'food': {
      const name = payloadField(envelope, 'name');
      return name ? `Alimento «${name}» del catálogo` : 'Alimento del catálogo';
    }
    case 'diner': {
      const name = payloadField(envelope, 'name');
      return name ? `Comensal «${name}» y sus restricciones` : 'Comensal y sus restricciones';
    }
    case 'recipe':
      return 'Ficha de receta (raciones e ingredientes)';
    case 'menu_group': {
      const name = payloadField(envelope, 'name');
      return name ? `Grupo de menú «${name}»` : 'Grupo de menú';
    }
    case 'menu_slot':
      switch (action) {
        case 'set': {
          const onDate = payloadField(envelope, 'onDate');
          const meal = payloadField(envelope, 'meal');
          return onDate && meal ? `Comida del menú (${meal} del ${onDate})` : 'Comida del menú';
        }
        case 'set_new_recipe': {
          const title = payloadField(envelope, 'recipeTitle');
          return title ? `Receta nueva «${title}» asignada al menú` : 'Receta nueva asignada al menú';
        }
        case 'clear':
          return 'Comida del menú vaciada';
        case 'duplicate_week':
          return 'Duplicado de la semana del menú';
        case 'confirm':
          return 'Confirmación de una comida del menú';
        default:
          return 'Cambio en el menú';
      }
    case 'menu_template':
      switch (action) {
        case 'save':
          return 'Semana guardada como plantilla';
        case 'apply':
          return 'Plantilla de semana aplicada al menú';
        case 'delete':
          return 'Borrado de una plantilla de semana';
        default:
          return 'Plantilla de semana del menú';
      }
    case 'shopping_item':
      return action === 'set_checked'
        ? 'Artículo de la compra marcado'
        : 'Añadido a la lista de la compra';
    case 'routine':
      switch (action) {
        case 'complete':
          return 'Rutina marcada como hecha';
        case 'uncomplete':
          return 'Marcado de rutina deshecho';
        default:
          return 'Rutina creada o editada';
      }
    case 'routine_occurrence':
      // Comando heredado de la maqueta: el servidor no lo implementa.
      return 'Marca de tarea de demostración (no se guarda en la casa)';
    case 'wiki_space':
      switch (action) {
        case 'set_template':
          return 'Apartado de la guía usado como modelo';
        case 'clone_template':
          return 'Apartado creado desde un modelo';
        default:
          return 'Apartado de la guía de la casa';
      }
    case 'wiki_page':
      switch (action) {
        case 'create':
          return 'Nota nueva en la guía de la casa';
        case 'edit':
          return 'Edición de una nota de la guía';
        case 'set_state':
          return 'Cambio de estado de una nota de la guía';
        default:
          return 'Cambio en la guía de la casa';
      }
    case 'membership':
      return action === 'revoke' ? 'Retirada de un acceso' : 'Fecha límite de un acceso';
    default:
      return 'Cambio pendiente';
  }
}

const GENERIC_ERROR_LABELS: Record<string, string> = {
  unsupported_aggregate: 'La aplicación no reconoce este tipo de cambio',
  not_authorized: 'Tu acceso a este hogar no lo permite',
  wiki_revision_conflict: 'Otra persona guardó la nota antes que tú',
  menu_content_changed: 'Esa comida del menú cambió desde tu confirmación',
  allergen_conflict: 'La receta choca con una restricción del grupo',
  food_unreviewed: 'La receta usa un alimento sin revisar',
  already_completed: 'La rutina ya estaba marcada',
  routine_not_found: 'La rutina ya no existe',
  // `completion_not_found`, `routine_has_no_schedule` y `not_allowed` NO se
  // repiten aquí: viven en el diccionario compartido (offline/error-codes.ts),
  // al que este descriptor cae por defecto. Duplicarlos dejaría dos frases para
  // el mismo código, y la de aquí ganaría también para agregados que no son
  // rutinas.
  slot_not_found: 'Esa comida del menú ya no existe',
  item_not_found: 'El artículo de la compra ya no existe',
  page_not_found: 'La nota de la guía ya no existe',
  space_not_found: 'El apartado de la guía ya no existe',
  membership_not_found: 'El acceso ya no existe',
  already_revoked: 'El acceso ya estaba revocado',
  expiry_in_past: 'La fecha límite quedaba en el pasado',
  cannot_modify_self: 'No puedes cambiar tu propio acceso',
  operation_conflict: 'Otro cambio llegó antes con otro contenido',
  constraint_violation: 'El cambio no encaja con lo que ya hay guardado'
};

/**
 * ¿Este registro está parado por su foto pendiente, y no por el comando? El
 * triaje cambia entonces el copy y el significado de los botones: reintentar
 * vuelve a intentar la SUBIDA (la foto sigue en el dispositivo) y descartar
 * borra el cambio junto con la foto. Los códigos los pone el propio
 * dispositivo en blob-link.ts; el servidor nunca llegó a ver el comando.
 */
export function isBlockedByAttachment(record: OutboxRecord): boolean {
  const code = record.lastErrorCode;
  return (
    Boolean(record.pendingBlob) &&
    (code === 'attachment_rejected' || code === 'attachment_upload_blocked')
  );
}

/** Etiqueta humana del código de error del servidor (laborales incluidos); conserva el código si es desconocido. */
export function describeError(code: string | undefined): string | null {
  if (!code) return null;
  return GENERIC_ERROR_LABELS[code] ?? describeEmploymentErrorCode(code);
}

/**
 * Copia del envelope lista para reintentar: MISMOS hechos, operationId NUEVO
 * (el original ya fue consumido por el servidor con conflict/rejected).
 */
export function retryableEnvelope(
  envelope: CommandEnvelopeV1,
  operationId: string = crypto.randomUUID()
): CommandEnvelopeV1 {
  return { ...envelope, operationId };
}
