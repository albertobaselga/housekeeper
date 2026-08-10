// Alta del CONTRATO LABORAL de un hogar real: el contrato, su primera versión y
// EL CATÁLOGO DE CONDICIONES de esa versión.
//
// Es el hermano de apps/web/scripts/seed-household-accounts.mjs y se alimenta
// del MISMO JSON externo: las cuentas dan de alta a las personas, este guion da
// de alta lo que se pactó con la que trabaja. Hasta aquí un contrato solo entraba
// por fixtures sintéticas, así que un hogar real se quedaba sin la pieza que
// sostiene la sección Contrato entera (salario, horario, jornadas extra,
// vacaciones).
//
// Los datos NUNCA viven en el repositorio: se pasan en un JSON externo.
//
//   DATABASE_URL=postgresql://… node scripts/seed-employment-agreement.mjs \
//     --config /ruta/fuera/del/repo/hogar.json
//
// Opciones:
//   --config <ruta>   obligatorio. El mismo JSON del alta de cuentas.
//   --dry-run         dice qué haría y no escribe nada.
//
// Entorno:
//   DATABASE_URL   rol propietario de las migraciones del esquema `app` (el
//                  mismo que ejecuta `migrate`). No es el rol de la aplicación:
//                  el alta se hace por fuera de la RLS, como la de cuentas.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUÉ ESTE GUION EXIGE EL CATÁLOGO Y SE NIEGA A ESCRIBIR SIN ÉL
//
// Hasta la migración 0021 lo pactable vivía en cinco columnas de
// `app.agreement_versions` y bastaba con rellenarlas. Desde 0021 la verdad de
// qué trabajo extra existe y a cuánto se paga está en `app.extra_work_types`,
// colgando de la VERSIÓN. Una versión sin conceptos es un acuerdo MUDO: la
// política `extra_work_types_employee_read` no le enseña nada a la empleada,
// `registrableTypes` sale vacío y no puede registrar ninguna jornada extra.
//
// Y no tiene arreglo hacia atrás. Las versiones son inmutables (disparador
// `agreement_versions_append_only` de 0002) y su catálogo también (0021); una
// versión nueva tiene que entrar en vigor DESPUÉS de la anterior, y el
// disparador `extra_work_events_type_freeze` exige que el concepto sea el de la
// versión vigente EL DÍA TRABAJADO. Entre el inicio del acuerdo y esa v2 queda
// una ventana en la que ella no podrá registrar nada nunca, ni retroactivamente.
//
// Por eso el guion hace las dos cosas a la vez, y no solo una:
//
//   · SE NIEGA a crear el acuerdo si el JSON no declara `extraWorkTypes`. El
//     fallo era silencioso —el guion terminaba con éxito y dejaba el destrozo
//     hecho—, y lo primero es que deje de serlo.
//   · ACEPTA el catálogo completo y lo escribe en la misma transacción. Rendirse
//     y remitir solo a la pantalla dejaría el alta de un hogar real en manos de
//     un formulario sin `--dry-run`, sin idempotencia y sin marcha atrás sobre
//     una tabla que solo admite INSERT. Poder ensayar el alta antes de hacerla
//     vale más aquí que en ningún otro sitio.
//
// La pantalla `/h/<hogar>/employment/acuerdo` sigue siendo la vía normal —tiene
// autoría, RLS y el historial delante— y este guion la vía ensayable. Escriben
// lo mismo: el orden de `insertFirstVersion` es el de `insertVersion` en
// apps/web/src/lib/server/agreement-terms.server.ts, columnas reliquia
// incluidas.
// ─────────────────────────────────────────────────────────────────────────────
//
// Formato del JSON (ejemplo INVENTADO; el real vive fuera del repositorio):
//
//   {
//     "household": { "slug": "casa-ejemplo", "displayName": "Casa Ejemplo" },
//     "people": [
//       { "username": "rosa",  "name": "Rosa",  "email": "rosa@ejemplo.test",  "role": "family_admin" },
//       { "username": "lucia", "name": "Lucía", "email": "lucia@casa.local",   "role": "employee_live_in" }
//     ],
//     "agreement": {
//       "employeeUsername": "lucia",
//       "createdByUsername": "rosa",
//       "startsOn": "2026-01-07",
//       "monthlySalaryCents": 123400,
//       "currencyCode": "EUR",
//       "contractedWeeklyMinutes": 2400,
//       "annualVacationDays": 30,
//       "schedule": {
//         "from": "08:00",
//         "to": "19:00",
//         "longBreakMinutes": 120,
//         "effectiveHoursPerDay": 8,
//         "weekly": "Cinco jornadas de lunes a viernes. Fin de semana libre.",
//         "restDays": ["sabado", "domingo"],
//         "days": { "viernes": { "to": "15:00" } }
//       },
//       "extraWorkTypes": [
//         { "code": "jornada_extra", "name": "Jornada extra", "unit": "per_shift",
//           "rateCents": 5000, "referenceMinutes": 480, "active": true },
//         { "code": "media_jornada_extra", "name": "Media jornada extra", "unit": "per_shift",
//           "rateCents": 2500, "referenceMinutes": 240, "active": true }
//       ],
//       "supplements": [
//         { "code": "antiguedad", "name": "Complemento de antigüedad",
//           "amountCents": 3000, "addsToPay": true }
//       ]
//     }
//   }
//
// DESACTIVAR LAS HORAS SUELTAS ES NO ESCRIBIRLAS. No hay bandera para eso: si el
// catálogo no trae ningún concepto `per_hour`, no existe ninguna tarifa horaria
// y la empleada no puede verla por ninguna vía, porque no hay fila que ver. Es
// más limpio que dejarla escrita y desactivada. (Por eso `allowsHourlyOvertime`
// y `allowsExtraShifts` ya no se aceptan: mira `RETIRED_KEYS` más abajo.)
//
// EL HORARIO, DESDE LA MIGRACIÓN 0025, VA A DOS SITIOS:
//
//   · `terms.schedule`, la frase de siempre. No se retira: es lo que se pactó
//     por escrito con los hogares ya dados de alta y el expediente no reescribe
//     el pasado.
//   · `app.agreement_schedules` + `app.agreement_schedule_days`, el dato
//     consultable que la aplicación enseña y compara con la jornada semanal
//     contratada.
//
// La forma del JSON no cambia: `from`, `to` y `longBreakMinutes` ya estaban y
// ahora, además de redactar la frase, construyen la jornada tipo. Lo nuevo es
// opcional y sirve para lo que la frase no sabía decir:
//
//   · `restDays` — qué días NO se trabaja. Nombres en castellano (con o sin
//     tilde) o números ISO (1 lunes … 7 domingo).
//   · `days` — los días que se salen de la jornada tipo, por su nombre o número.
//     Cada uno admite `from`, `to`, `longBreakMinutes` y `note`, y lo que no
//     diga lo hereda de la jornada tipo: terminar antes un día es `{"to":
//     "15:00"}` y nada más.
//
// Un `schedule` que sea una CADENA sigue valiendo y sigue yendo solo a
// `terms.schedule`: de una frase no se puede deducir un horario sin inventar, y
// este guion no inventa condiciones.
//
// `extraWorkTypes` puede ser una lista VACÍA, y entonces el contrato no admite
// ningún trabajo extra. Es una decisión legítima, pero tiene que estar escrita:
// lo que este guion no acepta es que nadie haya dicho nada.
//
// Idempotente: el acuerdo activo de esa persona en ese hogar es la clave. Si ya
// existe con la misma primera versión Y el mismo catálogo, el guion no escribe
// nada. Si existe con condiciones DISTINTAS, aborta: cambiar lo pactado es
// añadir una versión nueva (append-only, disparador
// `agreement_versions_append_only`), y eso se hace desde la aplicación, con
// autoría y motivo, no reescribiendo el pasado.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import pg from 'pg';

/** Roles de app.household_role que pueden ser la parte trabajadora del acuerdo. */
export const EMPLOYEE_ROLES = ['employee_live_in', 'helper'];
/** Quien firma el alta por parte de la casa. */
const ADMIN_ROLE = 'family_admin';
/** Crédito por descanso trabajado cuando el catálogo no fija ninguna jornada. */
const DEFAULT_REST_DAY_CREDIT_MINUTES = 1440;
const DEFAULT_REASON = 'Alta inicial del acuerdo';

/** Unidades de app.extra_work_unit (0021). */
const EXTRA_WORK_UNITS = ['per_hour', 'per_shift', 'fixed_amount'];
/** El CHECK de `code` en las dos tablas del catálogo, literal. */
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,38}[a-z0-9]$/;

export const EXTRA_WORK_TYPES_MISSING_MESSAGE =
  'El JSON no dice qué trabajo extra se ha pactado, y este guion ya NO da de alta un acuerdo sin ' +
  'catálogo: desde la migración 0021 una versión sin conceptos deja a quien trabaja sin poder ' +
  'registrar ni una jornada extra, y no hay arreglo posible —las versiones y su catálogo son ' +
  'inmutables, y una versión nueva solo puede entrar en vigor más tarde, así que los días ' +
  'intermedios se quedan sin nada para siempre. Añade `agreement.extraWorkTypes` con lo pactado ' +
  '(code, name, unit, rateCents y, en las jornadas, referenceMinutes). Si de verdad no se pacta ' +
  'ningún trabajo extra, escríbelo como lista vacía: "extraWorkTypes": []. Y si prefieres darlo ' +
  'de alta a mano, la pantalla Contrato → «Administrar el contrato» ' +
  '(/h/<hogar>/employment/acuerdo) escribe contrato, versión y catálogo de una vez.';

/**
 * Claves de 0002 que el catálogo de 0021 sustituyó. No se ignoran en silencio:
 * un fichero que las traiga fue escrito creyendo otra cosa, y esa creencia es
 * justo la que hay que corregir antes de escribir nada.
 */
const RETIRED_KEYS = {
  overtimeHourlyRateCents:
    'la tarifa por hora es ahora un concepto del catálogo con unit "per_hour". Si no quieres que ' +
    'haya horas sueltas, no escribas ninguno: sin fila no hay tarifa que ver.',
  workedRestDayRateCents:
    'la tarifa de jornada es ahora un concepto del catálogo con unit "per_shift" y su ' +
    'referenceMinutes.',
  workedRestDayCreditMinutes:
    'el crédito por jornada es el `referenceMinutes` del concepto de jornada.',
  allowsHourlyOvertime:
    'el permiso real es el campo `active` de cada concepto del catálogo (y no escribir el ' +
    'concepto, que es aún más claro). Esta bandera solo quedaba escrita en el texto del acuerdo y ' +
    'no la obedecía nadie.',
  allowsExtraShifts:
    'el permiso real es el campo `active` de cada concepto del catálogo. Esta bandera solo quedaba ' +
    'escrita en el texto del acuerdo y no la obedecía nadie.'
};

export const OVERTIME_FLAG_RETIRED_MESSAGE =
  '--overtime-hourly-rate-cents ya no existe: la tarifa por hora es un concepto más del catálogo. ' +
  'Ponla en `agreement.extraWorkTypes` con unit "per_hour", o no la pongas si no se pactan horas ' +
  'sueltas.';

function requireInteger(value, label, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${label} tiene que ser un número entero >= ${min} (llegó ${JSON.stringify(value)})`);
  }
  return value;
}

/** Entero o null explícito: «pactado sin tarifa todavía» es un dato, no un olvido. */
function requireIntegerOrNull(value, label, { min = 0 } = {}) {
  if (value === null) return null;
  return requireInteger(value, label, { min });
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} tiene que ser true o false (llegó ${JSON.stringify(value)})`);
  }
  return value;
}

function requireText(value, label, { max = 80 } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < 1 || text.length > max) {
    throw new Error(`${label} tiene que ser un texto de 1 a ${max} caracteres (llegó ${JSON.stringify(value)})`);
  }
  return text;
}

function requireCode(value, label) {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!CODE_PATTERN.test(code)) {
    throw new Error(
      `${label} tiene que ser un código en minúsculas, dígitos y guion bajo, de 3 a 40 caracteres ` +
        `(por ejemplo «jornada_extra»); llegó ${JSON.stringify(value)}`
    );
  }
  return code;
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function optionalIsoDate(value, label) {
  if (value == null) return null;
  if (!isIsoDate(value)) throw new Error(`${label} tiene que ser una fecha AAAA-MM-DD (llegó ${value})`);
  return value;
}

/**
 * Las condiciones de horario acaban en `terms.schedule` como TEXTO. Se admite ya
 * escrito (una cadena, que se usa tal cual) o descompuesto en campos, que aquí
 * se redactan en una frase estable. Las claves que empiezan por «_» son notas
 * internas del fichero y no viajan al contrato.
 *
 * Sigue existiendo después de 0025: es la frase que se pactó por escrito con
 * los hogares ya dados de alta, y el expediente no reescribe el pasado. El dato
 * consultable lo construye `scheduleToStructured` a partir del mismo JSON.
 */
export function scheduleToText(schedule) {
  if (schedule == null) return null;
  if (typeof schedule === 'string') {
    const text = schedule.trim();
    return text.length > 0 ? text : null;
  }
  if (typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new Error('agreement.schedule tiene que ser un texto o un objeto con las condiciones');
  }
  const parts = [];
  const from = schedule.from == null ? null : String(schedule.from).trim();
  const to = schedule.to == null ? null : String(schedule.to).trim();
  if (from && to) parts.push(`Presencia de ${from} a ${to}.`);
  else if (from) parts.push(`Entrada a las ${from}.`);
  else if (to) parts.push(`Salida a las ${to}.`);
  if (schedule.longBreakMinutes != null) {
    const minutes = requireInteger(schedule.longBreakMinutes, 'agreement.schedule.longBreakMinutes');
    parts.push(`Descanso largo de ${minutes} minutos.`);
  }
  if (schedule.effectiveHoursPerDay != null) {
    const hours = Number(schedule.effectiveHoursPerDay);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new Error('agreement.schedule.effectiveHoursPerDay tiene que ser un número de horas positivo');
    }
    parts.push(`Jornada efectiva de ${hours} h al día.`);
  }
  if (schedule.weekly != null) {
    const weekly = String(schedule.weekly).trim();
    if (weekly) parts.push(weekly.endsWith('.') ? weekly : `${weekly}.`);
  }
  const text = parts.join(' ').trim();
  return text.length > 0 ? text : null;
}

/** ISO-8601, el mismo convenio que la columna `weekday`: 1 lunes … 7 domingo. */
const WEEKDAY_NUMBERS = new Map([
  ['lunes', 1],
  ['martes', 2],
  ['miercoles', 3],
  ['miércoles', 3],
  ['jueves', 4],
  ['viernes', 5],
  ['sabado', 6],
  ['sábado', 6],
  ['domingo', 7]
]);

export function weekdayNumber(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > 7) {
      throw new Error(`«${value}» no es un día de la semana (1 lunes … 7 domingo)`);
    }
    return value;
  }
  const name = String(value ?? '').trim().toLowerCase();
  // Las claves de un objeto JSON son siempre cadenas, así que `{"6": …}` llega
  // aquí como «6» y tiene que valer lo mismo que el número.
  if (/^[1-7]$/.test(name)) return Number(name);
  const number = WEEKDAY_NUMBERS.get(name);
  if (!number) {
    throw new Error(
      `«${value}» no es un día de la semana. Usa lunes…domingo o un número ISO (1 lunes … 7 domingo)`
    );
  }
  return number;
}

/** «8:00» y «08:00» valen; «24:00», «8» y «ocho» no. Devuelve siempre HH:MM. */
export function normalizeTime(value, label) {
  const raw = String(value ?? '').trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) {
    throw new Error(`${label} tiene que ser una hora HH:MM (llegó ${raw || '(vacío)'})`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`${label} no es una hora del día (llegó ${raw})`);
  }
  return `${String(hours).padStart(2, '0')}:${match[2]}`;
}

function minutesOfDay(time) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/**
 * El horario como DATO, listo para `app.agreement_schedules` y sus días.
 *
 * Devuelve null cuando no hay con qué construirlo: `schedule` ausente, escrito
 * como frase suelta, o sin las dos horas de la jornada tipo. Null no es un
 * fallo; es «este contrato no declara horario consultable», y la aplicación lo
 * trata como tal (no le enseña a la empleada una sección vacía).
 */
export function scheduleToStructured(schedule) {
  if (schedule == null || typeof schedule === 'string') return null;
  if (typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new Error('agreement.schedule tiene que ser un texto o un objeto con las condiciones');
  }
  if (schedule.from == null || schedule.to == null) {
    // Con una sola hora no hay jornada que declarar, y deducir la otra sería
    // inventarse una condición del contrato.
    if (schedule.restDays != null || schedule.days != null) {
      throw new Error(
        'agreement.schedule trae restDays o days pero le faltan `from` y `to`: sin la jornada tipo ' +
          'no se puede saber qué hereda cada día'
      );
    }
    return null;
  }

  const startsAt = normalizeTime(schedule.from, 'agreement.schedule.from');
  const endsAt = normalizeTime(schedule.to, 'agreement.schedule.to');
  if (minutesOfDay(endsAt) <= minutesOfDay(startsAt)) {
    throw new Error(
      `La jornada de ${startsAt} a ${endsAt} termina antes de empezar. Una guardia nocturna no es ` +
        'horario ordinario: se pacta como trabajo extra.'
    );
  }
  const longBreakMinutes =
    schedule.longBreakMinutes == null
      ? 0
      : requireInteger(schedule.longBreakMinutes, 'agreement.schedule.longBreakMinutes');
  if (longBreakMinutes >= minutesOfDay(endsAt) - minutesOfDay(startsAt)) {
    throw new Error(
      `El descanso de ${longBreakMinutes} minutos no cabe entre ${startsAt} y ${endsAt}`
    );
  }

  const byWeekday = new Map();
  for (const value of Array.isArray(schedule.restDays) ? schedule.restDays : []) {
    const weekday = weekdayNumber(value);
    byWeekday.set(weekday, {
      weekday,
      works: false,
      startsAt: null,
      endsAt: null,
      longBreakMinutes: null,
      note: ''
    });
  }

  const exceptions = schedule.days;
  if (exceptions != null) {
    if (typeof exceptions !== 'object' || Array.isArray(exceptions)) {
      throw new Error('agreement.schedule.days tiene que ser un objeto {día: {…}}');
    }
    for (const [key, raw] of Object.entries(exceptions)) {
      // Las claves que empiezan por «_» son notas internas del fichero, igual
      // que en el resto del JSON.
      if (key.startsWith('_')) continue;
      const weekday = weekdayNumber(key);
      if (byWeekday.has(weekday)) {
        throw new Error(
          `El día ${key} aparece en restDays y en days a la vez: decide si se libra o si es distinto`
        );
      }
      if (raw === false || raw === 'libra') {
        byWeekday.set(weekday, {
          weekday,
          works: false,
          startsAt: null,
          endsAt: null,
          longBreakMinutes: null,
          note: ''
        });
        continue;
      }
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`agreement.schedule.days.${key} tiene que ser un objeto, false o "libra"`);
      }
      if (raw.works === false) {
        byWeekday.set(weekday, {
          weekday,
          works: false,
          startsAt: null,
          endsAt: null,
          longBreakMinutes: null,
          note: String(raw.note ?? '').trim()
        });
        continue;
      }
      const dayStarts =
        raw.from == null ? null : normalizeTime(raw.from, `agreement.schedule.days.${key}.from`);
      const dayEnds =
        raw.to == null ? null : normalizeTime(raw.to, `agreement.schedule.days.${key}.to`);
      const dayBreak =
        raw.longBreakMinutes == null
          ? null
          : requireInteger(raw.longBreakMinutes, `agreement.schedule.days.${key}.longBreakMinutes`);
      const note = String(raw.note ?? '').trim();
      // Se resuelve contra la jornada tipo, que es lo que hará la base de datos:
      // mejor decirlo aquí, con el nombre del día, que recibir un 23514 seco.
      const resolvedStart = dayStarts ?? startsAt;
      const resolvedEnd = dayEnds ?? endsAt;
      const resolvedBreak = dayBreak ?? longBreakMinutes;
      if (minutesOfDay(resolvedEnd) <= minutesOfDay(resolvedStart)) {
        throw new Error(`El ${key} terminaría a las ${resolvedEnd} habiendo entrado a las ${resolvedStart}`);
      }
      if (resolvedBreak >= minutesOfDay(resolvedEnd) - minutesOfDay(resolvedStart)) {
        throw new Error(`El descanso del ${key} no cabe entre ${resolvedStart} y ${resolvedEnd}`);
      }
      // Un día idéntico a la jornada tipo y sin nota no es una excepción: la
      // base lo rechazaría por CHECK, y con razón.
      const changes =
        (dayStarts !== null && dayStarts !== startsAt) ||
        (dayEnds !== null && dayEnds !== endsAt) ||
        (dayBreak !== null && dayBreak !== longBreakMinutes);
      if (!changes && note === '') {
        throw new Error(
          `agreement.schedule.days.${key} no cambia nada respecto a la jornada tipo: quítalo o di qué cambia`
        );
      }
      byWeekday.set(weekday, {
        weekday,
        works: true,
        startsAt: dayStarts === startsAt ? null : dayStarts,
        endsAt: dayEnds === endsAt ? null : dayEnds,
        longBreakMinutes: dayBreak === longBreakMinutes ? null : dayBreak,
        note
      });
    }
  }

  return {
    startsAt,
    endsAt,
    longBreakMinutes,
    note: String(schedule.note ?? '').trim(),
    days: [...byWeekday.values()].sort((left, right) => left.weekday - right.weekday)
  };
}

/**
 * Minutos efectivos que suma la semana.
 *
 * La misma regla que `weeklyEffectiveMinutes` de `@casa-clara/domain`, repetida
 * aquí a la fuerza: el motor puro es TypeScript sin compilar (el paquete exporta
 * `./src/index.ts`) y este guion se ejecuta con `node` a secas, sin
 * transpilador. Las dos copias están fijadas por pruebas que comparan los mismos
 * números —`packages/domain/src/agreement-schedule.test.ts` y
 * `packages/db/tests/080_agreement_schedule.sql`—, así que una divergencia se
 * caza en la suite, no en producción.
 */
export function weeklyEffectiveMinutes(structured) {
  let total = 0;
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const day = structured.days.find((candidate) => candidate.weekday === weekday);
    if (day && !day.works) continue;
    const startsAt = day?.startsAt ?? structured.startsAt;
    const endsAt = day?.endsAt ?? structured.endsAt;
    const breakMinutes = day?.longBreakMinutes ?? structured.longBreakMinutes;
    total += minutesOfDay(endsAt) - minutesOfDay(startsAt) - breakMinutes;
  }
  return total;
}

/**
 * Catálogo de trabajo extra. Las reglas son las de 0021 escritas antes de tocar
 * la base: un CHECK violado a medio camino diría «new row violates check
 * constraint "extra_work_types_check1"», que no ayuda a nadie a arreglar su
 * fichero.
 */
export function normalizeExtraWorkTypes(agreement) {
  const declared = agreement?.extraWorkTypes;
  if (declared === undefined) throw new Error(EXTRA_WORK_TYPES_MISSING_MESSAGE);
  if (!Array.isArray(declared)) {
    throw new Error('agreement.extraWorkTypes tiene que ser una lista (vacía si no se pacta ninguno)');
  }
  const seen = new Set();
  return declared.map((raw, index) => {
    const label = `agreement.extraWorkTypes[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${label} tiene que ser un objeto con code, name, unit y rateCents`);
    }
    const code = requireCode(raw.code, `${label}.code`);
    if (seen.has(code)) throw new Error(`El código «${code}» aparece dos veces en agreement.extraWorkTypes`);
    seen.add(code);
    const unit = String(raw.unit ?? '').trim();
    if (!EXTRA_WORK_UNITS.includes(unit)) {
      throw new Error(`${label}.unit tiene que ser ${EXTRA_WORK_UNITS.join(', ')} (llegó ${JSON.stringify(raw.unit)})`);
    }
    if (raw.rateCents === undefined) {
      throw new Error(
        `${label}.rateCents falta. Escribe la tarifa en céntimos, o null si está pactado sin precio ` +
          'todavía: un concepto sin tarifa existe para quien administra y NO se le enseña a la empleada.'
      );
    }
    const rateCents = requireIntegerOrNull(raw.rateCents, `${label}.rateCents`);
    const reference = raw.referenceMinutes ?? null;
    if (unit === 'per_hour' && reference !== null) {
      throw new Error(`${label}: una tarifa por hora no lleva duración de referencia`);
    }
    if (unit === 'per_shift' && reference === null) {
      throw new Error(`${label}: una jornada necesita decir de cuántos minutos es (referenceMinutes)`);
    }
    const referenceMinutes =
      reference === null ? null : requireInteger(reference, `${label}.referenceMinutes`, { min: 1 });
    if (referenceMinutes !== null && referenceMinutes > 10080) {
      throw new Error(`${label}.referenceMinutes no puede pasar de una semana (10080 minutos)`);
    }
    return {
      code,
      name: requireText(raw.name, `${label}.name`),
      unit,
      rateCents,
      referenceMinutes,
      active: raw.active === undefined ? true : requireBoolean(raw.active, `${label}.active`)
    };
  });
}

/**
 * Complementos periódicos. `addsToPay` no tiene valor por defecto a propósito,
 * por la misma razón que en la pantalla: un defecto silencioso aquí es una
 * transferencia inflada o mermada todos los meses.
 */
export function normalizeSupplements(agreement) {
  const declared = agreement?.supplements ?? [];
  if (!Array.isArray(declared)) {
    throw new Error('agreement.supplements tiene que ser una lista');
  }
  const seen = new Set();
  return declared.map((raw, index) => {
    const label = `agreement.supplements[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${label} tiene que ser un objeto con code, name, amountCents y addsToPay`);
    }
    const code = requireCode(raw.code, `${label}.code`);
    if (seen.has(code)) throw new Error(`El código «${code}» aparece dos veces en agreement.supplements`);
    seen.add(code);
    if (raw.amountCents === undefined) {
      throw new Error(`${label}.amountCents falta. Escribe el importe mensual en céntimos, o null si no lo hay.`);
    }
    if (raw.addsToPay === undefined) {
      throw new Error(
        `${label}.addsToPay falta y no tiene valor por defecto: di si el complemento es dinero para ` +
          'ella (true, suma a la transferencia del mes) o un gasto que asume la casa (false, consta ' +
          'como condición y no toca la transferencia).'
      );
    }
    const startsOn = optionalIsoDate(raw.startsOn, `${label}.startsOn`);
    const endsOn = optionalIsoDate(raw.endsOn, `${label}.endsOn`);
    if (startsOn && endsOn && endsOn < startsOn) {
      throw new Error(`${label}: la vigencia no puede acabar antes de empezar`);
    }
    return {
      code,
      name: requireText(raw.name, `${label}.name`),
      amountCents: requireIntegerOrNull(raw.amountCents, `${label}.amountCents`),
      periodicity: 'monthly',
      addsToPay: requireBoolean(raw.addsToPay, `${label}.addsToPay`),
      startsOn,
      endsOn,
      active: raw.active === undefined ? true : requireBoolean(raw.active, `${label}.active`)
    };
  });
}

/**
 * Las columnas reliquia de 0002 (`overtime_hourly_rate_cents`,
 * `worked_rest_day_rate_cents`, `worked_rest_day_credit_minutes`) se DERIVAN del
 * catálogo, no se pactan aparte. Tenerlas por duplicado en el fichero es la
 * manera de acabar con una reliquia que contradice al catálogo que la sustituyó.
 *
 * La regla es exactamente la de `insertVersion` en
 * apps/web/src/lib/server/agreement-terms.server.ts: el primer concepto activo
 * de cada familia, y 0 cuando no hay ninguno.
 */
export function relicRates(extraWorkTypes) {
  const hourly = extraWorkTypes.find((type) => type.unit === 'per_hour' && type.active);
  const shift = extraWorkTypes.find((type) => type.unit !== 'per_hour' && type.active);
  return {
    overtimeHourlyRateCents: hourly?.rateCents ?? 0,
    workedRestDayRateCents: shift?.rateCents ?? 0,
    workedRestDayCreditMinutes: shift?.referenceMinutes ?? DEFAULT_REST_DAY_CREDIT_MINUTES
  };
}

/**
 * Valida el JSON y devuelve exactamente lo que hay que escribir. Aquí es donde
 * se cae si falta algo: mejor un error legible antes de tocar la base que una
 * violación de CHECK a medio camino.
 */
export function normalizeAgreementConfig(raw) {
  const slug = String(raw?.household?.slug ?? '').trim();
  if (!slug) throw new Error('El JSON necesita household.slug');

  const agreement = raw?.agreement;
  if (!agreement || typeof agreement !== 'object') {
    throw new Error(
      'El JSON no trae el bloque `agreement`. Añádelo con lo pactado: employeeUsername, startsOn, ' +
        'monthlySalaryCents, contractedWeeklyMinutes, annualVacationDays, schedule y extraWorkTypes.'
    );
  }

  for (const [key, why] of Object.entries(RETIRED_KEYS)) {
    if (agreement[key] !== undefined) {
      throw new Error(
        `agreement.${key} ya no se pacta aquí: ${why} Quítala del JSON y describe lo pactado en ` +
          '`agreement.extraWorkTypes`.'
      );
    }
  }

  const people = Array.isArray(raw.people) ? raw.people : [];
  const byUsername = new Map(
    people
      .filter((person) => typeof person?.username === 'string')
      .map((person) => [person.username.trim().toLowerCase(), person])
  );

  const employeeUsername = String(agreement.employeeUsername ?? '').trim().toLowerCase();
  if (!employeeUsername) throw new Error('El JSON necesita agreement.employeeUsername');
  const employee = byUsername.get(employeeUsername);
  if (!employee) {
    throw new Error(
      `agreement.employeeUsername apunta a «${employeeUsername}», que no está en la lista people del JSON`
    );
  }
  if (!EMPLOYEE_ROLES.includes(String(employee.role ?? '').trim())) {
    throw new Error(
      `«${employeeUsername}» tiene el rol ${employee.role || '(vacío)'}: un acuerdo laboral solo puede ` +
        `firmarse con ${EMPLOYEE_ROLES.join(' o ')}`
    );
  }

  // Por parte de la casa firma quien administra. Si el JSON no dice quién, la
  // primera family_admin de la lista: es la misma que crea las cuentas.
  const declaredCreator = String(agreement.createdByUsername ?? '').trim().toLowerCase();
  let creator;
  if (declaredCreator) {
    creator = byUsername.get(declaredCreator);
    if (!creator) {
      throw new Error(
        `agreement.createdByUsername apunta a «${declaredCreator}», que no está en la lista people del JSON`
      );
    }
    if (String(creator.role ?? '').trim() !== ADMIN_ROLE) {
      throw new Error(`«${declaredCreator}» no es ${ADMIN_ROLE}: no puede dar de alta el acuerdo`);
    }
  } else {
    creator = people.find((person) => String(person?.role ?? '').trim() === ADMIN_ROLE);
    if (!creator) {
      throw new Error(`El hogar necesita al menos una persona con rol ${ADMIN_ROLE} que dé de alta el acuerdo`);
    }
  }

  const startsOn = String(agreement.startsOn ?? '').trim();
  if (!isIsoDate(startsOn)) {
    throw new Error(`agreement.startsOn tiene que ser una fecha AAAA-MM-DD (llegó ${startsOn || '(vacío)'})`);
  }
  // La primera versión entra en vigor el día en que empieza el acuerdo. No es
  // configurable a propósito: una versión 1 posterior al inicio dejaría días
  // trabajados sin condiciones que aplicarles.
  const effectiveFrom = startsOn;

  const currencyCode = String(agreement.currencyCode ?? 'EUR').trim().toUpperCase();
  if (currencyCode !== 'EUR') {
    throw new Error(`Solo se admite EUR (el esquema lo exige); llegó ${currencyCode}`);
  }

  const extraWorkTypes = normalizeExtraWorkTypes(agreement);
  const supplements = normalizeSupplements(agreement);

  return {
    householdSlug: slug,
    employeeUsername,
    employeeEmail: String(employee.email ?? '').trim().toLowerCase(),
    creatorUsername: String(creator.username).trim().toLowerCase(),
    creatorEmail: String(creator.email ?? '').trim().toLowerCase(),
    startsOn,
    version: {
      effectiveFrom,
      monthlySalaryCents: requireInteger(agreement.monthlySalaryCents, 'agreement.monthlySalaryCents'),
      ...relicRates(extraWorkTypes),
      contractedWeeklyMinutes: requireInteger(
        agreement.contractedWeeklyMinutes,
        'agreement.contractedWeeklyMinutes',
        { min: 1 }
      ),
      annualVacationDays: requireInteger(agreement.annualVacationDays, 'agreement.annualVacationDays'),
      currencyCode,
      terms: (() => {
        const schedule = scheduleToText(agreement.schedule);
        if (!schedule) {
          throw new Error(
            'agreement.schedule está vacío: las condiciones de horario son parte de lo pactado y quedan ' +
              'escritas en el contrato (terms.schedule). Ponlas como texto o por campos (from, to, ' +
              'longBreakMinutes, effectiveHoursPerDay, weekly).'
          );
        }
        return { schedule };
      })(),
      // El mismo horario, además, como dato consultable (0025). null cuando el
      // JSON solo trae la frase: de una frase no se deduce un horario sin
      // inventar.
      schedule: scheduleToStructured(agreement.schedule),
      reason: String(agreement.reason ?? DEFAULT_REASON).trim() || DEFAULT_REASON,
      extraWorkTypes,
      supplements
    }
  };
}

/** Membresía viva de una persona del hogar, buscada por su correo del JSON. */
async function findMembership(client, householdId, { username, email }) {
  if (!email) {
    throw new Error(`«${username}» no trae correo en el JSON y es lo que identifica su perfil`);
  }
  const { rows } = await client.query(
    `select membership.id, membership.role::text as role
       from app.household_memberships as membership
       join app.user_profiles as profile on profile.user_id = membership.user_id
      where membership.household_id = $1
        and lower(profile.email) = $2
        and membership.revoked_at is null`,
    [householdId, email]
  );
  if (rows.length === 0) {
    throw new Error(
      `«${username}» no tiene membresía viva en el hogar. Ejecuta antes el alta de cuentas ` +
        '(pnpm --filter @casa-clara/web seed:accounts --config …) con este mismo JSON.'
    );
  }
  if (rows.length > 1) {
    throw new Error(`«${username}» tiene más de una membresía con ese correo en el hogar; resuélvelo a mano`);
  }
  return rows[0];
}

/**
 * jsonb no conserva el orden de las claves, así que comparar dos objetos por su
 * JSON literal daría falsos negativos. Se ordenan antes de comparar.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * ¿El horario ya escrito en esa versión es exactamente el del JSON?
 *
 * «Ninguno a ninguno» también cuadra: un contrato sin horario declarado y un
 * JSON que no lo declara dicen lo mismo. Lo que NO cuadra es que uno diga algo
 * y el otro calle, y ahí el guion se planta: añadir un horario a una versión ya
 * pactada es cambiar el contrato, y eso se hace apilando versión desde la
 * aplicación, con autoría y motivo.
 */
async function scheduleMatches(client, householdId, versionId, wanted) {
  const { rows } = await client.query(
    `select id,
            to_char(starts_at, 'HH24:MI') as starts_at,
            to_char(ends_at, 'HH24:MI') as ends_at,
            long_break_minutes, note
       from app.agreement_schedules
      where household_id = $1 and agreement_version_id = $2`,
    [householdId, versionId]
  );
  const existing = rows[0] ?? null;
  if (!existing || !wanted) return existing === null && !wanted;

  if (
    existing.starts_at !== wanted.startsAt ||
    existing.ends_at !== wanted.endsAt ||
    existing.long_break_minutes !== wanted.longBreakMinutes ||
    (existing.note ?? '') !== wanted.note
  ) {
    return false;
  }

  const days = await client.query(
    `select weekday, works,
            to_char(starts_at, 'HH24:MI') as starts_at,
            to_char(ends_at, 'HH24:MI') as ends_at,
            long_break_minutes, note
       from app.agreement_schedule_days
      where household_id = $1 and schedule_id = $2
      order by weekday`,
    [householdId, existing.id]
  );
  if (days.rowCount !== wanted.days.length) return false;
  return days.rows.every((row, index) => {
    const day = wanted.days[index];
    return (
      row.weekday === day.weekday &&
      row.works === day.works &&
      (row.starts_at ?? null) === day.startsAt &&
      (row.ends_at ?? null) === day.endsAt &&
      (row.long_break_minutes ?? null) === day.longBreakMinutes &&
      (row.note ?? '') === day.note
    );
  });
}

export function versionMatches(existing, wanted) {
  return (
    existing.effective_from === wanted.effectiveFrom &&
    Number(existing.monthly_salary_cents) === wanted.monthlySalaryCents &&
    Number(existing.overtime_hourly_rate_cents) === wanted.overtimeHourlyRateCents &&
    Number(existing.worked_rest_day_rate_cents) === wanted.workedRestDayRateCents &&
    existing.worked_rest_day_credit_minutes === wanted.workedRestDayCreditMinutes &&
    existing.contracted_weekly_minutes === wanted.contractedWeeklyMinutes &&
    existing.annual_vacation_days === wanted.annualVacationDays &&
    existing.currency_code === wanted.currencyCode &&
    canonicalJson(existing.terms ?? {}) === canonicalJson(wanted.terms)
  );
}

/**
 * El catálogo entra en la comparación de idempotencia. Sin esto, cambiar una
 * tarifa en el JSON y volver a ejecutar diría «no se ha escrito nada» y dejaría
 * al fichero y a la base contando cosas distintas, que es la avería que este
 * guion existe para no tener.
 *
 * Se compara por CÓDIGO, no por posición: reordenar la lista del fichero no es
 * cambiar lo pactado.
 */
export function catalogueMatches(existing, wanted) {
  const byCode = (rows) => new Map(rows.map((row) => [row.code, row]));
  if (existing.types.length !== wanted.extraWorkTypes.length) return false;
  if (existing.supplements.length !== wanted.supplements.length) return false;

  const existingTypes = byCode(existing.types);
  for (const type of wanted.extraWorkTypes) {
    const found = existingTypes.get(type.code);
    if (!found) return false;
    if (
      found.name !== type.name ||
      found.unit !== type.unit ||
      (found.rate_cents === null ? null : Number(found.rate_cents)) !== type.rateCents ||
      found.reference_minutes !== type.referenceMinutes ||
      found.active !== type.active
    ) {
      return false;
    }
  }

  const existingSupplements = byCode(existing.supplements);
  for (const supplement of wanted.supplements) {
    const found = existingSupplements.get(supplement.code);
    if (!found) return false;
    if (
      found.name !== supplement.name ||
      (found.amount_cents === null ? null : Number(found.amount_cents)) !== supplement.amountCents ||
      found.periodicity !== supplement.periodicity ||
      found.adds_to_pay !== supplement.addsToPay ||
      found.starts_on !== supplement.startsOn ||
      found.ends_on !== supplement.endsOn ||
      found.active !== supplement.active
    ) {
      return false;
    }
  }
  return true;
}

async function readCatalogue(client, householdId, agreementVersionId) {
  const types = await client.query(
    `select code, name, unit::text as unit, rate_cents::text as rate_cents,
            reference_minutes, active
       from app.extra_work_types
      where household_id = $1 and agreement_version_id = $2
      order by sort_order, code`,
    [householdId, agreementVersionId]
  );
  const supplements = await client.query(
    `select code, name, amount_cents::text as amount_cents, periodicity::text as periodicity,
            adds_to_pay, starts_on::text as starts_on, ends_on::text as ends_on, active
       from app.recurring_supplements
      where household_id = $1 and agreement_version_id = $2
      order by sort_order, code`,
    [householdId, agreementVersionId]
  );
  return { types: types.rows, supplements: supplements.rows };
}

/**
 * Da de alta el acuerdo, su primera versión y el catálogo de esa versión.
 * Devuelve un informe de lo hecho; no imprime nada (eso es de
 * `printAgreementReport`).
 */
export async function seedEmploymentAgreement(client, config, { dryRun = false } = {}) {
  const household = await client.query('select id, display_name from app.households where slug = $1', [
    config.householdSlug
  ]);
  const householdRow = household.rows[0];
  if (!householdRow) {
    throw new Error(
      `No existe ningún hogar con slug «${config.householdSlug}». Ejecuta antes el alta de cuentas.`
    );
  }
  const householdId = householdRow.id;

  const employee = await findMembership(client, householdId, {
    username: config.employeeUsername,
    email: config.employeeEmail
  });
  if (!EMPLOYEE_ROLES.includes(employee.role)) {
    throw new Error(
      `La membresía de «${config.employeeUsername}» en el hogar tiene rol ${employee.role}; ` +
        `un acuerdo laboral solo puede firmarse con ${EMPLOYEE_ROLES.join(' o ')}`
    );
  }
  const creator = await findMembership(client, householdId, {
    username: config.creatorUsername,
    email: config.creatorEmail
  });
  if (creator.role !== ADMIN_ROLE) {
    throw new Error(
      `La membresía de «${config.creatorUsername}» en el hogar tiene rol ${creator.role}: no puede dar de alta el acuerdo`
    );
  }

  const existing = await client.query(
    `select id, starts_on::text as starts_on
       from app.employment_agreements
      where household_id = $1 and employee_membership_id = $2 and status = 'active'`,
    [householdId, employee.id]
  );
  const existingAgreement = existing.rows[0] ?? null;

  const summary = {
    extraWorkTypes: config.version.extraWorkTypes.length,
    registrableTypes: config.version.extraWorkTypes.filter(
      (type) => type.active && type.rateCents !== null
    ).length,
    supplements: config.version.supplements.length,
    // El horario (0025) y la jornada contratada viajan en el informe para que
    // `printAgreementReport` pueda decir si cuadran ANTES de que nadie lo note.
    schedule: config.version.schedule,
    contractedWeeklyMinutes: config.version.contractedWeeklyMinutes
  };

  if (existingAgreement) {
    if (existingAgreement.starts_on !== config.startsOn) {
      throw new Error(
        `«${config.employeeUsername}» ya tiene un acuerdo activo que empezó el ${existingAgreement.starts_on}, ` +
          `y el JSON dice ${config.startsOn}. Un acuerdo activo no se reescribe: ciérralo desde la aplicación ` +
          'y da de alta el nuevo.'
      );
    }
    const versions = await client.query(
      `select id, version_number, effective_from::text as effective_from,
              monthly_salary_cents::text as monthly_salary_cents,
              overtime_hourly_rate_cents::text as overtime_hourly_rate_cents,
              worked_rest_day_rate_cents::text as worked_rest_day_rate_cents,
              worked_rest_day_credit_minutes, contracted_weekly_minutes,
              annual_vacation_days, currency_code, terms
         from app.agreement_versions
        where household_id = $1 and agreement_id = $2
        order by version_number`,
      [householdId, existingAgreement.id]
    );
    const first = versions.rows[0] ?? null;
    if (first) {
      const immutable =
        `El contrato de «${config.employeeUsername}» ya tiene una primera versión con condiciones distintas ` +
        'a las del JSON. Las versiones son inmutables: para cambiar lo pactado se añade una versión nueva ' +
        'desde la aplicación (Contrato → Administrar el contrato), con autoría y motivo. Este guion solo da el alta.';
      if (!versionMatches(first, config.version)) throw new Error(immutable);
      // El horario también es lo pactado. Un hogar dado de alta ANTES de 0025 no
      // tiene filas de horario: reenviar el guion con un horario nuevo no se las
      // añade por la puerta de atrás, porque eso sería cambiar el contrato sin
      // versión, sin autoría y sin motivo.
      if (!(await scheduleMatches(client, householdId, first.id, config.version.schedule))) {
        throw new Error(immutable);
      }
      const catalogue = await readCatalogue(client, householdId, first.id);
      if (!catalogueMatches(catalogue, config.version)) {
        throw new Error(
          `El acuerdo de «${config.employeeUsername}» ya existe, pero su catálogo de conceptos no es el del ` +
            'JSON. El catálogo se congela con su versión y tampoco se reescribe: para cambiar una tarifa, ' +
            'desactivar un concepto o añadir uno nuevo se apila una versión nueva desde la aplicación ' +
            '(Contrato → «Administrar el contrato»).'
        );
      }
      return {
        dryRun,
        householdId,
        householdName: householdRow.display_name,
        agreementId: existingAgreement.id,
        agreementCreated: false,
        versionCreated: false,
        versionCount: versions.rowCount,
        employeeMembershipId: employee.id,
        ...summary
      };
    }
    // Acuerdo sin versiones: estado imposible por la aplicación, posible si
    // alguien lo insertó a mano. Se completa con la versión 1 que falta.
    if (!dryRun) {
      await insertFirstVersion(client, householdId, existingAgreement.id, creator.id, config.version);
    }
    return {
      dryRun,
      householdId,
      householdName: householdRow.display_name,
      agreementId: existingAgreement.id,
      agreementCreated: false,
      versionCreated: true,
      versionCount: 1,
      employeeMembershipId: employee.id,
      ...summary
    };
  }

  if (dryRun) {
    return {
      dryRun,
      householdId,
      householdName: householdRow.display_name,
      agreementId: null,
      agreementCreated: true,
      versionCreated: true,
      versionCount: 1,
      employeeMembershipId: employee.id,
      ...summary
    };
  }

  const inserted = await client.query(
    `insert into app.employment_agreements
       (household_id, employee_membership_id, starts_on, created_by_membership_id)
     values ($1, $2, $3, $4)
     returning id`,
    [householdId, employee.id, config.startsOn, creator.id]
  );
  const agreementId = inserted.rows[0].id;
  await insertFirstVersion(client, householdId, agreementId, creator.id, config.version);

  return {
    dryRun,
    householdId,
    householdName: householdRow.display_name,
    agreementId,
    agreementCreated: true,
    versionCreated: true,
    versionCount: 1,
    employeeMembershipId: employee.id,
    ...summary
  };
}

/**
 * Versión 1 y su catálogo, en la misma sentencia lógica. El orden y los valores
 * son los de `insertVersion` en la pantalla de administración: las columnas
 * reliquia se escriben derivadas del catálogo para que ningún lector anterior a
 * 0021 lea un número que el catálogo contradiga.
 */
async function insertFirstVersion(client, householdId, agreementId, createdByMembershipId, version) {
  const versionRow = await client.query(
    `insert into app.agreement_versions
       (household_id, agreement_id, version_number, effective_from,
        monthly_salary_cents, overtime_hourly_rate_cents, worked_rest_day_rate_cents,
        worked_rest_day_credit_minutes, contracted_weekly_minutes, annual_vacation_days,
        currency_code, terms, reason, created_by_membership_id)
     values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
     returning id`,
    [
      householdId,
      agreementId,
      version.effectiveFrom,
      version.monthlySalaryCents,
      version.overtimeHourlyRateCents,
      version.workedRestDayRateCents,
      version.workedRestDayCreditMinutes,
      version.contractedWeeklyMinutes,
      version.annualVacationDays,
      version.currencyCode,
      JSON.stringify(version.terms),
      version.reason,
      createdByMembershipId
    ]
  );
  const versionId = versionRow.rows[0].id;

  let order = 0;
  for (const type of version.extraWorkTypes) {
    order += 10;
    await client.query(
      `insert into app.extra_work_types
         (household_id, agreement_id, agreement_version_id, code, name, unit, rate_cents,
          reference_minutes, active, sort_order, created_by_membership_id)
       values ($1, $2, $3, $4, $5, $6::app.extra_work_unit, $7, $8, $9, $10, $11)`,
      [
        householdId,
        agreementId,
        versionId,
        type.code,
        type.name,
        type.unit,
        type.rateCents,
        type.referenceMinutes,
        type.active,
        order,
        createdByMembershipId
      ]
    );
  }

  order = 0;
  for (const supplement of version.supplements) {
    order += 10;
    await client.query(
      `insert into app.recurring_supplements
         (household_id, agreement_id, agreement_version_id, code, name, amount_cents,
          periodicity, adds_to_pay, starts_on, ends_on, active, sort_order,
          created_by_membership_id)
       values ($1, $2, $3, $4, $5, $6, $7::app.supplement_periodicity, $8, $9, $10, $11, $12, $13)`,
      [
        householdId,
        agreementId,
        versionId,
        supplement.code,
        supplement.name,
        supplement.amountCents,
        supplement.periodicity,
        supplement.addsToPay,
        supplement.startsOn,
        supplement.endsOn,
        supplement.active,
        order,
        createdByMembershipId
      ]
    );
  }

  // Y el horario de esa misma versión (0025), en la misma transacción que todo
  // lo demás: o entra el contrato entero o no entra nada.
  await insertSchedule(client, householdId, agreementId, versionId, createdByMembershipId, version.schedule);

  return versionId;
}

/** El horario de la versión recién creada. Sin horario declarado no escribe nada. */
async function insertSchedule(
  client,
  householdId,
  agreementId,
  versionId,
  createdByMembershipId,
  schedule
) {
  if (!schedule) return;
  const inserted = await client.query(
    `insert into app.agreement_schedules
       (household_id, agreement_id, agreement_version_id, starts_at, ends_at,
        long_break_minutes, note, created_by_membership_id)
     values ($1, $2, $3, $4::time, $5::time, $6, $7, $8)
     returning id`,
    [
      householdId,
      agreementId,
      versionId,
      schedule.startsAt,
      schedule.endsAt,
      schedule.longBreakMinutes,
      schedule.note,
      createdByMembershipId
    ]
  );
  const scheduleId = inserted.rows[0].id;
  for (const day of schedule.days) {
    await client.query(
      `insert into app.agreement_schedule_days
         (household_id, agreement_id, schedule_id, weekday, works, starts_at, ends_at,
          long_break_minutes, note, created_by_membership_id)
       values ($1, $2, $3, $4, $5, $6::time, $7::time, $8, $9, $10)`,
      [
        householdId,
        agreementId,
        scheduleId,
        day.weekday,
        day.works,
        day.startsAt,
        day.endsAt,
        day.longBreakMinutes,
        day.note,
        createdByMembershipId
      ]
    );
  }
}

export function printAgreementReport(report) {
  const mode = report.dryRun ? '[dry-run] ' : '';
  console.log(`${mode}Hogar ${report.householdName} → ${report.householdId}`);
  if (report.agreementCreated) {
    console.log(`${mode}contrato creado${report.agreementId ? ` → ${report.agreementId}` : ''} con su versión 1`);
  } else if (report.versionCreated) {
    console.log(`${mode}contrato existente → ${report.agreementId}; le faltaba la versión 1 y se ha creado`);
  } else {
    console.log(
      `${mode}contrato ya dado de alta → ${report.agreementId} (${report.versionCount} versión(es)); no se ha escrito nada`
    );
  }

  /*
   * El horario, y si no cuadra con la jornada contratada, se DICE. No aborta:
   * el guion no está para decidir cuál de las dos condiciones está mal, sino
   * para que nadie se entere seis meses después. Es la misma regla que aplica la
   * pantalla de administración.
   */
  if (!report.schedule) {
    console.log(`${mode}sin horario consultable: la empleada no verá sección de horario`);
    return;
  }
  const weekly = weeklyEffectiveMinutes(report.schedule);
  const hours = (minutes) =>
    `${Math.trunc(Math.abs(minutes) / 60)} h${Math.abs(minutes) % 60 > 0 ? ` ${Math.abs(minutes) % 60} min` : ''}`;
  console.log(
    `${mode}horario ${report.schedule.startsAt}–${report.schedule.endsAt}` +
      `${report.schedule.days.length > 0 ? ` con ${report.schedule.days.length} día(s) aparte` : ''}` +
      ` → ${hours(weekly)} a la semana`
  );
  if (weekly !== report.contractedWeeklyMinutes) {
    const difference = weekly - report.contractedWeeklyMinutes;
    console.warn(
      `${mode}AVISO: el horario suma ${hours(weekly)} y la jornada contratada dice ` +
        `${hours(report.contractedWeeklyMinutes)}: ${difference > 0 ? 'sobran' : 'faltan'} ${hours(difference)}. ` +
        'Se ha guardado tal cual; revisad cuál de las dos condiciones hay que cambiar.'
    );
  }
  console.log(
    `${mode}catálogo: ${report.extraWorkTypes} concepto(s) de trabajo extra ` +
      `(${report.registrableTypes} registrable(s) por ella) y ${report.supplements} complemento(s)`
  );
  if (report.registrableTypes === 0) {
    console.log(
      `${mode}AVISO: ningún concepto activo y con tarifa. Con este acuerdo la empleada no podrá ` +
        'registrar ninguna jornada extra mientras rija esta versión, y eso no se arregla hacia ' +
        'atrás. Si no era lo que querías, revisa `extraWorkTypes` ANTES de ejecutar sin --dry-run.'
    );
  }
}

function parseArgs(argv) {
  const args = { config: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    // Un `--` suelto es el separador que algunos gestores de paquetes exigen y
    // otros reenvían tal cual; que no sea un error de escritura.
    if (flag === '--') continue;
    else if (flag === '--config') args.config = argv[++i];
    else if (flag.startsWith('--config=')) args.config = flag.slice('--config='.length);
    else if (flag === '--dry-run') args.dryRun = true;
    // Se sigue reconociendo para poder explicar adónde se fue, en vez de soltar
    // «argumento desconocido» a quien copió el comando de la documentación vieja.
    else if (flag === '--overtime-hourly-rate-cents' || flag.startsWith('--overtime-hourly-rate-cents=')) {
      throw new Error(OVERTIME_FLAG_RETIRED_MESSAGE);
    } else throw new Error(`argumento desconocido: ${flag}`);
  }
  if (!args.config) throw new Error('Falta --config <ruta al JSON del hogar>');
  return args;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  let client;
  try {
    const args = parseArgs(process.argv.slice(2));
    const raw = JSON.parse(await readFile(path.resolve(args.config), 'utf8'));
    const config = normalizeAgreementConfig(raw);
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL es obligatoria (rol admin/propietario de migraciones)');
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('begin');
    // El propietario de las migraciones puede saltar FORCE RLS explícitamente,
    // igual que hace el alta de cuentas.
    await client.query('set local row_security = off');
    let report;
    try {
      report = await seedEmploymentAgreement(client, config, { dryRun: args.dryRun });
      if (args.dryRun) await client.query('rollback');
      else await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    printAgreementReport(report);
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
  } finally {
    await client?.end();
  }
}
