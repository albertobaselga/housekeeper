import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { Pool } from "pg";

import { PermanentJobError, type JobHandler } from "./queue.js";

export const ICS_SYNC_JOB = "ics.sync_source";
export const ICS_SYNC_ALL_JOB = "ics.sync_all";

export const ICS_MAX_REDIRECTS = 3;
export const ICS_TIMEOUT_MS = 10_000;
export const ICS_MAX_BYTES = 1_048_576; // 1 MiB

/** Cadencia del ciclo periódico de sincronización de fuentes. */
export const ICS_SYNC_INTERVAL_HOURS = 6;

/** Ventana de expansión/retención de ocurrencias: [ahora−7d, ahora+90d]. */
export const ICS_WINDOW_PAST_DAYS = 7;
export const ICS_WINDOW_FUTURE_DAYS = 90;

/** Topes de expansión (espejo del tope de la función definer de la 0015). */
export const ICS_MAX_OCCURRENCES_PER_EVENT = 500;
export const ICS_MAX_OCCURRENCES_PER_SOURCE = 2000;

/**
 * Zona horaria del hogar. La aplicación entera opera en Europe/Madrid (mismo
 * criterio que today.server.ts en la web); las horas «flotantes» de un ICS sin
 * TZID y los eventos de día completo se interpretan en esta zona.
 */
export const ICS_DEFAULT_TIME_ZONE = "Europe/Madrid";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Una ocurrencia ya expandida de un evento de fuente ICS, lista para el upsert
 * de `app_private.replace_ics_source_events` (0015). `startsAt`/`endsAt` son
 * instantes UTC; `contentHash` permite reescribir solo lo que cambió.
 */
export interface IcsOccurrence {
  uid: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  summary: string;
  location: string | null;
  contentHash: string;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface IcsFetchDeps {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  now?: () => Date;
}

function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true });
}

/** ¿Es una dirección IPv4 privada, loopback, link-local o de metadatos? */
function isForbiddenIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true; // Una IP que no se deja interpretar no se contacta.
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 ("esta red")
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local y metadatos cloud
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) // 192.168.0.0/16
  );
}

/** ¿Es una dirección IPv6 privada/loopback/link-local (o un mapeo de una IPv4 prohibida)? */
function isForbiddenIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  // IPv4 embebida: ::ffff:127.0.0.1 y similares.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isForbiddenIpv4(mapped[1] as string);
  if (normalized === "::" || normalized === "::1") return true; // no especificada / loopback
  const firstGroup = normalized.split(":", 1)[0] ?? "";
  const value = firstGroup === "" ? 0 : Number.parseInt(firstGroup, 16);
  if (Number.isNaN(value)) return true;
  if ((value & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((value & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

export function isForbiddenAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isForbiddenIpv4(address);
  if (version === 6) return isForbiddenIpv6(address);
  return true;
}

/**
 * Valida una URL de fuente ICS contra SSRF: solo https y solo hosts cuyo DNS
 * resuelva íntegramente a direcciones públicas (un solo registro privado
 * descarta el host entero). Los literales IP pasan por la misma comprobación
 * porque `lookup` también los resuelve.
 */
async function assertPublicHttpsUrl(
  rawUrl: string,
  lookup: (hostname: string) => Promise<ResolvedAddress[]>,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PermanentJobError(`URL de fuente ICS inválida: ${rawUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new PermanentJobError("Las fuentes ICS solo admiten https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new PermanentJobError("La URL de la fuente no admite credenciales embebidas");
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    throw new PermanentJobError(`El host de la fuente ICS no resuelve: ${url.hostname}`);
  }
  if (addresses.length === 0) {
    throw new PermanentJobError(`El host de la fuente ICS no resuelve: ${url.hostname}`);
  }
  for (const { address } of addresses) {
    if (isForbiddenAddress(address)) {
      throw new PermanentJobError(
        `El host de la fuente ICS resuelve a una dirección no pública: ${address}`,
      );
    }
  }
  return url;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PermanentJobError(`La fuente ICS supera el tamaño máximo (${maxBytes} bytes)`);
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new PermanentJobError(`La fuente ICS supera el tamaño máximo (${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Descarga una fuente ICS externa con protección SSRF (solo https, DNS con
 * veto de rangos privados/loopback/link-local/metadatos, redirects manuales
 * revalidados uno a uno, timeout de 10 s, cuerpo ≤ 1 MiB) y la expande a
 * ocurrencias dentro de la ventana [ahora−7d, ahora+90d].
 */
export async function fetchIcsSource(rawUrl: string, deps: IcsFetchDeps = {}): Promise<IcsOccurrence[]> {
  const fetchImpl = deps.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  const lookup = deps.lookup ?? defaultLookup;
  const timeoutMs = deps.timeoutMs ?? ICS_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? ICS_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? ICS_MAX_REDIRECTS;
  const now = deps.now ?? (() => new Date());

  let current = await assertPublicHttpsUrl(rawUrl, lookup);
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(current.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/calendar, text/plain;q=0.5" },
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      if (hop >= maxRedirects) {
        throw new PermanentJobError("La fuente ICS excede el máximo de redirecciones");
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new PermanentJobError("Redirección de la fuente ICS sin destino");
      }
      // Cada destino se revalida entero (https + DNS público) antes de saltar.
      current = await assertPublicHttpsUrl(new URL(location, current).toString(), lookup);
      continue;
    }
    if (!response.ok) {
      throw new Error(`La fuente ICS respondió ${response.status}`);
    }
    return expandIcs(await readBodyCapped(response, maxBytes), now());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser ICS mínimo propio (sin dependencias): VEVENT con UID, DTSTART/DTEND
// (zona TZID, VALUE=DATE, UTC y hora flotante), SUMMARY, LOCATION, RRULE
// simple (DAILY/WEEKLY/MONTHLY con INTERVAL/COUNT/UNTIL y BYDAY solo en
// WEEKLY) y EXDATE.
//
// Límites documentados de la expansión:
// - FREQ distintos de DAILY/WEEKLY/MONTHLY (YEARLY, HOURLY…) o modificadores
//   no soportados (BYMONTHDAY, BYSETPOS, WKST…) degradan a UNA sola
//   ocurrencia en el DTSTART base.
// - RECURRENCE-ID (ocurrencias movidas de sitio) se ignora: la ocurrencia
//   original sigue pintándose y la movida aparece como evento aparte.
// - DURATION no se interpreta (solo DTEND); sin DTEND el evento no tiene fin.
// - Un TZID desconocido para Intl degrada a la zona del hogar.
// - La hora flotante (sin Z ni TZID) se interpreta en la zona del hogar.
// ─────────────────────────────────────────────────────────────────────────────

interface IcsDateValue {
  raw: string;
  tzid: string | null;
  isDate: boolean;
}

interface RawVevent {
  uid: string | null;
  dtstart: IcsDateValue | null;
  dtend: IcsDateValue | null;
  summary: string | null;
  location: string | null;
  rrule: string | null;
  exdates: IcsDateValue[];
}

/** Despliega las líneas plegadas de un ICS (continuación con espacio o tab). */
function unfoldIcsLines(text: string): string[] {
  return text
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\([\\;,])/g, "$1");
}

function parseParams(rawParams: string[]): Map<string, string> {
  const params = new Map<string, string>();
  for (const param of rawParams) {
    const eq = param.indexOf("=");
    if (eq < 0) continue;
    params.set(param.slice(0, eq).toUpperCase(), param.slice(eq + 1).replace(/^"|"$/g, ""));
  }
  return params;
}

function toDateValue(value: string, params: Map<string, string>): IcsDateValue {
  return {
    raw: value.trim(),
    tzid: params.get("TZID") ?? null,
    isDate: params.get("VALUE") === "DATE" || /^\d{8}$/.test(value.trim()),
  };
}

/** Recorre los bloques VEVENT y devuelve sus propiedades crudas relevantes. */
export function parseIcsEvents(text: string): RawVevent[] {
  const events: RawVevent[] = [];
  let current: RawVevent | null = null;
  for (const line of unfoldIcsLines(text)) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      current = { uid: null, dtstart: null, dtend: null, summary: null, location: null, rrule: null, exdates: [] };
      continue;
    }
    if (/^END:VEVENT$/i.test(line)) {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const [name = "", ...rawParams] = line.slice(0, separator).split(";");
    const upper = name.toUpperCase();
    const params = parseParams(rawParams);
    const value = line.slice(separator + 1);
    if (upper === "UID") current.uid = value.trim();
    else if (upper === "DTSTART") current.dtstart = toDateValue(value, params);
    else if (upper === "DTEND") current.dtend = toDateValue(value, params);
    else if (upper === "SUMMARY") current.summary = unescapeIcsText(value).trim();
    else if (upper === "LOCATION") current.location = unescapeIcsText(value).trim();
    else if (upper === "RRULE") current.rrule = value.trim();
    else if (upper === "EXDATE") {
      for (const piece of value.split(",")) {
        if (piece.trim().length > 0) current.exdates.push(toDateValue(piece, params));
      }
    }
  }
  return events;
}

// ─── Conversión de fechas ICS a instantes UTC ────────────────────────────────

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    // Lanza RangeError si la zona no existe: el llamante degrada a la del hogar.
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function tzOffsetMs(epochMs: number, timeZone: string): number {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(epochMs));
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second"));
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Hora de pared en una zona IANA → instante UTC. Dos pasadas de corrección de
 * offset convergen siempre salvo en la hora inexistente del salto de DST, que
 * queda resuelta hacia el offset previo (suficiente para una agenda doméstica).
 */
function wallPartsToEpoch(parts: WallParts, timeZone: string): number {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let epoch = utcGuess - tzOffsetMs(utcGuess, timeZone);
  epoch = utcGuess - tzOffsetMs(epoch, timeZone);
  return epoch;
}

function parseWallParts(raw: string): { parts: WallParts; isUtc: boolean; hasTime: boolean } | null {
  const match = DATE_TIME_PATTERN.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  return {
    parts: {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour ?? "0"),
      minute: Number(minute ?? "0"),
      second: Number(second ?? "0"),
    },
    isUtc: utc === "Z",
    hasTime: hour !== undefined,
  };
}

/**
 * Valor de fecha ICS → epoch UTC. Reglas: `Z` es UTC directo; TZID válido usa
 * esa zona (uno desconocido degrada a la del hogar); VALUE=DATE es medianoche
 * del hogar; la hora flotante se interpreta en la zona del hogar.
 */
export function icsValueToEpoch(value: IcsDateValue, defaultTimeZone = ICS_DEFAULT_TIME_ZONE): number | null {
  const parsed = parseWallParts(value.raw);
  if (!parsed) return null;
  if (parsed.hasTime && parsed.isUtc) {
    const p = parsed.parts;
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  const timeZone = value.tzid ?? defaultTimeZone;
  try {
    return wallPartsToEpoch(parsed.parts, timeZone);
  } catch {
    return wallPartsToEpoch(parsed.parts, defaultTimeZone);
  }
}

// ─── RRULE simple ────────────────────────────────────────────────────────────

interface SimpleRrule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  count: number | null;
  untilMs: number | null;
  /** Solo WEEKLY: días de la semana (0=domingo … 6=sábado, como Date.getUTCDay). */
  byday: number[] | null;
}

const BYDAY_TO_WEEKDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const SUPPORTED_RRULE_PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY"]);

/**
 * RRULE → regla simple soportada, o null si la regla usa algo fuera del
 * subconjunto (el evento degrada entonces a su ocurrencia base).
 */
export function parseSimpleRrule(raw: string, defaultTimeZone = ICS_DEFAULT_TIME_ZONE): SimpleRrule | null {
  const fields = new Map<string, string>();
  for (const piece of raw.split(";")) {
    const eq = piece.indexOf("=");
    if (eq < 0) return null;
    fields.set(piece.slice(0, eq).toUpperCase(), piece.slice(eq + 1));
  }
  for (const key of fields.keys()) {
    if (!SUPPORTED_RRULE_PARTS.has(key)) return null;
  }
  const freq = fields.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") return null;
  const interval = Number(fields.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) return null;
  const rawCount = fields.get("COUNT");
  const count = rawCount === undefined ? null : Number(rawCount);
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;
  let untilMs: number | null = null;
  const rawUntil = fields.get("UNTIL");
  if (rawUntil !== undefined) {
    const parsed = parseWallParts(rawUntil);
    if (!parsed) return null;
    untilMs = parsed.hasTime
      ? icsValueToEpoch({ raw: rawUntil, tzid: null, isDate: false }, defaultTimeZone)
      : // UNTIL de solo fecha es inclusivo: cubre el día entero en la zona del hogar.
        icsValueToEpoch({ raw: rawUntil, tzid: null, isDate: true }, defaultTimeZone)! + DAY_MS - 1;
    if (untilMs === null) return null;
  }
  let byday: number[] | null = null;
  const rawByday = fields.get("BYDAY");
  if (rawByday !== undefined) {
    if (freq !== "WEEKLY") return null; // BYDAY con orden (1MO) o fuera de WEEKLY: no soportado.
    byday = [];
    for (const token of rawByday.split(",")) {
      const weekday = BYDAY_TO_WEEKDAY[token.trim().toUpperCase()];
      if (weekday === undefined) return null;
      byday.push(weekday);
    }
    if (byday.length === 0) return null;
  }
  return { freq, interval, count, untilMs, byday };
}

/** Días de un mes (aritmética UTC pura). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Expande la regla desde las partes de pared del DTSTART, convirtiendo cada
 * ocurrencia a epoch en su zona (así un evento diario de las 09:00 sigue
 * siendo a las 09:00 locales al cruzar un cambio de hora).
 */
function* ruleOccurrences(start: WallParts, timeZone: string, rule: SimpleRrule): Generator<number> {
  const addDays = (parts: WallParts, days: number): WallParts => {
    const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    return { ...parts, year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
  };
  if (rule.freq === "DAILY") {
    for (let index = 0; ; index += 1) {
      yield wallPartsToEpoch(addDays(start, index * rule.interval), timeZone);
    }
  } else if (rule.freq === "WEEKLY") {
    const startWeekday = new Date(Date.UTC(start.year, start.month - 1, start.day)).getUTCDay();
    const weekdays = [...new Set(rule.byday ?? [startWeekday])].sort(
      // La semana ICS por defecto empieza en lunes (WKST=MO): el domingo cierra la semana.
      (a, b) => ((a + 6) % 7) - ((b + 6) % 7),
    );
    const weekStart = addDays(start, -((startWeekday + 6) % 7)); // lunes de la semana del DTSTART
    for (let week = 0; ; week += 1) {
      for (const weekday of weekdays) {
        const candidate = addDays(weekStart, week * rule.interval * 7 + ((weekday + 6) % 7));
        const epoch = wallPartsToEpoch(candidate, timeZone);
        // Nada anterior al propio DTSTART (BYDAY puede caer antes en la primera semana).
        if (epoch >= wallPartsToEpoch(start, timeZone)) yield epoch;
      }
    }
  } else {
    for (let index = 0; ; index += 1) {
      const total = start.month - 1 + index * rule.interval;
      const year = start.year + Math.floor(total / 12);
      const month = (total % 12) + 1;
      // Regla RFC: los meses sin ese día (p. ej. 31) se saltan.
      if (start.day > daysInMonth(year, month)) continue;
      yield wallPartsToEpoch({ ...start, year, month }, timeZone);
    }
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function occurrenceHash(occurrence: Omit<IcsOccurrence, "contentHash">): string {
  return sha256Hex(
    [
      occurrence.uid,
      occurrence.startsAt,
      occurrence.endsAt ?? "",
      occurrence.allDay ? "1" : "0",
      occurrence.summary,
      occurrence.location ?? "",
    ].join("|"),
  );
}

/**
 * ICS completo → ocurrencias dentro de la ventana [now−7d, now+90d], con las
 * RRULE simples expandidas (ver límites arriba). Un VEVENT sin DTSTART
 * interpretable o sin título se descarta; sin UID se sintetiza uno estable a
 * partir del contenido. También entran los eventos que empezaron antes de la
 * ventana pero siguen en curso dentro de ella.
 */
export function expandIcs(text: string, now: Date): IcsOccurrence[] {
  const windowStart = now.getTime() - ICS_WINDOW_PAST_DAYS * DAY_MS;
  const windowEnd = now.getTime() + ICS_WINDOW_FUTURE_DAYS * DAY_MS;
  const occurrences: IcsOccurrence[] = [];

  for (const event of parseIcsEvents(text)) {
    if (!event.dtstart || !event.summary || event.summary.length === 0) continue;
    const startParsed = parseWallParts(event.dtstart.raw);
    const baseStart = icsValueToEpoch(event.dtstart);
    if (!startParsed || baseStart === null) continue;
    const allDay = event.dtstart.isDate;
    const baseEnd = event.dtend ? icsValueToEpoch(event.dtend) : null;
    const durationMs = baseEnd !== null && baseEnd > baseStart ? baseEnd - baseStart : null;
    const uid = event.uid && event.uid.length > 0
      ? event.uid
      : `sin-uid-${sha256Hex(`${event.dtstart.raw}|${event.summary}`).slice(0, 32)}`;
    const excluded = new Set(
      event.exdates
        .map((exdate) => icsValueToEpoch(exdate))
        .filter((epoch): epoch is number => epoch !== null),
    );

    const rule = event.rrule ? parseSimpleRrule(event.rrule) : null;
    const starts: number[] = [];
    if (!rule) {
      // Sin regla (o con una fuera del subconjunto): la ocurrencia base.
      starts.push(baseStart);
    } else {
      // Las ocurrencias se generan en la zona de pared del DTSTART: TZID si
      // lo hay, UTC si la fecha lleva `Z`, y la zona del hogar si es flotante
      // o de día completo.
      const timeZone = event.dtstart.tzid ?? (startParsed.isUtc && startParsed.hasTime ? "UTC" : ICS_DEFAULT_TIME_ZONE);
      let emitted = 0;
      for (const epoch of ruleOccurrences(startParsed.parts, timeZone, rule)) {
        emitted += 1;
        if (rule.count !== null && emitted > rule.count) break;
        if (rule.untilMs !== null && epoch > rule.untilMs) break;
        if (epoch > windowEnd) break;
        starts.push(epoch);
        if (starts.length >= ICS_MAX_OCCURRENCES_PER_EVENT) break;
      }
    }

    for (const startMs of starts) {
      const endMs = durationMs !== null ? startMs + durationMs : null;
      const insideWindow =
        (startMs >= windowStart && startMs <= windowEnd) ||
        (startMs < windowStart && endMs !== null && endMs > windowStart);
      if (!insideWindow || excluded.has(startMs)) continue;
      const base = {
        uid,
        startsAt: new Date(startMs).toISOString(),
        endsAt: endMs !== null ? new Date(endMs).toISOString() : null,
        allDay,
        summary: event.summary.slice(0, 300),
        location: event.location && event.location.length > 0 ? event.location.slice(0, 300) : null,
      };
      occurrences.push({ ...base, contentHash: occurrenceHash(base) });
      if (occurrences.length >= ICS_MAX_OCCURRENCES_PER_SOURCE) return occurrences;
    }
  }
  return occurrences;
}

/*
 * Aquí vivía `createRoutineDueHandler`, el manejador de
 * `notification.routine_due`: recibía en el payload la lista de correos de la
 * audiencia y mandaba a cada uno un aviso de rutina pendiente. Se retiró con la
 * migración 0029 junto con el resto de la salida de correo; la aplicación ya no
 * encola ese trabajo (packages/server/src/commands/rhythm.ts) y lo que quedara
 * encolado pasó a `dead` en la migración. La rutina que vence se ve en Hoy y en
 * el calendario, que es donde se mira.
 */

// ─── Sincronización de fuentes ───────────────────────────────────────────────

export interface IcsSyncDeps {
  fetchSource: (url: string) => Promise<IcsOccurrence[]>;
  /** `app_private.replace_ics_source_events` (0015): upsert + poda por fuente. */
  persistEvents: (householdId: string, sourceId: string, events: IcsOccurrence[]) => Promise<void>;
  /** `app_private.record_ics_sync` (0009): last_fetched_at/last_error. */
  recordSync: (householdId: string, sourceId: string, error: string) => Promise<void>;
}

/**
 * Job `ics.sync_source` {sourceId, url, clear?}: la URL viaja en el payload
 * porque el worker no tiene grant de lectura sobre `app.ics_sources`. Con
 * `clear: true` (fuente desactivada) no se toca la red: se vacían sus eventos.
 * Cualquier fallo queda anotado en la fuente (last_error) antes de relanzarse
 * al ciclo de reintentos de la cola.
 */
export function createIcsSyncHandler(deps: IcsSyncDeps): JobHandler {
  return async (job) => {
    const candidate = job.payload as Record<string, unknown> | null | undefined;
    const sourceId = candidate?.sourceId;
    const url = candidate?.url;
    const clear = candidate?.clear === true;
    if (typeof sourceId !== "string" || sourceId.trim().length === 0) {
      throw new PermanentJobError("La sincronización ICS requiere sourceId");
    }
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new PermanentJobError("La sincronización ICS requiere una url https");
    }
    try {
      const events = clear ? [] : await deps.fetchSource(url);
      await deps.persistEvents(job.householdId, sourceId, events);
      await deps.recordSync(job.householdId, sourceId, "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Mejor esfuerzo: el error visible en Ajustes/Calendario no debe tapar
      // el fallo original si también falla su registro.
      await deps.recordSync(job.householdId, sourceId, message.slice(0, 500)).catch(() => {});
      throw error;
    }
  };
}

export interface IcsSourceForSync {
  householdId: string;
  sourceId: string;
  url: string;
}

export interface IcsEnqueueInput {
  householdId: string;
  type: string;
  payload: unknown;
  runAt: Date;
}

export interface IcsSyncAllDeps {
  /** `app_private.list_ics_sources_for_sync` (0015): fuentes activas. */
  listSources: () => Promise<IcsSourceForSync[]>;
  enqueue: (input: IcsEnqueueInput) => Promise<void>;
  now?: () => Date;
}

/**
 * Job `ics.sync_all` (global, patrón maintenance.prune_discovery): encola un
 * `ics.sync_source` inmediato por cada fuente activa y se re-encola a +6 h.
 * El `household_id` del propio job es relleno estructural de la cola; cada
 * sync_source lleva el hogar real de su fuente.
 */
export function createIcsSyncAllHandler(deps: IcsSyncAllDeps): JobHandler {
  const now = deps.now ?? (() => new Date());
  return async (job) => {
    const sources = await deps.listSources();
    const runAt = now();
    for (const source of sources) {
      await deps.enqueue({
        householdId: source.householdId,
        type: ICS_SYNC_JOB,
        payload: { sourceId: source.sourceId, url: source.url },
        runAt,
      });
    }
    await deps.enqueue({
      householdId: job.householdId,
      type: ICS_SYNC_ALL_JOB,
      payload: {},
      runAt: new Date(runAt.getTime() + ICS_SYNC_INTERVAL_HOURS * HOUR_MS),
    });
  };
}

/**
 * Dependencias reales del worker para la fontanería ICS: solo funciones
 * definer (0009/0015) e inserción directa en la cola — cero lectura/escritura
 * de tablas de dominio.
 */
export function createIcsQueries(pool: Pool): {
  listSourcesForSync: IcsSyncAllDeps["listSources"];
  replaceSourceEvents: IcsSyncDeps["persistEvents"];
  recordSync: IcsSyncDeps["recordSync"];
} {
  return {
    listSourcesForSync: async () => {
      const result = await pool.query<{ household_id: string; source_id: string; url: string }>(
        "select household_id, source_id, url from app_private.list_ics_sources_for_sync()",
      );
      return result.rows.map((row) => ({ householdId: row.household_id, sourceId: row.source_id, url: row.url }));
    },
    replaceSourceEvents: async (householdId, sourceId, events) => {
      await pool.query("select app_private.replace_ics_source_events($1, $2, $3::jsonb)", [
        householdId,
        sourceId,
        JSON.stringify(events),
      ]);
    },
    recordSync: async (householdId, sourceId, error) => {
      await pool.query("select app_private.record_ics_sync($1, $2, $3)", [householdId, sourceId, error]);
    },
  };
}

/**
 * Auto-encolado del ciclo periódico al arrancar el worker (mismo patrón y
 * misma limitación que ensurePruneDiscoveryScheduled: con la cola vacía no hay
 * hogar-ancla que tomar prestado y se abstiene hasta el siguiente arranque o
 * hasta que cualquier job exista).
 */
export async function ensureIcsSyncScheduled(
  pool: Pool,
): Promise<"already-scheduled" | "scheduled" | "empty-queue"> {
  const pending = await pool.query(
    `select 1 from app_private.job_queue
      where job_type = $1 and status in ('queued', 'running')
      limit 1`,
    [ICS_SYNC_ALL_JOB],
  );
  if ((pending.rowCount ?? 0) > 0) return "already-scheduled";

  const anchor = await pool.query<{ household_id: string }>(
    "select household_id from app_private.job_queue limit 1",
  );
  const householdId = anchor.rows[0]?.household_id;
  if (!householdId) return "empty-queue";

  await pool.query(
    `insert into app_private.job_queue (household_id, job_type, payload, run_at)
     values ($1, $2, '{}'::jsonb, now())`,
    [householdId, ICS_SYNC_ALL_JOB],
  );
  return "scheduled";
}
