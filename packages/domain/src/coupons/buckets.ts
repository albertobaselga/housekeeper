import { addCalendarDays, isDateInClosedRange, isIsoDateString, type LocalDate } from "../dates.js";
import { invariant } from "../errors.js";

/**
 * Cupones de la familia: en qué filtro cae cada uno y cuántos usos le quedan.
 *
 * La casa NO controla los usos, solo los apunta (D-usos): un cupón gastado,
 * caducado o descartado se puede seguir usando, y el uso se registra igual.
 * Por eso aquí no hay nada que diga «no»; solo se decide QUÉ SE VE por defecto.
 *
 * Sin reloj: «hoy» llega de fuera como `LocalDate` (Europe/Madrid, lo resuelve
 * el servidor). Así el mismo cupón cae en el mismo cubo en la página, en el
 * aviso de Hoy y en las pruebas.
 */

/** En el orden de los filtros de la pantalla: disponibles, usados, caducados, descartados. */
export const COUPON_BUCKETS = ["available", "used", "expired", "discarded"] as const;

export type CouponBucket = (typeof COUPON_BUCKETS)[number];

/** Días por delante que mira el aviso «caduca pronto» de Hoy. */
export const COUPON_EXPIRY_NOTICE_DAYS = 3;

/**
 * Tope de la ventana de aviso: un año. Más que eso no es «pronto», y sin tope
 * una ventana absurda se sale del calendario de `Date` y revienta con un
 * `RangeError` sin nombre.
 */
const MAX_EXPIRY_NOTICE_DAYS = 366;

export interface CouponFacts {
  /** `null` = sin límite de usos. */
  readonly maxUses: number | null;
  /** Usos apuntados y no anulados. */
  readonly liveUses: number;
  /** Último día en que sirve, incluido. `null` = no caduca. */
  readonly expiresOn: LocalDate | null;
  readonly discarded: boolean;
}

/**
 * Los hechos llegan de la base, que ya los acota (`max_uses` 1..999, los usos
 * son un recuento). Si aun así llega otra cosa —un `count(*)` de node-postgres
 * viene como TEXTO, por ejemplo— se para aquí con un error con nombre: la
 * alternativa es una pantalla que dice «quedan NaN usos» o, peor, que compara
 * cadenas y acierta por casualidad.
 */
function assertCouponFacts(facts: CouponFacts): void {
  invariant(
    Number.isInteger(facts.liveUses) && facts.liveUses >= 0,
    "INVALID_COUPON_USES",
    "Los usos de un cupón son un número entero no negativo.",
  );
  invariant(
    facts.maxUses === null || (Number.isInteger(facts.maxUses) && facts.maxUses >= 1),
    "INVALID_COUPON_MAX_USES",
    "Los usos máximos de un cupón son un entero positivo o ninguno (sin límite).",
  );
}

/**
 * Lo mismo con las fechas, que aquí se comparan como texto. Una columna `date`
 * llega de node-postgres como `Date` si no se lee como `::text`, y un cast a
 * `LocalDate` la deja pasar: sin esta guarda el cupón caería en silencio en el
 * cubo equivocado (un `2026-10-3` frente a `2026-10-03` sale «disponible»). El
 * cargador tiene que leer `expires_on::text` y pasarlo por `localDate()`.
 */
function assertCouponDates(facts: CouponFacts, today: LocalDate): void {
  invariant(
    isLocalDateValue(today),
    "INVALID_LOCAL_DATE",
    "«Hoy» tiene que ser una fecha de calendario YYYY-MM-DD.",
  );
  invariant(
    facts.expiresOn === null || isLocalDateValue(facts.expiresOn),
    "INVALID_LOCAL_DATE",
    "La caducidad de un cupón es una fecha de calendario YYYY-MM-DD o ninguna.",
  );
}

function isLocalDateValue(value: unknown): boolean {
  return typeof value === "string" && isIsoDateString(value);
}

/**
 * Precedencia: descartado > usado > caducado > disponible.
 *
 * · Descartado gana a todo: alguien decidió que no sirve, y eso pesa más que
 *   cualquier cuenta.
 * · Usado gana a caducado: un cupón de un uso que se gastó y luego caducó está
 *   donde se le busca, en «Usados». Sin límite de usos nunca está usado.
 * · Caduca HOY sigue disponible todo el día; caducado es desde mañana.
 */
export function couponBucket(facts: CouponFacts, today: LocalDate): CouponBucket {
  assertCouponFacts(facts);
  assertCouponDates(facts, today);
  if (facts.discarded) return "discarded";
  if (facts.maxUses !== null && facts.liveUses >= facts.maxUses) return "used";
  if (facts.expiresOn !== null && facts.expiresOn < today) return "expired";
  return "available";
}

/**
 * Inventario, no visibilidad: no mira ni la caducidad ni el descarte. `null`
 * quiere decir «sin límite». Nunca negativo: si se apuntaron usos de más
 * (nada lo impide), quedan cero, no menos uno.
 */
export function remainingUses(facts: CouponFacts): number | null {
  assertCouponFacts(facts);
  if (facts.maxUses === null) return null;
  return Math.max(0, facts.maxUses - facts.liveUses);
}

/**
 * Disponible y con caducidad en [hoy, hoy + días], los dos extremos incluidos.
 * Lo ya caducado no «caduca pronto» —tiene su propio filtro— y lo usado o
 * descartado tampoco avisa: no hay nada que aprovechar antes de que se pierda.
 */
export function expiresSoon(
  facts: CouponFacts,
  today: LocalDate,
  days: number = COUPON_EXPIRY_NOTICE_DAYS,
): boolean {
  invariant(
    Number.isInteger(days) && days >= 0 && days <= MAX_EXPIRY_NOTICE_DAYS,
    "INVALID_DAY_COUNT",
    "La ventana de aviso de un cupón es un número entero de días, de cero a un año.",
  );
  if (couponBucket(facts, today) !== "available" || facts.expiresOn === null) return false;
  return isDateInClosedRange(facts.expiresOn, today, addCalendarDays(today, days));
}
