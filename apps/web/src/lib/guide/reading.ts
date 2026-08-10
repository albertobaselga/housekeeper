/**
 * Qué cuenta como «leída» una nota de la Guía, y cómo se apunta.
 *
 * El propietario pidió que pasar de página marque la anterior como leída. Un
 * salto instantáneo, sin embargo, no es lectura: con 52 notas se puede
 * «terminar» el manual en diez segundos a base de tocar «Siguiente», y esa
 * casilla marcada no serviría a nadie. La regla que aplicamos son DOS señales,
 * las dos baratas y las dos honestas:
 *
 *   1. **Se ha visto el final del texto.** Un observador de intersección avisa
 *      cuando el cierre de la nota entra en pantalla. En una nota más corta que
 *      la ventana esto es cierto desde el primer instante, que es justo lo que
 *      debe pasar: no se puede exigir desplazamiento donde no hay nada que
 *      desplazar.
 *   2. **Un mínimo de permanencia**, `MIN_DWELL_MS`. No es un examen: son dos
 *      segundos, el tiempo que separa «he abierto esto» de «he pasado de largo».
 *      No escala con la longitud del texto ni castiga a quien lee rápido, y no
 *      hay tope superior ni penalización por volver atrás.
 *
 * Lo que NO hacemos, deliberadamente: medir velocidad de desplazamiento, exigir
 * un tiempo proporcional a las palabras, ni pedir clics de confirmación. Todo
 * eso son trampas que se aprenden a burlar en dos días y que convierten una
 * herramienta en un control de presencia. Quien quiera saltarse la lectura
 * podrá; el objetivo es que el camino honesto sea el natural, no levantar un
 * torniquete.
 *
 * El tiempo se cuenta solo con la pestaña visible: dejar la nota abierta e irse
 * a comer no cuenta como leerla.
 */

export const MIN_DWELL_MS = 2_000;

export interface ReadingSignal {
  /** Milisegundos con la nota abierta y la pestaña a la vista. */
  dwellMs: number;
  /** ¿Ha llegado a verse el final del texto? */
  reachedEnd: boolean;
}

export function countsAsRead(signal: ReadingSignal, minDwellMs: number = MIN_DWELL_MS): boolean {
  return signal.reachedEnd && signal.dwellMs >= minDwellMs;
}

/**
 * Cronómetro de permanencia que se para cuando la pestaña deja de verse.
 * Puro y sin dependencias del navegador para poder probarlo con un reloj falso.
 */
export class DwellClock {
  #accumulated = 0;
  #startedAt: number | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  start(): void {
    if (this.#startedAt === null) this.#startedAt = this.now();
  }

  pause(): void {
    if (this.#startedAt === null) return;
    this.#accumulated += this.now() - this.#startedAt;
    this.#startedAt = null;
  }

  reset(): void {
    this.#accumulated = 0;
    this.#startedAt = null;
  }

  get elapsedMs(): number {
    return this.#accumulated + (this.#startedAt === null ? 0 : this.now() - this.#startedAt);
  }
}

/**
 * Sin conexión no se puede apuntar la lectura en el servidor —y no queremos
 * meterla en la cola de comandos, que sella cada operación con su actor y su
 * hora en `command_receipts`: eso reconstruiría por la puerta de atrás el
 * rastro que el diseño evita—. Así que la nota leída se recuerda AQUÍ, en el
 * dispositivo de quien lee, y se envía en cuanto vuelve la red. Es una lista de
 * identificadores sin fecha: ni siquiera el propio aparato guarda cuándo.
 */
export interface PendingReadStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Tope defensivo: si alguien lee cien notas sin red, con eso va sobrado. */
const PENDING_LIMIT = 200;

export function pendingReadsKey(householdId: string): string {
  return `cc:guia:leidas-pendientes:${householdId}`;
}

function readList(storage: PendingReadStorage, householdId: string): string[] {
  try {
    const raw = storage.getItem(pendingReadsKey(householdId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberPendingRead(
  storage: PendingReadStorage,
  householdId: string,
  pageId: string
): string[] {
  const pending = readList(storage, householdId).filter((candidate) => candidate !== pageId);
  pending.push(pageId);
  const trimmed = pending.slice(-PENDING_LIMIT);
  storage.setItem(pendingReadsKey(householdId), JSON.stringify(trimmed));
  return trimmed;
}

/** Devuelve lo pendiente y lo vacía: quien llama se compromete a enviarlo. */
export function takePendingReads(storage: PendingReadStorage, householdId: string): string[] {
  const pending = readList(storage, householdId);
  if (pending.length > 0) storage.removeItem(pendingReadsKey(householdId));
  return pending;
}

export function guideReadEndpoint(householdId: string): string {
  return `/api/v1/households/${encodeURIComponent(householdId)}/guia/leida`;
}
