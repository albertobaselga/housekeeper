import type { RoutineOverduePolicy, RoutineSchedule } from '@housekeeper/domain';

/**
 * De columnas de `app.routines` a la regla del generador puro, para los dos
 * lectores de la web que las necesitan: «Hoy» y el paquete offline. Vive en su
 * propio módulo `.server.ts` para que ni la consulta ni el mapeo se dupliquen
 * —eran tres copias de la aritmética de recurrencia lo que la ola 0023 vino a
 * retirar, y no conviene estrenar dos copias de su lectura—.
 *
 * Ningún byte de esto llega al navegador: `@housekeeper/domain` entra por aquí,
 * que es código de servidor, y el presupuesto de arranque de Hoy no se entera.
 */

/**
 * Las columnas que la regla necesita, con el nombre que ya usan las consultas.
 * `pattern IS NULL` significa «se hace, falta decidir cuándo» (§2.3): esas
 * rutinas se gestionan en la página de Rutinas y no aparecen ni en Hoy ni en el
 * paquete offline, así que aquí se traducen a `null` y se descartan arriba.
 */
export const ROUTINE_RULE_COLUMNS = `routine.pattern::text as "pattern",
                routine.anchor_on::text as "anchorOn",
                routine.repeat_every as "repeatEvery",
                routine.weekdays::int[] as "weekdays",
                routine.month_day::int as "monthDay",
                routine.months::int[] as "months",
                routine.ends_on::text as "endsOn",
                routine.overdue_policy::text as "overduePolicy"`;

/**
 * Solo las columnas de las que sale la REGLA. La política de atraso no entra:
 * no interviene en generar ocurrencias, sino en decidir cuáles de las
 * generadas siguen pendientes. Separarlas deja que un lector que solo necesita
 * la cadencia —el feed ICS, que publica días y no atrasos— pida lo justo en
 * vez de arrastrar una columna que no va a mirar.
 */
export interface RoutineScheduleRow {
  pattern: string | null;
  anchorOn: string | null;
  repeatEvery: number | null;
  weekdays: number[] | null;
  monthDay: number | null;
  months: number[] | null;
  endsOn: string | null;
}

export interface RoutineRuleRow extends RoutineScheduleRow {
  overduePolicy: RoutineOverduePolicy;
}

/**
 * La CHECK `routines_pattern_shape` hace imposible una fila con huecos, pero
 * este lado es una LECTURA: si alguna vez llegara una, callar y no pintar la
 * rutina es peor que no pintarla y seguir sirviendo la página. Se devuelve
 * `null`, que el llamante ya sabe descartar.
 */
export function routineScheduleFrom(row: RoutineScheduleRow): RoutineSchedule {
  const anchorOn = row.anchorOn;
  if (row.pattern === null || anchorOn === null) return null;
  const endsOn = row.endsOn;
  switch (row.pattern) {
    case 'every_n_days':
      return row.repeatEvery === null
        ? null
        : { pattern: 'every_n_days', anchorOn, repeatEvery: row.repeatEvery, endsOn };
    case 'days_of_week':
      return row.repeatEvery === null || row.weekdays === null
        ? null
        : {
            pattern: 'days_of_week',
            anchorOn,
            repeatEvery: row.repeatEvery,
            weekdays: row.weekdays,
            endsOn
          };
    case 'day_of_month':
      return row.repeatEvery === null || row.monthDay === null
        ? null
        : {
            pattern: 'day_of_month',
            anchorOn,
            repeatEvery: row.repeatEvery,
            monthDay: row.monthDay,
            endsOn
          };
    case 'months_of_year':
      return row.months === null || row.monthDay === null
        ? null
        : {
            pattern: 'months_of_year',
            anchorOn,
            months: row.months,
            monthDay: row.monthDay,
            endsOn
          };
    default:
      return null;
  }
}
