/**
 * Diccionario COMPARTIDO de códigos de error del ACK de /api/v1/sync.
 *
 * Única fuente de verdad para traducir `errorCode` a lenguaje humano: lo usan
 * el `queueCommand` unificado (feedback inmediato de la acción), el triaje del
 * outbox y cualquier página que muestre el motivo de un rejected/conflict.
 * `lib/employment/outbox.ts` reexporta `describeErrorCode` para no romper los
 * imports históricos.
 */

const ERROR_CODE_LABELS: Record<string, string> = {
  // Genéricos del dispatcher
  invalid_payload: 'El servidor rechazó el contenido',
  not_allowed: 'Tu rol no permite esta acción',
  unsupported_aggregate: 'El servidor no reconoce este tipo de cambio',

  // Expediente laboral
  week_already_reported: 'La semana ya fue enviada',
  week_overlap: 'La semana se solapa con otra ya registrada',
  agreement_not_found: 'El acuerdo no existe o no es visible',
  extra_work_not_found: 'La jornada extra ya no existe',
  extra_work_not_requested: 'La jornada ya no admite aceptación',
  extra_work_not_performable: 'La jornada ya no admite marcarse como realizada',
  extra_work_not_resolvable: 'La jornada ya no admite resolución',
  extra_work_not_dismissible: 'La jornada ya no admite descartarse',
  settlement_not_found: 'La liquidación ya no existe',
  settlement_not_open: 'La liquidación ya no está abierta',
  settlement_not_closed: 'La liquidación no está cerrada',
  settlement_not_fully_paid: 'La liquidación aún tiene importes pendientes',
  payment_exceeds_settlement: 'El pago supera lo pendiente de la liquidación',
  receipt_already_confirmed: 'El cobro ya estaba confirmado',
  unsupported_period: 'El periodo no es un mes natural',
  expense_not_pending: 'El gasto ya fue resuelto',
  no_agreement_version: 'No hay versión de acuerdo vigente',

  // Wiki
  wiki_revision_conflict: 'Alguien guardó otra revisión antes que tú',
  page_not_found: 'La página ya no existe',
  space_not_found: 'El espacio ya no existe',
  template_not_found: 'La plantilla ya no existe',
  slug_taken: 'Ya existe una página con ese nombre',

  // Menú, recetas y compra
  menu_content_changed: 'El menú cambió mientras confirmabas: revísalo',
  slot_not_found: 'El hueco de menú ya no existe',
  recipe_not_found: 'La receta ya no existe',
  item_not_found: 'El artículo ya no existe',
  food_not_found: 'El alimento ya no existe',
  food_unreviewed: 'El alimento está pendiente de revisión',
  allergen_conflict: 'Choca con un alérgeno declarado del hogar',
  unknown_allergen: 'El alérgeno indicado no existe',
  duplicate_ingredient: 'Ese ingrediente ya está en la receta',
  duplicate_allergen: 'Ese alérgeno ya estaba declarado',
  duplicate_week: 'Esa semana ya tiene menú',
  diner_not_found: 'El comensal ya no existe',

  // Contactos
  contact_not_found: 'El contacto ya no existe',

  // Rutinas y calendario
  routine_not_found: 'La rutina ya no existe',
  already_completed: 'Ya estaba marcada como hecha',
  feed_not_found: 'El calendario externo ya no existe',
  source_not_found: 'El origen ya no existe',

  // Accesos y membresías
  already_revoked: 'El acceso ya estaba revocado',
  expiry_in_past: 'La caducidad no puede estar en el pasado',
  membership_not_found: 'La membresía ya no existe',
  cannot_modify_self: 'No puedes cambiar tu propia membresía',
  group_not_found: 'El grupo ya no existe'
};

/** Etiqueta humana del código de error del servidor; conserva el código crudo si es desconocido. */
export function describeErrorCode(code: string | undefined): string | null {
  if (!code) return null;
  return ERROR_CODE_LABELS[code] ?? code;
}
