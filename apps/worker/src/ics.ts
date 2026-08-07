import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { PermanentJobError, type JobHandler } from "./queue.js";

export const ROUTINE_DUE_JOB = "notification.routine_due";
export const ICS_SYNC_JOB = "ics.sync_source";

export const ICS_MAX_REDIRECTS = 3;
export const ICS_TIMEOUT_MS = 10_000;
export const ICS_MAX_BYTES = 1_048_576; // 1 MiB

export interface IcsEvent {
  startsAt: string;
  title: string;
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
 * Descarga y parsea una fuente ICS externa con protección SSRF: solo https,
 * resolución DNS con veto de rangos privados/loopback/link-local/metadatos,
 * redirects manuales revalidados uno a uno (máximo 3), timeout de 10 s y
 * cuerpo limitado a 1 MiB.
 */
export async function fetchIcsSource(rawUrl: string, deps: IcsFetchDeps = {}): Promise<IcsEvent[]> {
  const fetchImpl = deps.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  const lookup = deps.lookup ?? defaultLookup;
  const timeoutMs = deps.timeoutMs ?? ICS_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? ICS_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? ICS_MAX_REDIRECTS;

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
    return parseIcs(await readBodyCapped(response, maxBytes));
  }
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

/** `20250607T093000Z` / `20250607T093000` / `20250607` → ISO. */
function parseIcsDate(raw: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  if (hour === undefined) return `${year}-${month}-${day}`;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${utc === "Z" ? "Z" : ""}`;
}

/**
 * Parser ICS mínimo propio: recorre los bloques VEVENT y extrae DTSTART y
 * SUMMARY, ignorando parámetros (`;TZID=`, `;VALUE=DATE`, …) y cualquier otra
 * propiedad. Un VEVENT sin fecha interpretable o sin título se descarta.
 */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let inEvent = false;
  let startsAt: string | null = null;
  let title: string | null = null;
  for (const line of unfoldIcsLines(text)) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      inEvent = true;
      startsAt = null;
      title = null;
      continue;
    }
    if (/^END:VEVENT$/i.test(line)) {
      if (inEvent && startsAt !== null && title !== null && title.length > 0) {
        events.push({ startsAt, title });
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).split(";", 1)[0]?.toUpperCase();
    const value = line.slice(separator + 1);
    if (name === "DTSTART") startsAt = parseIcsDate(value);
    else if (name === "SUMMARY") title = unescapeIcsText(value).trim();
  }
  return events;
}

export interface RoutineDueEmail {
  to: string;
  subject: string;
  text: string;
}

export interface RoutineDueDeps {
  sendEmail: (input: RoutineDueEmail) => Promise<void>;
}

interface RoutineDuePayload {
  routineId: string;
  title: string;
  audience: "family" | "employee" | "all";
  recipients: string[];
}

function parseRoutineDuePayload(payload: unknown): RoutineDuePayload {
  const candidate = payload as Record<string, unknown> | null | undefined;
  const routineId = candidate?.routineId;
  const title = candidate?.title;
  const audience = candidate?.audience;
  const recipients = candidate?.recipients;
  if (typeof routineId !== "string" || routineId.trim().length === 0) {
    throw new PermanentJobError("El aviso de rutina requiere routineId");
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new PermanentJobError("El aviso de rutina requiere title");
  }
  if (audience !== "family" && audience !== "employee" && audience !== "all") {
    throw new PermanentJobError("El aviso de rutina requiere una audiencia válida");
  }
  if (
    !Array.isArray(recipients) ||
    recipients.some((value) => typeof value !== "string" || value.trim().length === 0)
  ) {
    throw new PermanentJobError("El aviso de rutina requiere recipients como lista de correos");
  }
  return { routineId, title, audience, recipients: recipients as string[] };
}

/**
 * Aviso `notification.routine_due`: los destinatarios ya vienen resueltos por
 * audiencia en el payload (la aplicación los congela al encolar, AC-25); el
 * worker no lee tablas de dominio y se limita a enviar el correo a cada uno.
 */
export function createRoutineDueHandler(deps: RoutineDueDeps): JobHandler {
  return async (job) => {
    const payload = parseRoutineDuePayload(job.payload);
    const subject = `Casa Clara: rutina pendiente — ${payload.title}`;
    const text = [
      "Hola:",
      "",
      `La rutina «${payload.title}» tiene una ocurrencia pendiente.`,
      "Puedes marcarla como completada desde la aplicación.",
      "",
      "— Casa Clara",
    ].join("\n");
    for (const to of [...new Set(payload.recipients)]) {
      await deps.sendEmail({ to, subject, text });
    }
  };
}

export interface IcsSyncDeps {
  fetchSource: (url: string) => Promise<IcsEvent[]>;
  /**
   * Persistencia del resultado (last_fetched_at/last_error y eventos). HUECO
   * DE ESQUEMA: `app.ics_sources` solo tiene GRANT para casa_clara_app, así
   * que el worker no puede escribir el resultado con el esquema congelado; la
   * migración 0009 añadirá una función `app_private.*` de alcance mínimo. Hasta
   * entonces el hook es opcional y por defecto el resultado se descarta.
   */
  persist?: (sourceId: string, events: IcsEvent[]) => Promise<void>;
}

/**
 * Job `ics.sync_source` {sourceId, url}: la URL viaja en el payload porque el
 * worker no tiene grant de lectura sobre `app.ics_sources`. Descarga y parsea
 * con protección SSRF; las violaciones de política son fallos permanentes.
 */
export function createIcsSyncHandler(deps: IcsSyncDeps): JobHandler {
  return async (job) => {
    const candidate = job.payload as Record<string, unknown> | null | undefined;
    const sourceId = candidate?.sourceId;
    const url = candidate?.url;
    if (typeof sourceId !== "string" || sourceId.trim().length === 0) {
      throw new PermanentJobError("La sincronización ICS requiere sourceId");
    }
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new PermanentJobError("La sincronización ICS requiere una url https");
    }
    const events = await deps.fetchSource(url);
    if (deps.persist) await deps.persist(sourceId, events);
  };
}
