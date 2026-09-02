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
  invalid_payload: 'Los datos del cambio no eran válidos',
  invalid_envelope: 'Los datos del cambio no eran válidos',
  not_allowed: 'Tu rol no permite esta acción',
  not_authorized: 'Tu acceso a este hogar no lo permite',
  unsupported_aggregate: 'La aplicación no reconoce este tipo de cambio',
  operation_conflict: 'Otro cambio llegó antes con otro contenido',
  constraint_violation: 'El cambio no encaja con lo que ya hay guardado',
  transient: 'No se pudo guardar ahora mismo; se reintenta solo',
  internal: 'Algo falló al guardar; se reintenta solo',

  // Fotos pendientes de subir (los pone el propio dispositivo, no el servidor)
  attachment_rejected: 'La casa no admitió esa foto: por su tamaño o porque no es una foto ni un PDF',
  attachment_upload_blocked: 'La foto no se pudo subir tras varios intentos',

  // Expediente laboral
  week_overlap: 'La semana se solapa con otra ya registrada',
  agreement_not_found: 'El contrato no existe o no es visible',
  extra_work_not_found: 'La jornada extra ya no existe',
  extra_work_not_requested: 'La jornada ya no admite aceptación',
  extra_work_not_performable: 'La jornada ya no admite marcarse como realizada',
  extra_work_not_resolvable: 'La jornada ya no admite resolución',
  extra_work_not_dismissible: 'La jornada ya no admite descartarse',
  settlement_not_found: 'La cuenta del mes ya no existe',
  settlement_not_open: 'La cuenta del mes ya no está abierta',
  settlement_not_closed: 'La cuenta del mes no está cerrada',
  settlement_not_fully_paid: 'La cuenta del mes aún tiene importes pendientes',
  payment_exceeds_settlement: 'El pago supera lo pendiente de la cuenta del mes',
  receipt_already_confirmed: 'El cobro ya estaba confirmado',
  unsupported_period: 'El periodo no es un mes natural',
  expense_not_pending: 'El gasto ya fue resuelto',
  no_agreement_version: 'No hay versión del contrato vigente',

  // Guía de la casa (wiki)
  wiki_revision_conflict: 'Otra persona guardó cambios mientras editabas; revisa su versión antes de guardar la tuya',
  page_not_found: 'La nota ya no existe',
  space_not_found: 'El apartado ya no existe',
  template_not_found: 'El modelo ya no existe',
  slug_taken: 'Ya existe una nota con ese nombre',

  // Menú, recetas y compra
  menu_content_changed: 'El menú cambió mientras confirmabas: revísalo',
  slot_not_found: 'Esa comida del menú ya no existe',
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
  template_name_taken: 'Ya hay una plantilla con ese nombre',
  menu_week_empty: 'La semana elegida no tiene nada que guardar',

  // Contactos
  contact_not_found: 'El contacto ya no existe',

  // Rutinas y calendario
  routine_not_found: 'La rutina ya no existe',
  already_completed: 'Ya estaba marcada como hecha',
  routine_has_no_schedule: 'Esa rutina todavía no tiene día',
  // Lo pone el servidor ante un alta guardada sin conexión con el formato de
  // cadencia anterior a la 0023, que la 0033 retiró. Se explica en vez de
  // traducirse a ciegas: el formato viejo no sabe decir «cada 15 días» ni «en
  // junio y en diciembre», así que adivinarlo guardaría otra cosa.
  routine_cadence_format_retired:
    'Esa rutina se guardó con el formato anterior: vuelve a darla de alta con la aplicación al día',
  completion_not_found: 'Esa rutina ya no estaba marcada como hecha',
  feed_not_found: 'El calendario externo ya no existe',
  source_not_found: 'El origen ya no existe',

  // Los mensajes de accesos y membresías viven como messageOverrides en la
  // página de Ajustes: solo allí pueden producirse y así no pesan en Hoy.
  group_not_found: 'El grupo ya no existe',

  // Finanzas
  // El más frecuente de todos: lo lanza requireFinanceAdmin (fase 1) cuando a un
  // admin le revocan Finanzas a media sesión. Sin él, el acuse diría «No se pudo
  // guardar el cambio.» sin causa, y la spec §7 exige acuse veraz.
  finance_not_granted: 'Finanzas no está activado para tu cuenta',
  not_granted: 'Esa persona ya no tenía Finanzas activado',
  already_granted: 'Esa persona ya tenía Finanzas activado',
  grant_target_not_admin: 'Solo se puede activar Finanzas a quien administra la casa',
  // membership_not_found queda fuera a propósito (R23): no pesa en Hoy.
  finance_account_not_found: 'La cuenta ya no existe',
  finance_category_not_found: 'La categoría ya no existe',
  finance_category_in_use: 'La categoría sigue en uso: vacíala antes de borrarla',
  finance_category_is_transfer: 'La categoría de transferencias no admite esa operación',
  finance_rule_not_found: 'La regla ya no existe',
  finance_transaction_not_found: 'El movimiento ya no existe',
  finance_not_manual: 'Solo se pueden borrar movimientos manuales',
  finance_cashpair_leg: 'Es una contrapartida de efectivo: borra su gasto original',
  finance_event_not_found: 'El evento ya no existe',
  finance_event_name_taken: 'Ya existe un evento con ese nombre',
  finance_batch_not_found: 'Esa importación ya no existe',
  finance_transfer_sum_not_zero: 'La selección no suma cero',
  finance_already_linked: 'Algún movimiento ya pertenece a una transferencia',
  finance_transfer_group_not_found: 'Esa transferencia ya no existe',
  finance_not_investment_account: 'La cuenta destino no es de inversión',
  finance_invest_needs_charge: 'Solo un cargo puede marcarse como inversión',
  finance_mirror_exists: 'Ese movimiento ya tiene su espejo de inversión',
  finance_selector_required: 'Se necesita un proveedor o una categoría'
};

/**
 * Etiqueta humana del código de error, o null si no hay ninguna que dar.
 *
 * Un código sin traducir NO se escupe tal cual: «no_agreement_version» no le
 * dice nada a nadie y deja la pantalla peor que sin explicación. Devolviendo
 * null, cada sitio pone su frase llana («No se pudo guardar el cambio.») y el
 * código crudo se queda en la consola para quien mantenga la instalación.
 */
export function describeErrorCode(code: string | undefined): string | null {
  if (!code) return null;
  const label = ERROR_CODE_LABELS[code];
  if (label) return label;
  console.warn('[housekeeper] código de error sin traducir:', code);
  return null;
}
