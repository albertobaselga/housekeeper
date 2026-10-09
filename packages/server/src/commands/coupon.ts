import type { PoolClient } from "pg";

import type {
  CouponCreatePayloadV1,
  CouponUpdatePayloadV1,
  CouponUsePayloadV1,
  CouponVoidUsePayloadV1,
  UUID,
} from "@housekeeper/contracts";
import { couponCommandPayloadSchema } from "@housekeeper/contracts/schemas";

import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler, type CommandHandlers } from "../sync.js";
import { requireFamilyRole } from "./food.js";

/**
 * Lo único que puede ser la foto de un cupón. Es la misma lista que exige el
 * disparador `coupons_photo_link` de la 0039: si se separan, el comando
 * aceptaría algo que la base para con un 42501, que el despachador trata como
 * avería reintentable y no como rechazo.
 */
const COUPON_PHOTO_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

function couponNotFound(): CommandRejectedError {
  return new CommandRejectedError("coupon_not_found", "El cupón no existe en este hogar");
}

/**
 * La regla de enlace de la foto (spec §7.1), ANTES de escribir: el objeto
 * existe en el hogar, lo subió quien lo enlaza, no está borrado y es una
 * imagen. Nunca «cualquier objeto visible»: la administración ve todos los
 * objetos del hogar (0005) —el tique de un gasto de la empleada, un
 * justificante privado— y la política de lectura de la 0039 abre a toda la
 * familia la foto de cualquier cupón. Enlazar lo ajeno sería publicarlo.
 *
 * El disparador `coupons_photo_link` dice lo mismo en la base, pero con un
 * 42501 sin nombre; aquí sale con un código que la bandeja sabe traducir. Lo
 * ajeno, lo borrado, lo de otro hogar y lo inexistente colapsan en el mismo
 * rechazo: quien enlaza no tiene por qué saber cuál de las cosas falló.
 */
async function requireOwnCouponPhoto(
  client: PoolClient,
  householdId: UUID,
  membership: ActiveMembership,
  storageObjectId: UUID,
): Promise<void> {
  const photo = await client.query(
    `select 1
       from app.storage_objects
      where household_id = $1 and id = $2
        and created_by_membership_id = $3
        and deleted_at is null
        and media_type = any($4::text[])`,
    [householdId, storageObjectId, membership.id, COUPON_PHOTO_MEDIA_TYPES],
  );
  if ((photo.rowCount ?? 0) === 0) {
    throw new CommandRejectedError(
      "coupon_photo_invalid",
      "La foto no existe en este hogar, no la subiste tú o no es una imagen",
    );
  }
}

async function couponExists(client: PoolClient, householdId: UUID, couponId: UUID): Promise<boolean> {
  const found = await client.query(`select 1 from app.coupons where household_id = $1 and id = $2`, [
    householdId,
    couponId,
  ]);
  return (found.rowCount ?? 0) > 0;
}

/**
 * Alta idempotente por el id que pone el cliente: «Reintentar» en la bandeja
 * estrena operationId, y el recibo de idempotencia no lo reconoce; la clave
 * primaria sí. El cupón nace en la cartera —sin `discarded_*`, que la política
 * de INSERT tampoco admitiría— y a nombre de quien lo guarda.
 */
async function createCoupon(
  client: PoolClient,
  householdId: UUID,
  membership: ActiveMembership,
  payload: CouponCreatePayloadV1,
): Promise<{ resourceId: UUID }> {
  await requireOwnCouponPhoto(client, householdId, membership, payload.photoStorageObjectId);
  await client.query(
    `insert into app.coupons
       (household_id, id, merchant, offer, code, expires_on, max_uses, notes,
        photo_storage_object_id, created_by_membership_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (household_id, id) do nothing`,
    [
      householdId,
      payload.couponId,
      payload.merchant,
      payload.offer,
      payload.code,
      payload.expiresOn,
      payload.maxUses,
      payload.notes,
      payload.photoStorageObjectId,
      membership.id,
    ],
  );
  return { resourceId: payload.couponId };
}

/**
 * Sustitución completa de los campos editables; la foto, solo si viene.
 *
 * La regla de la foto se aplica cuando la foto CAMBIA, igual que en la base:
 * reenviar la que ya tiene —que quizá subió otra persona de la familia— no es
 * enlazar nada nuevo. Para saberlo hay que leer la fila, y se lee `for update`
 * para que otra edición simultánea no cambie la foto entre esta lectura y la
 * escritura: entonces el disparador vería un cambio que el comando no juzgó.
 */
async function updateCoupon(
  client: PoolClient,
  householdId: UUID,
  membership: ActiveMembership,
  payload: CouponUpdatePayloadV1,
): Promise<{ resourceId: UUID }> {
  const current = await client.query<{ photoStorageObjectId: string }>(
    `select photo_storage_object_id as "photoStorageObjectId"
       from app.coupons
      where household_id = $1 and id = $2
      for update`,
    [householdId, payload.couponId],
  );
  const row = current.rows[0];
  if (!row) throw couponNotFound();

  // `!== undefined`, nunca `in`: el esquema conserva la clave aunque llegue
  // con `undefined` (contrato, CouponUpdatePayloadV1).
  const photoStorageObjectId = payload.photoStorageObjectId ?? row.photoStorageObjectId;
  if (photoStorageObjectId !== row.photoStorageObjectId) {
    await requireOwnCouponPhoto(client, householdId, membership, photoStorageObjectId);
  }

  await client.query(
    `update app.coupons
        set merchant = $3, offer = $4, code = $5, expires_on = $6, max_uses = $7, notes = $8,
            photo_storage_object_id = $9
      where household_id = $1 and id = $2`,
    [
      householdId,
      payload.couponId,
      payload.merchant,
      payload.offer,
      payload.code,
      payload.expiresOn,
      payload.maxUses,
      payload.notes,
      photoStorageObjectId,
    ],
  );
  return { resourceId: payload.couponId };
}

/**
 * Apunta un uso. NO se mira si el cupón está agotado, caducado o descartado
 * (D-usos): la casa registra lo que pasó en caja, no lo autoriza, y dos móviles
 * sin red pueden gastar el último uso a la vez. Por eso tampoco hay bloqueo
 * por cupón: dos usos simultáneos son dos filas.
 *
 * Que el cupón exista se pregunta ANTES: si no, el EXISTS del WITH CHECK de
 * `coupon_uses_family_insert` lo pararía con un 42501, que el despachador no
 * sabe distinguir de una avería.
 */
async function useCoupon(
  client: PoolClient,
  householdId: UUID,
  membership: ActiveMembership,
  payload: CouponUsePayloadV1,
): Promise<{ resourceId: UUID }> {
  if (!(await couponExists(client, householdId, payload.couponId))) throw couponNotFound();
  await client.query(
    `insert into app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id)
     values ($1, $2, $3, $4, $5)
     on conflict (household_id, id) do nothing`,
    [householdId, payload.useId, payload.couponId, payload.usedOn, membership.id],
  );
  return { resourceId: payload.useId };
}

/**
 * Anula un uso a nombre de quien anula, y solo toca `voided_*` (lo demás lo
 * congela `coupon_uses_keep_record`). Anular dos veces converge: un uso ya
 * anulado no es candidato del UPDATE —la política solo deja ver los vivos— y
 * se acepta sin reescribir la primera firma, como deshacer una rutina (0031).
 */
async function voidCouponUse(
  client: PoolClient,
  householdId: UUID,
  membership: ActiveMembership,
  payload: CouponVoidUsePayloadV1,
): Promise<{ resourceId: UUID }> {
  const voided = await client.query(
    `update app.coupon_uses
        set voided_at = statement_timestamp(),
            voided_by_membership_id = $4
      where household_id = $1 and id = $2 and coupon_id = $3
        and voided_at is null`,
    [householdId, payload.useId, payload.couponId, membership.id],
  );
  if ((voided.rowCount ?? 0) > 0) return { resourceId: payload.useId };

  const existing = await client.query(
    `select 1 from app.coupon_uses where household_id = $1 and id = $2 and coupon_id = $3`,
    [householdId, payload.useId, payload.couponId],
  );
  if ((existing.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("coupon_use_not_found", "Ese uso no existe en este cupón");
  }
  return { resourceId: payload.useId };
}

/**
 * Descartar y recuperar, en una sola escritura convergente (patrón
 * `setArchived`, commands/food.ts): solo se toca la fila que está en el estado
 * contrario, así que ni un descarte vigente se vuelve a firmar —lo prohíbe
 * además `coupons_keep_identity`— ni repetir el gesto es un error. La firma
 * del descarte es siempre la de quien escribe; la base la exige.
 */
async function setDiscarded(
  client: PoolClient,
  householdId: UUID,
  membership: ActiveMembership,
  couponId: UUID,
  discarded: boolean,
): Promise<{ resourceId: UUID }> {
  const updated = await client.query(
    `update app.coupons
        set discarded_at = case when $3 then statement_timestamp() else null end,
            discarded_by_membership_id = case when $3 then $4::uuid else null end
      where household_id = $1 and id = $2
        and (discarded_at is null) = $3`,
    [householdId, couponId, discarded, membership.id],
  );
  if ((updated.rowCount ?? 0) === 0 && !(await couponExists(client, householdId, couponId))) {
    throw couponNotFound();
  }
  return { resourceId: couponId };
}

/**
 * `coupon`: la cartera de cupones de la familia (spec §7.1).
 *
 * Orden FIJO, como en `financeCommandHandler`:
 *   1. El papel. Solo `family_admin` y `family_member` (D-audiencia); la
 *      empleada, el apoyo y el acceso puntual no llegan ni a validar la forma.
 *      Es el mismo `not_allowed` de los demás módulos de la familia.
 *   2. La forma, con el esquema del contrato.
 *   3. El SQL, bajo la RLS de quien escribe (la transacción ya viene
 *      autorizada desde `processSyncBatch`).
 *   4. Un `switch` exhaustivo: una acción nueva sin `case` no compila.
 *
 * Todos los ids (cupón y uso) los pone el cliente, de modo que cada acción es
 * idempotente aunque «Reintentar» cambie el operationId.
 */
export const couponCommandHandler: CommandHandler = async (client, membership, envelope) => {
  requireFamilyRole(membership.role, "los cupones");
  const parsed = couponCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  const householdId = envelope.householdId;

  switch (payload.action) {
    case "create":
      return createCoupon(client, householdId, membership, payload);
    case "update":
      return updateCoupon(client, householdId, membership, payload);
    case "use":
      return useCoupon(client, householdId, membership, payload);
    case "void_use":
      return voidCouponUse(client, householdId, membership, payload);
    case "discard":
      return setDiscarded(client, householdId, membership, payload.couponId, true);
    case "restore":
      return setDiscarded(client, householdId, membership, payload.couponId, false);
    default: {
      const _exhaustive: never = payload;
      throw new CommandRejectedError("invalid_payload", "Acción de cupón desconocida");
    }
  }
};

/** Handler de cupones listo para `processSyncBatch` (spread en la ruta de sync). */
export const couponCommandHandlers: CommandHandlers = {
  coupon: couponCommandHandler,
};
