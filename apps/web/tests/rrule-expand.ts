/**
 * Expansor mínimo de `RRULE` escrito a partir de la RFC 5545, NO del código que
 * emite el feed.
 *
 * Existe para que la prueba de T8 pueda ser una demostración y no una promesa:
 * comparar la cadena emitida contra otra cadena escrita a mano en el mismo
 * commit no prueba nada —solo dice que quien escribió las dos piensa lo mismo—.
 * Lo que hace falta es EXPANDIR la regla emitida y comprobar que las fechas que
 * salen son exactamente las que genera `occurrencesBetween`.
 *
 * En el repositorio no había ninguna librería de expansión: `apps/worker/src/ics.ts`
 * tiene un parser de entrada, pero es deliberadamente estrecho (rechaza
 * `YEARLY`, prohíbe `BYDAY` fuera de `WEEKLY` y no entiende `BYMONTHDAY`), así
 * que usarlo como juez sería medir la salida con el trozo de RFC que este
 * repositorio ya decidió no cubrir. De ahí estas ~100 líneas.
 *
 * DECISIÓN CENTRAL: implementa la semántica de la RFC, que **salta** los meses
 * sin ese día del mes —«recurrence instances that are invalid dates are
 * ignored», §3.3.10—. Es justamente donde el motor de la casa discrepa (recorta
 * al último día), y por eso este expansor puede DEMOSTRAR la discrepancia en
 * vez de darla por sabida.
 *
 * Cubre solo el vocabulario que el feed emite: FREQ (DAILY, WEEKLY, MONTHLY,
 * YEARLY), INTERVAL, BYDAY, BYMONTH, BYMONTHDAY, WKST y UNTIL como DATE.
 */

/** Índice de `Date#getUTCDay()`: 0 = domingo. */
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

const MS_PER_DAY = 86_400_000;

interface ParsedRrule {
  freq: 'DAILY' | 'MONTHLY' | 'WEEKLY' | 'YEARLY';
  interval: number;
  byDay: string[];
  byMonth: number[];
  byMonthDay: number[];
  wkst: string;
  until: string | null;
}

function toEpochDay(isoDate: string): number {
  return Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10))
  ) / MS_PER_DAY;
}

function toISO(epochDay: number): string {
  return new Date(epochDay * MS_PER_DAY).toISOString().slice(0, 10);
}

function weekdayCode(epochDay: number): string {
  const code = WEEKDAY_CODES[new Date(epochDay * MS_PER_DAY).getUTCDay()];
  if (code === undefined) throw new Error('Día de la semana imposible');
  return code;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateAt(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

/** `YYYYMMDD` (forma DATE de la RFC) → `YYYY-MM-DD`. */
function fromRfcDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export function parseRrule(rrule: string): ParsedRrule {
  const parts = new Map<string, string>();
  for (const chunk of rrule.split(';')) {
    const [key, value] = chunk.split('=');
    if (!key || value === undefined) throw new Error(`Parte de RRULE ilegible: ${chunk}`);
    parts.set(key, value);
  }
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    throw new Error(`FREQ no soportada por el expansor: ${String(freq)}`);
  }
  const list = (key: string): string[] => {
    const raw = parts.get(key);
    return raw === undefined ? [] : raw.split(',');
  };
  const interval = parts.get('INTERVAL');
  const until = parts.get('UNTIL');
  if (until !== undefined && !/^\d{8}$/.test(until)) {
    // Un UNTIL con hora sobre un DTSTART que es DATE está prohibido por la RFC
    // (§3.3.10) y sería ambiguo al comparar: el expansor se niega en vez de
    // adivinar.
    throw new Error(`UNTIL debe ser una DATE de 8 dígitos: ${until}`);
  }
  return {
    freq,
    interval: interval === undefined ? 1 : Number(interval),
    byDay: list('BYDAY'),
    byMonth: list('BYMONTH').map(Number),
    byMonthDay: list('BYMONTHDAY').map(Number),
    wkst: parts.get('WKST') ?? 'MO',
    until: until === undefined ? null : fromRfcDate(until)
  };
}

/**
 * Fechas del conjunto de recurrencia, en orden ascendente, empezando por
 * `dtStartISO` (que la RFC considera siempre la primera instancia) y hasta
 * `count` fechas o hasta `UNTIL`, lo que llegue antes.
 */
export function expandRrule(rrule: string, dtStartISO: string, count: number): string[] {
  const rule = parseRrule(rrule);
  const dtStart = toEpochDay(dtStartISO);
  const untilDay = rule.until === null ? null : toEpochDay(rule.until);
  const out: string[] = [];

  const emit = (day: number): boolean => {
    if (day < dtStart) return true;
    if (untilDay !== null && day > untilDay) return false;
    out.push(toISO(day));
    return out.length < count;
  };

  // Tope de periodos vacíos seguidos + periodos totales: sin él, una regla que
  // nunca genera nada (BYMONTHDAY=30 sobre BYMONTH=2, por ejemplo) colgaría.
  const MAX_PERIODS = 20_000;

  if (rule.freq === 'DAILY') {
    for (let period = 0; period < MAX_PERIODS; period += 1) {
      if (!emit(dtStart + period * rule.interval)) return out;
    }
    return out;
  }

  if (rule.freq === 'WEEKLY') {
    // La semana empieza en WKST: se retrocede hasta ese día.
    let weekStart = dtStart;
    while (weekdayCode(weekStart) !== rule.wkst) weekStart -= 1;
    const codes = rule.byDay.length > 0 ? rule.byDay : [weekdayCode(dtStart)];
    for (let period = 0; period < MAX_PERIODS; period += 1) {
      const base = weekStart + period * rule.interval * 7;
      const days = codes
        .map((code) => {
          let offset = 0;
          while (weekdayCode(base + offset) !== code) offset += 1;
          return base + offset;
        })
        .sort((left, right) => left - right);
      for (const day of days) if (!emit(day)) return out;
    }
    return out;
  }

  const startYear = Number(dtStartISO.slice(0, 4));
  const startMonth = Number(dtStartISO.slice(5, 7));
  const startDay = Number(dtStartISO.slice(8, 10));
  const monthDays = rule.byMonthDay.length > 0 ? rule.byMonthDay : [startDay];

  /** Fechas válidas del mes: las inválidas SE IGNORAN, no se recortan (RFC §3.3.10). */
  const daysOfMonth = (year: number, month: number): number[] => {
    const last = daysInMonth(year, month);
    const days: number[] = [];
    for (const wanted of monthDays) {
      const day = wanted > 0 ? wanted : last + wanted + 1;
      if (day >= 1 && day <= last) days.push(dateAt(year, month, day));
    }
    return days.sort((left, right) => left - right);
  };

  if (rule.freq === 'MONTHLY') {
    for (let period = 0; period < MAX_PERIODS; period += 1) {
      const index = (startYear * 12 + startMonth - 1) + period * rule.interval;
      const year = Math.floor(index / 12);
      const month = (index % 12) + 1;
      for (const day of daysOfMonth(year, month)) if (!emit(day)) return out;
    }
    return out;
  }

  const months = rule.byMonth.length > 0 ? [...rule.byMonth].sort((a, b) => a - b) : [startMonth];
  for (let period = 0; period < MAX_PERIODS; period += 1) {
    const year = startYear + period * rule.interval;
    for (const month of months) {
      for (const day of daysOfMonth(year, month)) if (!emit(day)) return out;
    }
  }
  return out;
}
