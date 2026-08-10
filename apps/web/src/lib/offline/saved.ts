import type { CriticalSnapshotV1 } from './schema';

/**
 * Lectura honesta del paquete offline guardado en el dispositivo.
 *
 * Dos reglas, y las dos son de seguridad, no de estética:
 *
 * 1. Un paquete de demostración (`version` que empieza por `fixture-`) NUNCA
 *    se enseña como si fueran datos de la casa. Puede haber quedado guardado
 *    de una sesión de prueba en el mismo navegador.
 * 2. Cuando se usa el paquete guardado hay que decir que lo es y DESDE CUÁNDO.
 *    Un teléfono de hace tres semanas puede seguir sirviendo; presentarlo como
 *    si fuera el de ahora, no.
 */

const SAVED_AT = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit'
});

/** Procedencia declarada por el servidor en `version` (ver snapshot.server.ts). */
export type SnapshotProvenance = 'live' | 'partial' | 'fixture' | 'unknown';

export function snapshotProvenance(snapshot: Pick<CriticalSnapshotV1, 'version'>): SnapshotProvenance {
  const mark = snapshot.version.split('-', 1)[0];
  return mark === 'live' || mark === 'partial' || mark === 'fixture' ? mark : 'unknown';
}

/**
 * ¿Se puede enseñar este paquete como datos de la casa? Solo si su contenido
 * salió del hogar real. `partial` no trae contactos que enseñar y `fixture` es
 * inventado, así que ninguno de los dos vale.
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
