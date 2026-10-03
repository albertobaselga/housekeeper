import type { CouponBucket } from '@housekeeper/domain/coupons';

/**
 * Lo que la página de cupones recibe de su cargador (spec de cupones §7.4).
 * Vive aquí, y no en `coupons.server.ts`, porque también lo usan la página y
 * sus componentes al pintar el estado optimista; el cargador lo reexporta.
 * Solo tipos: no pesa nada en el navegador.
 */

export type { CouponBucket };

export interface CouponUseView {
  id: string;
  /** Fecha local del uso, `YYYY-MM-DD`. */
  usedOn: string;
  usedByName: string;
}

export interface CouponView {
  id: string;
  merchant: string;
  offer: string;
  code: string | null;
  /** `YYYY-MM-DD`, o null si no caduca. */
  expiresOn: string | null;
  /** `null` = sin límite. */
  maxUses: number | null;
  /** Usos apuntados y no anulados. */
  liveUses: number;
  /** `null` = sin límite; nunca negativo. */
  remaining: number | null;
  notes: string | null;
  bucket: CouponBucket;
  expiresSoon: boolean;
  discardedAt: string | null;
  createdAt: string;
  createdByName: string;
  /** La ruta de la foto (proxy con sesión); nunca una URL pública. */
  photoUrl: string;
  /** Usos vivos, más recientes primero. */
  uses: CouponUseView[];
}

export interface CouponsPageData {
  /** Hoy en Europe/Madrid, `YYYY-MM-DD`: con él se calcularon los cubos. */
  today: string;
  coupons: CouponView[];
  /** Comercios ya usados, para el `datalist` del alta. */
  merchants: string[];
  counts: Record<CouponBucket, number>;
}
