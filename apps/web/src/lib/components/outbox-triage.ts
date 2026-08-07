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
          return onDate && meal ? `Hueco del menú (${meal} del ${onDate})` : 'Hueco del menú';
        }
        case 'clear':
          return 'Vaciado de un hueco del menú';
        case 'duplicate_week':
          return 'Duplicado de la semana del menú';
        case 'confirm':
          return 'Confirmación de un hueco del menú';
        default:
          return 'Cambio en el menú';
      }
    case 'shopping_item':
      return action === 'set_checked'
        ? 'Artículo de la compra marcado'
        : 'Añadido a la lista de la compra';
    case 'routine':
      return action === 'complete' ? 'Rutina marcada como hecha' : 'Rutina creada o editada';
    case 'routine_occurrence':
      // Comando heredado de la maqueta: el servidor no lo implementa.
      return 'Marca de tarea de demostración (sin efecto en el servidor)';
    case 'wiki_space':
      switch (action) {
        case 'set_template':
          return 'Plantilla de un espacio de la wiki';
        case 'clone_template':
          return 'Página clonada desde plantilla';
        default:
          return 'Espacio de la wiki';
      }
    case 'wiki_page':
      switch (action) {
        case 'create':
          return 'Página nueva de la wiki';
        case 'edit':
          return 'Edición de una página de la wiki';
        case 'set_state':
          return 'Cambio de estado de una página de la wiki';
        default:
          return 'Cambio en la wiki';
      }
    case 'membership':
      return action === 'revoke' ? 'Revocación de un acceso' : 'Caducidad de un acceso';
    default:
      return 'Cambio pendiente';
  }
}

const GENERIC_ERROR_LABELS: Record<string, string> = {
  unsupported_aggregate: 'El servidor no reconoce este tipo de cambio',
  not_authorized: 'Tu acceso a este hogar no lo permite',
  wiki_revision_conflict: 'Otra persona editó la página antes',
  menu_content_changed: 'El contenido del hueco cambió desde tu confirmación',
  allergen_conflict: 'La receta choca con una restricción del grupo',
  food_unreviewed: 'La receta usa un alimento sin revisar',
  already_completed: 'La rutina ya estaba marcada',
  routine_not_found: 'La rutina ya no existe',
  slot_not_found: 'El hueco del menú ya no existe',
  item_not_found: 'El artículo de la compra ya no existe',
  page_not_found: 'La página de la wiki ya no existe',
  space_not_found: 'El espacio de la wiki ya no existe',
  membership_not_found: 'El acceso ya no existe',
  already_revoked: 'El acceso ya estaba revocado',
  expiry_in_past: 'La caducidad quedaba en el pasado',
  cannot_modify_self: 'No puedes cambiar tu propio acceso',
  operation_conflict: 'Otra operación llegó antes con otro contenido',
  constraint_violation: 'El servidor no pudo aplicar el cambio'
};

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
