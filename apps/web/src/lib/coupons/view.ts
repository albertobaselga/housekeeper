import {
  COUPON_BUCKETS,
  couponBucket,
  expiresSoon,
  remainingUses,
  type CouponFacts
} from '@housekeeper/domain/coupons';
import type { LocalDate } from '@housekeeper/domain';

import type { CouponFieldsInput } from './commands';
import type { CouponBucket, CouponUseView, CouponView } from './types';

/**
 * Lo que la pantalla de cupones calcula sin red: el filtro de la URL, la
 * búsqueda local, el estado optimista y los textos en palabras.
 *
 * El cubo de cada cupón lo decide SIEMPRE el dominio (`@housekeeper/domain/
 * coupons`), aquí y en el cargador: al usar un cupón de un solo uso, la
 * pantalla lo mueve a «Usados» con la misma regla con la que lo hará el
 * servidor al volver, y nunca hay dos opiniones sobre dónde está un cupón.
 */

// ── Filtros: `?ver=` en castellano ──────────────────────────────────────────

const BUCKET_PARAM: Readonly<Record<CouponBucket, string>> = {
  available: 'disponibles',
  used: 'usados',
  expired: 'caducados',
  discarded: 'descartados'
};

export const BUCKET_LABEL: Readonly<Record<CouponBucket, string>> = {
  available: 'Disponibles',
  used: 'Usados',
  expired: 'Caducados',
  discarded: 'Descartados'
};

/** El orden de los filtros en pantalla. */
export const BUCKETS: readonly CouponBucket[] = COUPON_BUCKETS;

/** `?ver=` desconocido o ausente: lo que se usa en la tienda, los disponibles. */
export function bucketFromParam(value: string | null): CouponBucket {
  const found = BUCKETS.find((bucket) => BUCKET_PARAM[bucket] === value);
  return found ?? 'available';
}

export function paramForBucket(bucket: CouponBucket): string {
  return BUCKET_PARAM[bucket];
}

// ── Fechas en palabras ──────────────────────────────────────────────────────

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
// «sept» y no «sep»: es la abreviatura que da es-ES en el resto de la casa.
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

const MADRID_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/**
 * Hoy en la zona del hogar. Lo usa «Usar»: un uso apuntado sin red a las 23:50
 * ocurrió ese día, aunque la página se cargara la víspera.
 *
 * Por PIEZAS y no con `format()`: esto corre en el navegador, y fiarse de que
 * el patrón corto de en-CA sea `y-MM-dd` es fiarse de la versión de ICU de cada
 * uno (ya cambió una vez en Chrome). Con otro patrón, «Usar» mandaría una fecha
 * que el contrato rechaza. Mismo criterio que `currentLocalDate` de Contrato.
 */
export function madridToday(now: Date = new Date()): string {
  const parts = MADRID_DATE.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((piece) => piece.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function utcNoon(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

function addDays(iso: string, days: number): string {
  const date = utcNoon(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** «vie 10 oct»; con el año solo cuando no es el de hoy («lun 4 ene 2027»). */
export function shortDate(iso: string, todayISO: string): string {
  const date = utcNoon(iso);
  const label = `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return iso.slice(0, 4) === todayISO.slice(0, 4) ? label : `${label} ${iso.slice(0, 4)}`;
}

export function expiryLabel(expiresOn: string | null, todayISO: string): string {
  if (expiresOn === null) return 'Sin caducidad';
  if (expiresOn === todayISO) return 'Caduca hoy';
  if (expiresOn === addDays(todayISO, 1)) return 'Caduca mañana';
  if (expiresOn < todayISO) return `Caducó el ${shortDate(expiresOn, todayISO)}`;
  return `Caduca el ${shortDate(expiresOn, todayISO)}`;
}

/** La marca de usos de la fila: «Un solo uso» · «2 de 5 usados · quedan 3» · «Sin límite · usado 4 veces». */
export function usesLabel(coupon: { maxUses: number | null; liveUses: number }): string {
  const { maxUses, liveUses } = coupon;
  if (maxUses === null) {
    if (liveUses === 0) return 'Sin límite de usos';
    return `Sin límite · usado ${liveUses} ${liveUses === 1 ? 'vez' : 'veces'}`;
  }
  if (maxUses === 1) return liveUses === 0 ? 'Un solo uso' : 'Un solo uso · usado';
  if (liveUses === 0) return `Quedan ${maxUses} usos`;
  const left = maxUses - liveUses;
  if (left <= 0) return `${liveUses} de ${maxUses} usados`;
  return `${liveUses} de ${maxUses} usados · ${left === 1 ? 'queda 1' : `quedan ${left}`}`;
}

/**
 * La línea de apoyo de una fila: cuándo caduca y cuántos usos lleva. En un
 * descartado, desde cuándo lo está; en uno usado, cuándo se usó por última
 * vez. Es lo que distingue a uno de otro en esos filtros, y por lo que se
 * ordenan.
 *
 * Si caduca pronto, la fila pinta delante el chip «Caduca pronto» y esta
 * línea CONTINÚA la frase («… el lun 5 oct», «… hoy»): repetir «Caduca el»
 * detrás del chip se leía «Caduca pronto Caduca el lun 5 oct» (revisión UX,
 * ronda 2, m6).
 */
export function rowDetail(coupon: CouponView, todayISO: string): string {
  if (coupon.bucket === 'discarded' && coupon.discardedAt) {
    return `Descartado el ${shortDate(madridToday(new Date(coupon.discardedAt)), todayISO)} · ${usesLabel(coupon)}`;
  }
  const lastUse = coupon.uses[0];
  if (coupon.bucket === 'used' && lastUse) {
    // «Un solo uso · usado» repetiría lo que ya dice «Usado el…».
    const uses = coupon.maxUses === 1 ? 'Un solo uso' : usesLabel(coupon);
    return `Usado el ${shortDate(lastUse.usedOn, todayISO)} · ${uses}`;
  }
  if (coupon.expiresSoon && coupon.expiresOn !== null) {
    return `${expiryAfterSoon(coupon.expiresOn, todayISO)} · ${usesLabel(coupon)}`;
  }
  return `${expiryLabel(coupon.expiresOn, todayISO)} · ${usesLabel(coupon)}`;
}

/** Lo que va detrás de «Caduca pronto»: «hoy», «mañana» o «el lun 5 oct». */
function expiryAfterSoon(expiresOn: string, todayISO: string): string {
  if (expiresOn === todayISO) return 'hoy';
  if (expiresOn === addDays(todayISO, 1)) return 'mañana';
  return `el ${shortDate(expiresOn, todayISO)}`;
}

export function useLine(use: CouponUseView, todayISO: string): string {
  return `Usado el ${shortDate(use.usedOn, todayISO)} por ${use.usedByName}`;
}

/** Lo buscado no está en este filtro pero sí en otros: se dice dónde. */
export function elsewhereHint(buckets: readonly CouponBucket[]): string | null {
  if (buckets.length === 0) return null;
  const names = buckets.map((target) => `«${BUCKET_LABEL[target]}»`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
  return names.length === 1
    ? `Sí hay en ${list}: está en su filtro, arriba.`
    : `Sí hay en ${list}: están en sus filtros, arriba.`;
}

export function headerTitle(available: number): string {
  return `Cupones · ${available} ${available === 1 ? 'disponible' : 'disponibles'}`;
}

// ── Búsqueda local ──────────────────────────────────────────────────────────

/** Sin acentos ni mayúsculas: «panaderia» encuentra «Panadería». */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
}

export function matchesQuery(coupon: CouponView, query: string): boolean {
  const needle = fold(query.trim());
  if (!needle) return true;
  return [coupon.merchant, coupon.offer, coupon.code ?? '', coupon.notes ?? ''].some((field) =>
    fold(field).includes(needle)
  );
}

// ── Estado optimista ────────────────────────────────────────────────────────

/**
 * Lo hecho en ESTA pantalla y todavía no visto en los datos frescos. Cada
 * entrada se retira en el `settle` de su comando (o en el `revert`); mientras
 * tanto se superpone a lo que mandó el servidor.
 */
export interface CouponOverlay {
  /** Altas propias aún no confirmadas. */
  created: CouponView[];
  /** Usos apuntados aquí, por cupón, el más reciente primero. */
  addedUses: Record<string, CouponUseView[]>;
  /** Usos anulados aquí, por id de uso. */
  voidedUses: Record<string, true>;
  /** Descartes (true) y recuperaciones (false) hechos aquí. */
  discarded: Record<string, boolean>;
  /** Campos editados aquí. */
  edited: Record<string, CouponFieldsInput>;
  /**
   * Foto cambiada aquí: la vista previa en `data:` mientras llega el acuse. Al
   * retirarla vuelve la URL de la ruta, y como esa ruta no se guarda en caché
   * (`no-store`), el navegador pide la foto nueva.
   */
  photos: Record<string, string>;
}

export function emptyOverlay(): CouponOverlay {
  return { created: [], addedUses: {}, voidedUses: {}, discarded: {}, edited: {}, photos: {} };
}

function withOverlay(coupon: CouponView, overlay: CouponOverlay, todayISO: string): CouponView {
  const edited = overlay.edited[coupon.id];
  const fields = edited ? { ...coupon, ...edited } : coupon;
  const photoUrl = overlay.photos[coupon.id] ?? coupon.photoUrl;

  const seen = new Set<string>();
  const uses = [...(overlay.addedUses[coupon.id] ?? []), ...coupon.uses].filter((use) => {
    if (seen.has(use.id) || overlay.voidedUses[use.id]) return false;
    seen.add(use.id);
    return true;
  });

  const discardedOverride = overlay.discarded[coupon.id];
  const discardedAt =
    discardedOverride === undefined
      ? coupon.discardedAt
      : discardedOverride
        ? (coupon.discardedAt ?? new Date().toISOString())
        : null;

  const facts: CouponFacts = {
    maxUses: fields.maxUses,
    liveUses: uses.length,
    expiresOn: fields.expiresOn as LocalDate | null,
    discarded: discardedAt !== null
  };
  const today = todayISO as LocalDate;
  return {
    ...fields,
    photoUrl,
    uses,
    liveUses: facts.liveUses,
    remaining: remainingUses(facts),
    bucket: couponBucket(facts, today),
    expiresSoon: expiresSoon(facts, today),
    discardedAt
  };
}

/** Los cupones tal como se ven ahora: lo del servidor más lo hecho aquí. */
export function effectiveCoupons(
  server: readonly CouponView[],
  overlay: CouponOverlay,
  todayISO: string
): CouponView[] {
  const known = new Set(server.map((coupon) => coupon.id));
  const pending = overlay.created.filter((coupon) => !known.has(coupon.id));
  return [...pending, ...server].map((coupon) => withOverlay(coupon, overlay, todayISO));
}

// ── Lista por filtro ────────────────────────────────────────────────────────

export function countByBucket(coupons: readonly CouponView[]): Record<CouponBucket, number> {
  const counts: Record<CouponBucket, number> = { available: 0, used: 0, expired: 0, discarded: 0 };
  for (const coupon of coupons) counts[coupon.bucket] += 1;
  return counts;
}

const byMerchant = (a: CouponView, b: CouponView) => a.merchant.localeCompare(b.merchant, 'es');

/**
 * El orden de cada filtro responde a lo que se busca en él:
 * · Disponibles: lo que caduca antes, primero (es lo que hay que aprovechar);
 *   lo que no caduca, al final.
 * · Usados: lo último que se usó, primero.
 * · Caducados: lo que caducó hace menos, primero.
 * · Descartados: lo último que se descartó, primero.
 */
function compareFor(bucket: CouponBucket): (a: CouponView, b: CouponView) => number {
  switch (bucket) {
    case 'available':
      return (a, b) =>
        (a.expiresOn ?? '9999-99-99').localeCompare(b.expiresOn ?? '9999-99-99') || byMerchant(a, b);
    case 'used':
      return (a, b) => (b.uses[0]?.usedOn ?? '').localeCompare(a.uses[0]?.usedOn ?? '') || byMerchant(a, b);
    case 'expired':
      return (a, b) => (b.expiresOn ?? '').localeCompare(a.expiresOn ?? '') || byMerchant(a, b);
    case 'discarded':
      return (a, b) => (b.discardedAt ?? '').localeCompare(a.discardedAt ?? '') || byMerchant(a, b);
  }
}

export function visibleCoupons(coupons: readonly CouponView[], bucket: CouponBucket, query: string): CouponView[] {
  return coupons.filter((coupon) => coupon.bucket === bucket && matchesQuery(coupon, query)).sort(compareFor(bucket));
}

/** Comercios ya usados, sin repetir (sin distinguir mayúsculas) y en orden. */
export function merchantsFrom(coupons: readonly { merchant: string }[]): string[] {
  const byKey = new Map<string, string>();
  for (const { merchant } of coupons) {
    const name = merchant.trim();
    const key = fold(name);
    if (name && !byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, 'es'));
}
