import type { Pool } from 'pg';

import { createLogger, withAuthorizedTransaction } from '@housekeeper/server';

import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:coupon-photo');

/**
 * Lo justo para servir la foto de un cupón desde el almacén. A propósito NO
 * lleva comercio, oferta, código ni notas: lo que no se lee no puede acabar en
 * un registro ni en una cabecera (spec cupones §7.3 y §9).
 */
export interface CouponPhoto {
  bucket: string;
  objectKey: string;
  mediaType: string;
  byteSize: string;
}

/**
 * La foto de un cupón, leída bajo la RLS de quien la pide. No hay ningún
 * filtro por papel aquí, y no hace falta: `coupons_family_read` deja el cupón
 * fuera para quien no es de la familia, y `storage_objects_read_coupon_photo`
 * (0039) solo abre el objeto a través de un cupón visible. A la empleada, al
 * apoyo y al acceso puntual esta consulta les devuelve cero filas.
 *
 * Un cupón descartado conserva su foto: se puede recuperar, y hay que poder
 * reconocerlo antes de hacerlo. Una foto borrada, no.
 *
 * Devuelve null sin pool (maqueta), sin membresía o sin fila; la ruta lo
 * convierte en un 404 que no distingue «no existe» de «no te toca».
 */
export async function loadCouponPhoto(
  user: { id: string },
  householdId: string,
  couponId: string,
  pool: Pool | null = getDatabasePool()
): Promise<CouponPhoto | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const result = await client.query<CouponPhoto>(
        `select photo.bucket,
                photo.object_key as "objectKey",
                photo.media_type as "mediaType",
                photo.byte_size::text as "byteSize"
           from app.coupons as coupon
           join app.storage_objects as photo
             on photo.household_id = coupon.household_id
            and photo.id = coupon.photo_storage_object_id
          where coupon.household_id = $1 and coupon.id = $2
            and photo.deleted_at is null`,
        [householdId, couponId]
      );
      return result.rows[0] ?? null;
    });
  } catch (cause) {
    // Una avería no es «este cupón no tiene foto»: sale como 503 y queda en el
    // registro solo con su código estable, sin nada del cupón.
    return unreadable(log, 'coupon photo', cause);
  }
}
