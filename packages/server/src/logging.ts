/**
 * Logger estructurado con redacción por allowlist (control 8 del baseline).
 *
 * Cada evento sale como UNA línea JSON (`JSON.stringify` escapa los saltos de
 * línea) con `time`, `level`, `scope` y `msg` más los campos aportados. La
 * redacción es por lista de claves permitidas: cualquier clave fuera de la
 * lista conserva su nombre pero su valor se sustituye por `[redactado]`.
 * Incluso en claves permitidas, un valor que parezca un email o un UUID no
 * técnico (identidad de usuario) JAMÁS pasa.
 *
 * Sin dependencias: lo consumen `apps/web` (vía el export raíz del paquete) y
 * `apps/worker` (vía el subpath `@housekeeper/server/logging`, resuelto a dist).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** Destino de cada línea; por defecto stdout (stderr para warn/error). */
  sink?: (line: string, level: LogLevel) => void;
  /** Reloj inyectable para pruebas deterministas. */
  now?: () => Date;
}

export const REDACTED = "[redactado]";

/**
 * Claves que pueden viajar en un log: identificadores técnicos (hogar,
 * operación, job), conteos, duraciones y códigos de error. Nada de texto
 * libre, nombres, correos ni identidades de usuario.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "householdId",
  "operationId",
  "jobId",
  "jobType",
  "count",
  "counts",
  "ms",
  "code",
  "status",
]);

/** Claves cuyo valor UUID es un identificador técnico aceptable. */
const UUID_OK_KEYS: ReadonlySet<string> = new Set(["householdId", "operationId", "jobId"]);

/** Claves reservadas de la envolvente: un campo no puede pisarlas. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["time", "level", "scope", "msg"]);

const EMAIL_RE = /@/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function sanitizeScalar(key: string, value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (EMAIL_RE.test(value)) return REDACTED;
    if (UUID_RE.test(value) && !UUID_OK_KEYS.has(key)) return REDACTED;
    return value;
  }
  return REDACTED;
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (!ALLOWED_KEYS.has(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => sanitizeScalar(key, item));
  if (value !== null && typeof value === "object") {
    if (key !== "counts") return REDACTED;
    // `counts` admite un mapa plano nombre→número; cualquier otro valor se redacta.
    const entries = Object.entries(value as Record<string, unknown>).map(([name, item]) => [
      name,
      typeof item === "number" ? item : REDACTED,
    ]);
    return Object.fromEntries(entries) as Record<string, unknown>;
  }
  return sanitizeScalar(key, value);
}

/**
 * Código estable y sin datos de un error desconocido: el `code` de los errores
 * de Postgres/Node si existe, el nombre de la clase de error en su defecto.
 * Nunca el mensaje, que puede arrastrar valores de usuario.
 */
export function errorCode(cause: unknown): string {
  if (cause !== null && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64 && !EMAIL_RE.test(code)) {
      return code;
    }
    if (cause instanceof Error) return cause.name;
  }
  return "unknown";
}

function defaultSink(line: string, level: LogLevel): void {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    const entry: Record<string, unknown> = {
      time: now().toISOString(),
      level,
      scope,
      msg: message,
    };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (RESERVED_KEYS.has(key)) continue;
        entry[key] = sanitizeValue(key, value);
      }
    }
    sink(JSON.stringify(entry), level);
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
