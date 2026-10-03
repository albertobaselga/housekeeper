import type { CouponFieldsInput } from './commands';
import type { CouponView } from './types';
import { expiryLabel } from './view';

/**
 * El borrador del formulario de un cupón: lo que la persona tiene escrito, tal
 * cual, en cadenas. Es el punto de enganche de la fase 2 (spec de cupones §12):
 * una propuesta de campos sacada de la foto llegará como `Partial<CouponDraft>`
 * y precargará el mismo formulario, sin cambiar nada más.
 */

export type CouponUsesMode = 'single' | 'multiple' | 'unlimited';

export interface CouponDraft {
  merchant: string;
  offer: string;
  code: string;
  /** Lo que da el `<input type="date">`: `YYYY-MM-DD` o vacío. */
  expiresOn: string;
  usesMode: CouponUsesMode;
  /** «¿Cuántos?» de «Varios usos», como lo escribió la persona. */
  usesCount: string;
  notes: string;
}

/**
 * Rango de fechas que admite el contrato (`couponDateSchema`). Va también en el
 * `min`/`max` del campo, para que el navegador avise de un año de dos cifras
 * antes de que el servidor lo rechace.
 */
export const COUPON_DATE_MIN = '2000-01-01';
export const COUPON_DATE_MAX = '2999-12-31';

/** Los límites de la base (0039) y del contrato, en un sitio. */
export const COUPON_LIMITS = { merchant: 120, offer: 200, code: 120, notes: 1000, maxUses: 999 } as const;

export function emptyCouponDraft(): CouponDraft {
  return { merchant: '', offer: '', code: '', expiresOn: '', usesMode: 'single', usesCount: '', notes: '' };
}

export function draftFromCoupon(coupon: CouponView): CouponDraft {
  return {
    merchant: coupon.merchant,
    offer: coupon.offer,
    code: coupon.code ?? '',
    expiresOn: coupon.expiresOn ?? '',
    usesMode: coupon.maxUses === null ? 'unlimited' : coupon.maxUses === 1 ? 'single' : 'multiple',
    usesCount: coupon.maxUses !== null && coupon.maxUses > 1 ? String(coupon.maxUses) : '',
    notes: coupon.notes ?? ''
  };
}

export type CouponDraftCheck =
  | { ok: true; fields: CouponFieldsInput }
  | { ok: false; field: keyof CouponDraft; message: string };

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return parsed.toISOString().slice(0, 10) === value;
}

/**
 * La caducidad elegida, en palabras («Caduca el lun 2 nov»), para ponerla
 * debajo del campo. El `<input type="date">` nativo pinta el formato del
 * navegador, que en algunos es mm/dd: repetirla en palabras quita la duda
 * (sistema móvil §2.9). Null si está vacía o no es una fecha que el
 * formulario aceptaría: de eso ya avisa el error.
 */
export function expiryInWords(value: string, todayISO: string): string | null {
  const date = value.trim();
  if (!date || !isCalendarDate(date) || date < COUPON_DATE_MIN || date > COUPON_DATE_MAX) return null;
  return expiryLabel(date, todayISO);
}

/**
 * Lo que la base rechazaría, dicho antes y en llano. El constructor del
 * comando vuelve a recortar y el servidor vuelve a validar: esto no es la
 * frontera, es no hacer esperar a nadie para decirle que falta el comercio.
 */
export function checkCouponDraft(draft: CouponDraft): CouponDraftCheck {
  const merchant = draft.merchant.trim();
  const offer = draft.offer.trim();
  const code = draft.code.trim();
  const notes = draft.notes.trim();
  const expiresOn = draft.expiresOn.trim();

  if (!merchant) return { ok: false, field: 'merchant', message: 'Escribe dónde sirve el cupón.' };
  if (merchant.length > COUPON_LIMITS.merchant) {
    return { ok: false, field: 'merchant', message: `El comercio cabe en ${COUPON_LIMITS.merchant} letras como mucho.` };
  }
  if (!offer) return { ok: false, field: 'offer', message: 'Escribe qué ofrece el cupón.' };
  if (offer.length > COUPON_LIMITS.offer) {
    return { ok: false, field: 'offer', message: `Lo que ofrece cabe en ${COUPON_LIMITS.offer} letras como mucho.` };
  }
  if (code.length > COUPON_LIMITS.code) {
    return { ok: false, field: 'code', message: `El código cabe en ${COUPON_LIMITS.code} caracteres como mucho.` };
  }
  if (expiresOn && (!isCalendarDate(expiresOn) || expiresOn < COUPON_DATE_MIN || expiresOn > COUPON_DATE_MAX)) {
    return {
      ok: false,
      field: 'expiresOn',
      message: 'La caducidad tiene que ser un día de verdad, con el año entero (por ejemplo, 2026).'
    };
  }
  if (notes.length > COUPON_LIMITS.notes) {
    return { ok: false, field: 'notes', message: `Las notas caben en ${COUPON_LIMITS.notes} letras como mucho.` };
  }

  let maxUses: number | null;
  if (draft.usesMode === 'single') {
    maxUses = 1;
  } else if (draft.usesMode === 'unlimited') {
    maxUses = null;
  } else {
    const count = draft.usesCount.trim();
    maxUses = /^\d+$/.test(count) ? Number(count) : Number.NaN;
    if (!Number.isInteger(maxUses) || maxUses < 2 || maxUses > COUPON_LIMITS.maxUses) {
      return {
        ok: false,
        field: 'usesCount',
        message: `¿Cuántos usos? Escribe un número entero entre 2 y ${COUPON_LIMITS.maxUses}.`
      };
    }
  }

  return {
    ok: true,
    fields: {
      merchant,
      offer,
      code: code || null,
      expiresOn: expiresOn || null,
      maxUses,
      notes: notes || null
    }
  };
}
