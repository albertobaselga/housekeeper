import type { RoutineFrequency } from './commands';

/**
 * Copy de la repetición de rutinas en lenguaje natural (P2-2 / P3-1 de la
 * revisión UX v3): nada de «cada 1 semana(s)». La concordancia se resuelve
 * aquí, en un único sitio, para el formulario («Se repite cada [2] [semanas]»)
 * y para los listados («cada semana», «cada 2 semanas»).
 */

const UNITS: Record<RoutineFrequency, { singular: string; plural: string }> = {
  daily: { singular: 'día', plural: 'días' },
  weekly: { singular: 'semana', plural: 'semanas' },
  monthly: { singular: 'mes', plural: 'meses' },
  quarterly: { singular: 'trimestre', plural: 'trimestres' }
};

/** «semana» o «semanas» según el número; para el desplegable del formulario. */
export function routineUnitLabel(frequency: RoutineFrequency, intervalCount: number): string {
  const unit = UNITS[frequency];
  return intervalCount === 1 ? unit.singular : unit.plural;
}

/** Frase de listado: «cada semana», «cada 2 semanas», «cada mes», «cada 3 días». */
export function routineCadenceLabel(frequency: RoutineFrequency, intervalCount: number): string {
  return intervalCount === 1
    ? `cada ${UNITS[frequency].singular}`
    : `cada ${intervalCount} ${UNITS[frequency].plural}`;
}
