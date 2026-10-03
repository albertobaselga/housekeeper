import type { Pool } from 'pg';

import { localDate } from '@housekeeper/domain';
import { couponBucket, expiresSoon, remainingUses, type CouponFacts } from '@housekeeper/domain/coupons';
import { createLogger, withAuthorizedTransaction } from '@housekeeper/server';

import { can } from '$lib/auth/capabilities';
import { countByBucket, merchantsFrom } from '$lib/coupons/view';
import type { CouponUseView, CouponView, CouponsPageData } from '$lib/coupons/types';
import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

export type { CouponBucket, CouponUseView, CouponView, CouponsPageData } from '$lib/coupons/types';

const log = createLogger('web:coupons');

/** Hoy en la zona del hogar: el mismo criterio que Hoy y el calendario. */
const MADRID_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });

/**
 * El nombre de quien guardó un cupón o apuntó un uso sale de
 * `app.coupon_people()` (0039), y no del perfil: la RLS de `user_profiles`
 * (0005) solo enseña a `family_member` el suyo, y la ficha tiene que decir
 * «Usado el mar 7 oct por Marta» a toda la familia (spec §8.2). Si aun así un
 * nombre no llega —una persona sin perfil—, la ficha dice algo verdadero en
 * vez de un hueco: quien escribe en la cartera es siempre alguien de la
 * familia.
 */
const UNKNOWN_PERSON = 'Alguien de la familia';

/**
 * La foto se sirve SIEMPRE por la ruta con sesión (spec de cupones §7.3).
 *
 * Con la foto en la URL (`?v=`): cada foto tiene su propia dirección. Con una
 * fija por cupón, tras «Cambiar la foto» la ficha volvía a una dirección que el
 * documento ya había cargado con la foto VIEJA, y la lista de imágenes de un
 * documento permite reutilizarla sin mirar la caché HTTP (revisión de
 * integración, ronda 2, m-4). La ruta no lee el parámetro: solo distingue.
 */
export function couponPhotoUrl(householdId: string, couponId: string, photoStorageObjectId: string): string {
  return `/api/v1/households/${householdId}/coupons/${couponId}/photo?v=${encodeURIComponent(photoStorageObjectId)}`;
}

/** Un cupón tal como sale de la base, antes de decidir su cubo. */
export interface CouponRow {
  id: string;
  merchant: string;
  offer: string;
  code: string | null;
  /** `expires_on::text`: una fecha de calendario, nunca un `Date`. */
  expiresOn: string | null;
  maxUses: number | null;
  notes: string | null;
  discardedAt: string | null;
  createdAt: string;
  createdByName: string | null;
  /** El objeto de la foto: versiona su URL. */
  photoStorageObjectId: string;
}

export interface CouponUseRow {
  id: string;
  couponId: string;
  usedOn: string;
  usedByName: string | null;
}

/**
 * De filas a lo que pinta la página. Puro, para que la maqueta pase por el
 * MISMO camino que los datos reales: el cubo, lo que queda y «caduca pronto»
 * los decide el dominio con el «hoy» de Madrid, nunca la plantilla.
 *
 * `uses` llega ya sin los anulados y del más reciente al más antiguo; el
 * recuento de usos vivos sale de ahí, así que es un número de verdad y no el
 * texto que devolvería un `count(*)` de node-postgres.
 */
export function buildCouponsPageData(
  householdId: string,
  todayISO: string,
  rows: readonly CouponRow[],
  uses: readonly CouponUseRow[]
): CouponsPageData {
  const today = localDate(todayISO);
  const usesByCoupon = new Map<string, CouponUseView[]>();
  for (const use of uses) {
    const list = usesByCoupon.get(use.couponId) ?? [];
    list.push({ id: use.id, usedOn: use.usedOn, usedByName: use.usedByName?.trim() || UNKNOWN_PERSON });
    usesByCoupon.set(use.couponId, list);
  }

  const coupons = rows.map((row): CouponView => {
    const couponUses = usesByCoupon.get(row.id) ?? [];
    const facts: CouponFacts = {
      maxUses: row.maxUses,
      liveUses: couponUses.length,
      expiresOn: row.expiresOn === null ? null : localDate(row.expiresOn),
      discarded: row.discardedAt !== null
    };
    return {
      id: row.id,
      merchant: row.merchant,
      offer: row.offer,
      code: row.code,
      expiresOn: row.expiresOn,
      maxUses: row.maxUses,
      liveUses: facts.liveUses,
      remaining: remainingUses(facts),
      notes: row.notes,
      bucket: couponBucket(facts, today),
      expiresSoon: expiresSoon(facts, today),
      discardedAt: row.discardedAt,
      createdAt: row.createdAt,
      createdByName: row.createdByName?.trim() || UNKNOWN_PERSON,
      photoUrl: couponPhotoUrl(householdId, row.id, row.photoStorageObjectId),
      uses: couponUses
    };
  });

  return { today: todayISO, coupons, merchants: merchantsFrom(coupons), counts: countByBucket(coupons) };
}

/**
 * La cartera de cupones del hogar, leída bajo RLS. Solo la familia ve filas
 * (0039): a cualquier otro papel la base le devuelve cero cupones, aunque la
 * ruta ya le cierre el paso antes. Devuelve null sin pool o sin membresía
 * autorizada; cualquier otro fallo sale como 503 (`unreadable`).
 *
 * Y a quien no tiene `coupon.access` ni se le pregunta: la cartera vacía sale
 * sin consultar. Es la segunda reja (spec §9) en el único camino GET que se
 * salta el 403 del layout: un `__data.json` con `x-sveltekit-invalidated` que
 * da el layout por válido y ejecuta solo este `load` (revisión de seguridad,
 * ronda 2, m1). La membresía y su papel son los que acaba de leer la
 * transacción, no los de la sesión.
 */
export async function loadCoupons(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  now: Date = new Date()
): Promise<CouponsPageData | null> {
  if (!pool) return null;
  const todayISO = MADRID_DATE.format(now);
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (!can(membership.role, 'coupon.access')) return buildCouponsPageData(householdId, todayISO, [], []);

      // Los nombres salen de `app.coupon_people()`, que se los da a toda la
      // familia y a nadie más; si uno no llega, el LEFT JOIN da null y se pone
      // una etiqueta neutra.
      const couponResult = await client.query<{
        id: string;
        merchant: string;
        offer: string;
        code: string | null;
        expiresOn: string | null;
        maxUses: number | null;
        notes: string | null;
        discardedAt: Date | null;
        createdAt: Date;
        createdByName: string | null;
        photoStorageObjectId: string;
      }>(
        `select coupon.id,
                coupon.merchant,
                coupon.offer,
                coupon.code,
                coupon.expires_on::text as "expiresOn",
                coupon.max_uses as "maxUses",
                coupon.notes,
                coupon.discarded_at as "discardedAt",
                coupon.created_at as "createdAt",
                person.display_name as "createdByName",
                coupon.photo_storage_object_id as "photoStorageObjectId"
           from app.coupons as coupon
           left join app.coupon_people() as person
             on person.membership_id = coupon.created_by_membership_id
          where coupon.household_id = $1
          order by coupon.created_at desc, coupon.id`,
        [householdId]
      );

      const useResult = await client.query<CouponUseRow>(
        `select coupon_use.id,
                coupon_use.coupon_id as "couponId",
                coupon_use.used_on::text as "usedOn",
                person.display_name as "usedByName"
           from app.coupon_uses as coupon_use
           left join app.coupon_people() as person
             on person.membership_id = coupon_use.used_by_membership_id
          where coupon_use.household_id = $1
            and coupon_use.voided_at is null
          order by coupon_use.used_on desc, coupon_use.recorded_at desc, coupon_use.id desc`,
        [householdId]
      );

      const rows: CouponRow[] = couponResult.rows.map((row) => ({
        ...row,
        discardedAt: row.discardedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString()
      }));
      return buildCouponsPageData(householdId, todayISO, rows, useResult.rows);
    });
  } catch (cause) {
    return unreadable(log, 'coupons', cause);
  }
}
