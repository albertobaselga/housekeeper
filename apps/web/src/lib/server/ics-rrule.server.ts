import { invariant, type RoutineRule } from '@housekeeper/domain';

/**
 * Traducción de la cadencia de una rutina al vocabulario de repetición de la
 * RFC 5545 (§5.4 de `docs/rutinas-y-calendario.md`, T8).
 *
 * El modelo de patrones es la verdad y RRULE es SOLO un formato de salida
 * (§2.1): aquí no se decide nada de recurrencia, se dice en otro idioma lo que
 * ya decidió `@housekeeper/domain`. Por eso la función puede devolver `null`.
 *
 * LA REGLA ES «O FIEL O NADA». Si la RRULE no reprodujera EXACTAMENTE las
 * mismas fechas que `occurrencesBetween`, no se emite: el llamante vuelve a
 * escribir una ocurrencia por VEVENT, que es feo pero cierto. Un calendario
 * que aproxima es peor que uno largo, porque el suscriptor no tiene manera de
 * saber que le están mintiendo.
 *
 * El único caso conocido en que no se puede ser fiel —y el que la
 * especificación señalaba— es `month_day >= 29`:
 *
 *   · La RFC 5545 SALTA. `BYMONTHDAY=31` no genera nada en febrero, abril,
 *     junio, septiembre ni noviembre; `BYMONTHDAY=30` no genera nada en
 *     febrero; `BYMONTHDAY=29` no genera nada en los febreros no bisiestos.
 *   · El motor de la casa RECORTA al último día del mes (§2.8), porque saltar
 *     significaría que en febrero no se hace la limpieza a fondo.
 *
 * `month_day = -1` sí es fiel: `BYMONTHDAY=-1` es literalmente «el último día
 * del mes» en la RFC, que es exactamente lo que hace el recorte. Y 1..28 es
 * fiel porque el recorte nunca llega a actuar: todos los meses tienen 28 días.
 *
 * Los otros tres patrones se expresan enteros y sin salvedades:
 *
 *   every_n_days   → FREQ=DAILY;INTERVAL=n
 *   days_of_week   → FREQ=WEEKLY;INTERVAL=r;BYDAY=…;WKST=MO
 *   day_of_month   → FREQ=MONTHLY;INTERVAL=r;BYMONTHDAY=d
 *   months_of_year → FREQ=YEARLY;BYMONTH=…;BYMONTHDAY=d
 *
 * `WKST=MO` no es decorativo: con `INTERVAL > 1` es lo que decide dónde empieza
 * cada semana y, por tanto, cuáles son las semanas activas. El motor cuenta en
 * lunes absolutos (§2.8), así que decirlo es obligatorio; callarlo dejaría a
 * merced del cliente, cuyo valor por omisión en la RFC es `MO` pero que nadie
 * garantiza.
 */

/** ISO 1=lunes … 7=domingo → las dos letras de la RFC. */
const RFC_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

function rfcWeekday(isoWeekday: number): string {
  const code = RFC_WEEKDAYS[isoWeekday - 1];
  invariant(code !== undefined, 'INVALID_ROUTINE_RULE', `Día fuera de 1..7: ${isoWeekday}`);
  return code;
}

/**
 * ¿Puede `BYMONTHDAY` decir este día sin mentir? `-1` es «el último» y 1..28
 * existe en todos los meses; de 29 en adelante la RFC salta donde nosotros
 * recortamos.
 */
function monthDayIsFaithful(monthDay: number): boolean {
  return monthDay === -1 || (monthDay >= 1 && monthDay <= 28);
}

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** `YYYY-MM-DD` → `YYYYMMDD`, la forma DATE de la RFC 5545. */
function rfcDate(isoDate: string): string {
  return isoDate.replaceAll('-', '');
}

/**
 * El valor de la propiedad `RRULE` (sin el prefijo `RRULE:`) para una cadencia,
 * o `null` si esa cadencia no se puede expresar con fidelidad.
 *
 * No incluye `DTSTART`: la FASE la pone el llamante poniendo como comienzo del
 * VEVENT una ocurrencia REAL de la regla. Es requisito de la RFC —«el conjunto
 * generado con un DTSTART no sincronizado con la regla queda indefinido»— y
 * además es lo que hace que `INTERVAL` cuente desde donde debe.
 *
 * `UNTIL` va como DATE (`YYYYMMDD`) y no como DATE-TIME a propósito: la RFC
 * exige que `UNTIL` sea del mismo tipo que `DTSTART`, y el de una rutina es una
 * fecha de calendario sin hora. `ends_on` es inclusivo (§2.8) y `UNTIL` también,
 * así que la traducción es directa.
 */
export function routineRrule(rule: RoutineRule): string | null {
  const parts: string[] = [];
  switch (rule.pattern) {
    case 'every_n_days':
      parts.push('FREQ=DAILY');
      if (rule.repeatEvery !== 1) parts.push(`INTERVAL=${rule.repeatEvery}`);
      break;
    case 'days_of_week':
      parts.push('FREQ=WEEKLY');
      if (rule.repeatEvery !== 1) parts.push(`INTERVAL=${rule.repeatEvery}`);
      parts.push(`BYDAY=${sortedUnique(rule.weekdays).map(rfcWeekday).join(',')}`);
      parts.push('WKST=MO');
      break;
    case 'day_of_month':
      if (!monthDayIsFaithful(rule.monthDay)) return null;
      parts.push('FREQ=MONTHLY');
      if (rule.repeatEvery !== 1) parts.push(`INTERVAL=${rule.repeatEvery}`);
      parts.push(`BYMONTHDAY=${rule.monthDay}`);
      break;
    case 'months_of_year':
      if (!monthDayIsFaithful(rule.monthDay)) return null;
      // `repeat_every` no interviene en este patrón (§2.8): la CHECK de la base
      // lo obliga a ser NULL y el motor no lo mira. INTERVAL queda en su 1 por
      // omisión, que es «todos los años».
      parts.push('FREQ=YEARLY');
      parts.push(`BYMONTH=${sortedUnique(rule.months).join(',')}`);
      parts.push(`BYMONTHDAY=${rule.monthDay}`);
      break;
  }
  if (rule.endsOn != null) parts.push(`UNTIL=${rfcDate(rule.endsOn)}`);
  return parts.join(';');
}
