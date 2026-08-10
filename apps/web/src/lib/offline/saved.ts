import type { CriticalSnapshotV1 } from './schema';

/**
 * Lectura honesta del paquete offline guardado en el dispositivo.
 *
 * El servidor declara la procedencia del paquete en `version` (ver
 * `buildCriticalSnapshot`):
 *
 * - `live-`    contenido real del hogar.
 * - `partial-` hay hogar real pero no se pudo leer: solo el 112.
 * - `fixture-` demostración sin base de datos.
 *
 * La firma Ed25519 es igual de válida en los tres, y por eso la marca importa:
 * un paquete firmado con datos inventados es peor que no tener paquete. De ahí
 * las dos reglas de este módulo, que son de seguridad y no de estética:
 *
 * 1. Un paquete de demostración NUNCA se enseña como si fueran datos de la
 *    casa. Puede haber quedado guardado de una sesión de prueba en el mismo
 *    navegador.
 * 2. Cuando se usa el paquete guardado hay que decir que lo es y DESDE CUÁNDO.
 *    Un teléfono de hace tres semanas puede seguir sirviendo; presentarlo como
 *    si fuera el de ahora, no.
 *
 * Este módulo lo importan solo las dos pantallas que enseñan lo guardado
 * —Emergencias y la página sin conexión—. El monitor de sincronización hace su
 * comprobación con un prefijo a mano, y ahí está explicado por qué: el arranque
 * de Hoy tiene el presupuesto de JavaScript contado al byte.
 */

const SAVED_AT = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit'
});

export type SnapshotProvenance = 'live' | 'partial' | 'fixture' | 'unknown';

export function snapshotProvenance(snapshot: Pick<CriticalSnapshotV1, 'version'>): SnapshotProvenance {
  const mark = snapshot.version.split('-', 1)[0];
  return mark === 'live' || mark === 'partial' || mark === 'fixture' ? mark : 'unknown';
}

/**
 * ¿Se puede enseñar este paquete como datos de la casa? Solo si su contenido
 * salió del hogar real: `partial` no trae contactos y `fixture` es inventado.
 */
export function isSavedHouseholdData(snapshot: Pick<CriticalSnapshotV1, 'version'> | null | undefined): boolean {
  return Boolean(snapshot) && snapshotProvenance(snapshot!) === 'live';
}

/** «Guardados en este dispositivo el 9 de agosto, 21:14». */
export function savedAtLabel(generatedAt: string): string {
  const moment = new Date(generatedAt);
  if (Number.isNaN(moment.getTime())) return 'Guardados en este dispositivo';
  return `Guardados en este dispositivo el ${SAVED_AT.format(moment)}`;
}
