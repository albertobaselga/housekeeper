import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type CommandAckV1,
  type CommandEnvelopeV1,
  type CouponCreatePayloadV1,
  type UUID,
} from "@housekeeper/contracts";

import { couponCommandHandlers } from "./commands/coupon.js";
import type { AuthenticatedPrincipal } from "./database.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = "it_housekeeper_app_login";

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const OLIVO_HOUSEHOLD = "20000000-0000-4000-8000-000000000001";

const ROBLE_ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const ROBLE_FAMILY_MEMBERSHIP = "11000000-0000-4000-8000-000000000002";
const ROBLE_EMPLOYEE_MEMBERSHIP = "11000000-0000-4000-8000-000000000003";
const OLIVO_ADMIN_MEMBERSHIP = "21000000-0000-4000-8000-000000000001";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const FAMILY: AuthenticatedPrincipal = { userId: "fixture:roble:family" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };
const HELPER: AuthenticatedPrincipal = { userId: "fixture:roble:helper" };
const VIEWER: AuthenticatedPrincipal = { userId: "fixture:roble:viewer" };
const OLIVO_ADMIN: AuthenticatedPrincipal = { userId: "fixture:olivo:admin" };

/*
 * Prefijos propios de esta suite (spec §7.1): `cd…` para el hogar roble y
 * `ce…` para el olivo. Dentro de cada uno, el segundo dígito dice qué es:
 * 1 = foto (storage_object), 2 = cupón, 3 = uso. Forma v4 válida, que es lo
 * que exige el `uuid()` de Zod del contrato.
 */
const id = (prefix: string, n: number): UUID =>
  `${prefix.padEnd(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const robleFoto = (n: number) => id("cd1", n);
const robleCupon = (n: number) => id("cd2", n);
const robleUso = (n: number) => id("cd3", n);
const olivoFoto = (n: number) => id("ce1", n);
const olivoCupon = (n: number) => id("ce2", n);

function envelope(payload: unknown, householdId: UUID = ROBLE_HOUSEHOLD): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId,
    schemaVersion: 1,
    aggregateType: "coupon",
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-10-03T09:00:00.000Z",
    payload,
  };
}

function createPayload(couponId: UUID, photoId: UUID, overrides: Partial<CouponCreatePayloadV1> = {}) {
  return {
    action: "create",
    couponId,
    merchant: "Mercado IT",
    offer: "2x1 en fruta",
    code: "FRUTA-IT",
    expiresOn: "2026-10-31",
    maxUses: 1,
    notes: null,
    photoStorageObjectId: photoId,
    ...overrides,
  } satisfies CouponCreatePayloadV1;
}

/**
 * Comandos de cupón (spec §7.1) contra la base real y bajo RLS, con el login
 * sin BYPASSRLS que comparten las suites del paquete.
 *
 * Lo que se cuida aquí, por orden de gravedad:
 *   · la regla de enlace de la foto: solo una imagen viva que haya subido
 *     quien la enlaza. La política de lectura de la 0039 abre a toda la familia
 *     la foto de cualquier cupón, así que enlazar lo ajeno sería publicarlo;
 *   · el papel: la empleada, el apoyo y el acceso puntual no escriben;
 *   · la idempotencia por id del cliente: «Reintentar» en la bandeja estrena
 *     operationId y no puede duplicar ni un cupón ni un uso;
 *   · D-usos: la casa REGISTRA los usos, no los autoriza.
 */
describe.runIf(Boolean(adminUrl))("comandos de cupones bajo RLS", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(() => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    // Tres conexiones: los usos simultáneos van en dos transacciones a la vez.
    appPool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  async function run(
    principal: AuthenticatedPrincipal,
    payload: unknown,
    householdId: UUID = ROBLE_HOUSEHOLD,
  ): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [envelope(payload, householdId)], couponCommandHandlers);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
  }

  async function accept(principal: AuthenticatedPrincipal, payload: unknown): Promise<CommandAckV1> {
    const ack = await run(principal, payload);
    expect(ack, JSON.stringify(ack)).toMatchObject({ status: "accepted" });
    return ack;
  }

  async function reject(principal: AuthenticatedPrincipal, payload: unknown, errorCode: string): Promise<void> {
    const ack = await run(principal, payload);
    expect(ack, JSON.stringify(ack)).toMatchObject({ status: "rejected", errorCode });
  }

  /** Siembra la foto con el pool de administración, como la dejaría la ruta de adjuntos. */
  async function seedPhoto(
    photoId: UUID,
    options: {
      householdId?: UUID;
      createdBy?: UUID;
      mediaType?: string;
      deleted?: boolean;
    } = {},
  ): Promise<UUID> {
    const mediaType = options.mediaType ?? "image/jpeg";
    const key = `coupons-it/${photoId}${mediaType === "application/pdf" ? ".pdf" : ".jpg"}`;
    await adminPool.query(
      `insert into app.storage_objects
         (id, household_id, bucket, object_key, media_type, byte_size, sha256,
          created_by_membership_id, deleted_at)
       values ($1, $2, 'housekeeper-it', $3, $4, 2048, $5, $6,
               case when $7 then statement_timestamp() else null end)`,
      [
        photoId,
        options.householdId ?? ROBLE_HOUSEHOLD,
        key,
        mediaType,
        createHash("sha256").update(key).digest("hex"),
        options.createdBy ?? ROBLE_FAMILY_MEMBERSHIP,
        options.deleted ?? false,
      ],
    );
    return photoId;
  }

  async function couponRow(couponId: UUID, householdId: UUID = ROBLE_HOUSEHOLD) {
    const result = await adminPool.query<{
      merchant: string;
      offer: string;
      code: string | null;
      expiresOn: string | null;
      maxUses: number | null;
      notes: string | null;
      photo: string;
      createdBy: string;
      discardedAt: Date | null;
      discardedBy: string | null;
    }>(
      `select merchant, offer, code, expires_on::text as "expiresOn", max_uses as "maxUses",
              notes, photo_storage_object_id as photo, created_by_membership_id as "createdBy",
              discarded_at as "discardedAt", discarded_by_membership_id as "discardedBy"
         from app.coupons where household_id = $1 and id = $2`,
      [householdId, couponId],
    );
    return result.rows[0] ?? null;
  }

  async function couponCount(couponId: UUID): Promise<number> {
    const result = await adminPool.query<{ count: string }>(
      "select count(*)::text as count from app.coupons where id = $1",
      [couponId],
    );
    return Number(result.rows[0]!.count);
  }

  async function usesOf(couponId: UUID) {
    const result = await adminPool.query<{
      id: string;
      usedOn: string;
      usedBy: string;
      voidedAt: Date | null;
      voidedBy: string | null;
    }>(
      `select id, used_on::text as "usedOn", used_by_membership_id as "usedBy",
              voided_at as "voidedAt", voided_by_membership_id as "voidedBy"
         from app.coupon_uses where household_id = $1 and coupon_id = $2
        order by recorded_at, id`,
      [ROBLE_HOUSEHOLD, couponId],
    );
    return result.rows;
  }

  /** Un cupón ya guardado por la familia no administradora, con su foto. */
  async function seedCoupon(n: number, overrides: Partial<CouponCreatePayloadV1> = {}): Promise<UUID> {
    const photoId = await seedPhoto(robleFoto(n));
    await accept(FAMILY, createPayload(robleCupon(n), photoId, overrides));
    return robleCupon(n);
  }

  // ── Alta ─────────────────────────────────────────────────────────────────

  it("create guarda el cupón a nombre de quien lo guarda, en la cartera", async () => {
    const photoId = await seedPhoto(robleFoto(1));
    const ack = await accept(
      FAMILY,
      createPayload(robleCupon(1), photoId, { code: "  FRUTA-IT  ", notes: "   ", maxUses: 5 }),
    );
    expect(ack.resourceId).toBe(robleCupon(1));

    expect(await couponRow(robleCupon(1))).toEqual({
      merchant: "Mercado IT",
      offer: "2x1 en fruta",
      // El contrato recorta y convierte en null lo que queda en blanco.
      code: "FRUTA-IT",
      expiresOn: "2026-10-31",
      maxUses: 5,
      notes: null,
      photo: photoId,
      createdBy: ROBLE_FAMILY_MEMBERSHIP,
      discardedAt: null,
      discardedBy: null,
    });
  });

  it("create es idempotente por id del cliente aunque «Reintentar» cambie el operationId", async () => {
    const photoId = await seedPhoto(robleFoto(2));
    await accept(FAMILY, createPayload(robleCupon(2), photoId));
    // Otro operationId (envelope nuevo), mismos hechos: aceptado y sin duplicar.
    const again = await accept(FAMILY, createPayload(robleCupon(2), photoId));
    expect(again.resourceId).toBe(robleCupon(2));
    expect(await couponCount(robleCupon(2))).toBe(1);
  });

  it("la administración también guarda cupones con su propia foto", async () => {
    const photoId = await seedPhoto(robleFoto(3), { createdBy: ROBLE_ADMIN_MEMBERSHIP });
    await accept(ADMIN, createPayload(robleCupon(3), photoId));
    expect((await couponRow(robleCupon(3)))!.createdBy).toBe(ROBLE_ADMIN_MEMBERSHIP);
  });

  // ── La regla de enlace de la foto ────────────────────────────────────────

  it("una foto que subió OTRA persona no se enlaza, ni siquiera siendo administración", async () => {
    // La administración ve todos los objetos del hogar (0005): sin la regla,
    // podría colgar de un cupón el justificante de la empleada y publicarlo
    // para toda la familia.
    const ajena = await seedPhoto(robleFoto(10), { createdBy: ROBLE_EMPLOYEE_MEMBERSHIP });
    await reject(ADMIN, createPayload(robleCupon(10), ajena), "coupon_photo_invalid");
    const deLaFamilia = await seedPhoto(robleFoto(11), { createdBy: ROBLE_FAMILY_MEMBERSHIP });
    await reject(ADMIN, createPayload(robleCupon(11), deLaFamilia), "coupon_photo_invalid");
    expect(await couponCount(robleCupon(10))).toBe(0);
    expect(await couponCount(robleCupon(11))).toBe(0);
  });

  it("una foto de otro hogar no se enlaza", async () => {
    const deOlivo = await seedPhoto(olivoFoto(1), {
      householdId: OLIVO_HOUSEHOLD,
      createdBy: OLIVO_ADMIN_MEMBERSHIP,
    });
    await reject(FAMILY, createPayload(robleCupon(12), deOlivo), "coupon_photo_invalid");
    expect(await couponCount(robleCupon(12))).toBe(0);
  });

  it("un PDF propio no es la foto de un cupón", async () => {
    const pdf = await seedPhoto(robleFoto(13), { mediaType: "application/pdf" });
    await reject(FAMILY, createPayload(robleCupon(13), pdf), "coupon_photo_invalid");
    expect(await couponCount(robleCupon(13))).toBe(0);
  });

  it("una foto propia borrada tampoco, ni una que no existe", async () => {
    const borrada = await seedPhoto(robleFoto(14), { deleted: true });
    await reject(FAMILY, createPayload(robleCupon(14), borrada), "coupon_photo_invalid");
    await reject(FAMILY, createPayload(robleCupon(15), robleFoto(999)), "coupon_photo_invalid");
    expect(await couponCount(robleCupon(14))).toBe(0);
    expect(await couponCount(robleCupon(15))).toBe(0);
  });

  it("PNG y WebP propios sí valen", async () => {
    const png = await seedPhoto(robleFoto(16), { mediaType: "image/png" });
    await accept(FAMILY, createPayload(robleCupon(16), png));
    const webp = await seedPhoto(robleFoto(17), { mediaType: "image/webp" });
    await accept(FAMILY, createPayload(robleCupon(17), webp));
  });

  // ── El papel ─────────────────────────────────────────────────────────────

  it("la empleada, el apoyo y el acceso puntual no escriben nada de cupones", async () => {
    const couponId = await seedCoupon(20);
    const roles: Array<[AuthenticatedPrincipal, UUID]> = [
      [EMPLOYEE, ROBLE_EMPLOYEE_MEMBERSHIP],
      [HELPER, "11000000-0000-4000-8000-000000000004"],
      [VIEWER, "11000000-0000-4000-8000-000000000005"],
    ];
    for (const [principal, membershipId] of roles) {
      // Con una foto suya: lo que para es el papel, no la regla de la foto.
      const own = await seedPhoto(randomUUID(), { createdBy: membershipId });
      const attempts: unknown[] = [
        createPayload(randomUUID(), own),
        {
          action: "update",
          couponId,
          merchant: "Otro",
          offer: "Otra",
          code: null,
          expiresOn: null,
          maxUses: null,
          notes: null,
        },
        { action: "use", couponId, useId: randomUUID(), usedOn: "2026-10-03" },
        { action: "void_use", couponId, useId: randomUUID() },
        { action: "discard", couponId },
        { action: "restore", couponId },
      ];
      for (const payload of attempts) {
        await reject(principal, payload, "not_allowed");
      }
    }
    expect((await couponRow(couponId))!.merchant).toBe("Mercado IT");
    expect(await usesOf(couponId)).toEqual([]);
  });

  it("un payload que no cumple el contrato se rechaza con invalid_payload", async () => {
    await reject(FAMILY, { action: "use", couponId: robleCupon(21) }, "invalid_payload");
    await reject(FAMILY, { action: "canjear", couponId: robleCupon(21) }, "invalid_payload");
  });

  // ── Editar ───────────────────────────────────────────────────────────────

  it("update sustituye los campos editables y conserva la foto si no viene", async () => {
    const couponId = await seedCoupon(30);
    const photoBefore = (await couponRow(couponId))!.photo;
    // Edita OTRA persona de la familia (D-reparto): la autoría no cambia.
    await accept(ADMIN, {
      action: "update",
      couponId,
      merchant: "Mercado Central IT",
      offer: "3x2 en verdura",
      code: null,
      expiresOn: null,
      maxUses: null,
      notes: "Solo los martes",
    });
    expect(await couponRow(couponId)).toMatchObject({
      merchant: "Mercado Central IT",
      offer: "3x2 en verdura",
      code: null,
      expiresOn: null,
      maxUses: null,
      notes: "Solo los martes",
      photo: photoBefore,
      createdBy: ROBLE_FAMILY_MEMBERSHIP,
    });
  });

  it("update con la foto que ya tenía no la vuelve a juzgar, aunque la subiera otra persona", async () => {
    const couponId = await seedCoupon(31);
    const photo = (await couponRow(couponId))!.photo;
    await accept(ADMIN, {
      action: "update",
      couponId,
      merchant: "Mercado IT",
      offer: "2x1 en fruta",
      code: "FRUTA-IT",
      expiresOn: "2026-11-30",
      maxUses: 1,
      notes: null,
      photoStorageObjectId: photo,
    });
    expect((await couponRow(couponId))!.expiresOn).toBe("2026-11-30");
  });

  it("update cambia la foto solo por una imagen viva y propia", async () => {
    const couponId = await seedCoupon(32);
    const base = {
      action: "update",
      couponId,
      merchant: "Mercado IT",
      offer: "2x1 en fruta",
      code: "FRUTA-IT",
      expiresOn: "2026-10-31",
      maxUses: 1,
      notes: null,
    };
    const ajena = await seedPhoto(robleFoto(33), { createdBy: ROBLE_EMPLOYEE_MEMBERSHIP });
    await reject(ADMIN, { ...base, photoStorageObjectId: ajena }, "coupon_photo_invalid");
    const pdf = await seedPhoto(robleFoto(34), { createdBy: ROBLE_ADMIN_MEMBERSHIP, mediaType: "application/pdf" });
    await reject(ADMIN, { ...base, photoStorageObjectId: pdf }, "coupon_photo_invalid");
    expect((await couponRow(couponId))!.photo).toBe(robleFoto(32));

    const propia = await seedPhoto(robleFoto(35), { createdBy: ROBLE_ADMIN_MEMBERSHIP, mediaType: "image/png" });
    await accept(ADMIN, { ...base, photoStorageObjectId: propia });
    expect((await couponRow(couponId))!.photo).toBe(propia);
  });

  it("update de un cupón que no existe, o de otro hogar, es coupon_not_found", async () => {
    const update = {
      action: "update",
      couponId: robleCupon(36),
      merchant: "Nadie",
      offer: "Nada",
      code: null,
      expiresOn: null,
      maxUses: null,
      notes: null,
    };
    await reject(FAMILY, update, "coupon_not_found");

    const couponId = await seedCoupon(37);
    // El olivo no ve el cupón del roble: para él, no existe.
    const ack = await run(OLIVO_ADMIN, { ...update, couponId }, OLIVO_HOUSEHOLD);
    expect(ack).toMatchObject({ status: "rejected", errorCode: "coupon_not_found" });
    expect((await couponRow(couponId))!.merchant).toBe("Mercado IT");
  });

  // ── Usar y anular ────────────────────────────────────────────────────────

  it("use apunta el uso a nombre de quien lo usa, con la fecha local del cliente", async () => {
    const couponId = await seedCoupon(40);
    const ack = await accept(ADMIN, { action: "use", couponId, useId: robleUso(40), usedOn: "2026-10-02" });
    expect(ack.resourceId).toBe(robleUso(40));
    expect(await usesOf(couponId)).toEqual([
      { id: robleUso(40), usedOn: "2026-10-02", usedBy: ROBLE_ADMIN_MEMBERSHIP, voidedAt: null, voidedBy: null },
    ]);
  });

  it("use es idempotente por useId aunque cambie el operationId", async () => {
    const couponId = await seedCoupon(41);
    const use = { action: "use", couponId, useId: robleUso(41), usedOn: "2026-10-03" };
    await accept(FAMILY, use);
    await accept(FAMILY, use);
    expect(await usesOf(couponId)).toHaveLength(1);
  });

  it("dos usos a la vez desde dos móviles quedan como dos usos", async () => {
    const couponId = await seedCoupon(42, { maxUses: 1 });
    const [first, second] = await Promise.all([
      run(FAMILY, { action: "use", couponId, useId: robleUso(42), usedOn: "2026-10-03" }),
      run(ADMIN, { action: "use", couponId, useId: robleUso(43), usedOn: "2026-10-03" }),
    ]);
    expect(first).toMatchObject({ status: "accepted" });
    expect(second).toMatchObject({ status: "accepted" });
    // Un cupón de un solo uso con dos usos: la casa registra lo que pasó en
    // caja, no lo autoriza (D-usos).
    expect((await usesOf(couponId)).map((use) => use.id).sort()).toEqual([robleUso(42), robleUso(43)]);
  });

  it("D-usos: usar uno descartado, caducado o agotado se apunta igual", async () => {
    const agotado = await seedCoupon(44, { maxUses: 1 });
    await accept(FAMILY, { action: "use", couponId: agotado, useId: robleUso(44), usedOn: "2026-10-03" });
    await accept(FAMILY, { action: "use", couponId: agotado, useId: robleUso(45), usedOn: "2026-10-03" });
    expect(await usesOf(agotado)).toHaveLength(2);

    const caducado = await seedCoupon(46, { expiresOn: "2026-01-31" });
    await accept(FAMILY, { action: "use", couponId: caducado, useId: robleUso(46), usedOn: "2026-10-03" });
    expect(await usesOf(caducado)).toHaveLength(1);

    const descartado = await seedCoupon(47);
    await accept(ADMIN, { action: "discard", couponId: descartado });
    await accept(FAMILY, { action: "use", couponId: descartado, useId: robleUso(47), usedOn: "2026-10-03" });
    expect(await usesOf(descartado)).toHaveLength(1);
  });

  it("use de un cupón inexistente, o de otro hogar, es coupon_not_found y no deja uso", async () => {
    await reject(FAMILY, { action: "use", couponId: robleCupon(48), useId: robleUso(48), usedOn: "2026-10-03" }, "coupon_not_found");

    const couponId = await seedCoupon(49);
    const ack = await run(
      OLIVO_ADMIN,
      { action: "use", couponId, useId: id("ce3", 49), usedOn: "2026-10-03" },
      OLIVO_HOUSEHOLD,
    );
    expect(ack).toMatchObject({ status: "rejected", errorCode: "coupon_not_found" });
    expect(await usesOf(couponId)).toEqual([]);
  });

  it("void_use anula a nombre de quien anula, y anular dos veces converge", async () => {
    const couponId = await seedCoupon(50);
    await accept(FAMILY, { action: "use", couponId, useId: robleUso(50), usedOn: "2026-10-03" });

    // Anula OTRA persona de la familia (D-reparto), a su nombre.
    const ack = await accept(ADMIN, { action: "void_use", couponId, useId: robleUso(50) });
    expect(ack.resourceId).toBe(robleUso(50));
    const [voided] = await usesOf(couponId);
    expect(voided).toMatchObject({ usedBy: ROBLE_FAMILY_MEMBERSHIP, voidedBy: ROBLE_ADMIN_MEMBERSHIP });
    expect(voided!.voidedAt).not.toBeNull();

    // El segundo toque (o la cola que reintenta) no reescribe la anulación.
    await accept(FAMILY, { action: "void_use", couponId, useId: robleUso(50) });
    const [again] = await usesOf(couponId);
    expect(again).toEqual(voided);
  });

  it("void_use de un uso que no existe, o de otro cupón, es coupon_use_not_found", async () => {
    const couponId = await seedCoupon(51);
    const otherId = await seedCoupon(52);
    await accept(FAMILY, { action: "use", couponId, useId: robleUso(51), usedOn: "2026-10-03" });

    await reject(FAMILY, { action: "void_use", couponId, useId: robleUso(59) }, "coupon_use_not_found");
    await reject(FAMILY, { action: "void_use", couponId: otherId, useId: robleUso(51) }, "coupon_use_not_found");
    const [use] = await usesOf(couponId);
    expect(use!.voidedAt).toBeNull();
  });

  // ── Descartar y recuperar ────────────────────────────────────────────────

  it("discard firma el descarte de quien descarta, y descartar dos veces converge", async () => {
    const couponId = await seedCoupon(60);
    await accept(ADMIN, { action: "discard", couponId });
    const discarded = await couponRow(couponId);
    expect(discarded!.discardedBy).toBe(ROBLE_ADMIN_MEMBERSHIP);
    expect(discarded!.discardedAt).not.toBeNull();

    // Otra persona descarta lo ya descartado: nada cambia, ni la firma.
    await accept(FAMILY, { action: "discard", couponId });
    expect(await couponRow(couponId)).toEqual(discarded);
  });

  it("restore lo devuelve a la cartera, y recuperar dos veces converge", async () => {
    const couponId = await seedCoupon(61);
    await accept(FAMILY, { action: "discard", couponId });
    await accept(ADMIN, { action: "restore", couponId });
    expect(await couponRow(couponId)).toMatchObject({ discardedAt: null, discardedBy: null });
    await accept(FAMILY, { action: "restore", couponId });
    expect(await couponRow(couponId)).toMatchObject({ discardedAt: null, discardedBy: null });

    // Y se puede volver a descartar, con la firma nueva.
    await accept(FAMILY, { action: "discard", couponId });
    expect((await couponRow(couponId))!.discardedBy).toBe(ROBLE_FAMILY_MEMBERSHIP);
  });

  it("descartar o recuperar un cupón que no existe, o de otro hogar, es coupon_not_found", async () => {
    await reject(FAMILY, { action: "discard", couponId: robleCupon(62) }, "coupon_not_found");
    await reject(FAMILY, { action: "restore", couponId: robleCupon(62) }, "coupon_not_found");

    const couponId = await seedCoupon(63);
    for (const action of ["discard", "restore"]) {
      const ack = await run(OLIVO_ADMIN, { action, couponId }, OLIVO_HOUSEHOLD);
      expect(ack).toMatchObject({ status: "rejected", errorCode: "coupon_not_found" });
    }
    expect((await couponRow(couponId))!.discardedAt).toBeNull();
  });

  it("el olivo gestiona su propia cartera sin tocar la del roble", async () => {
    const photo = await seedPhoto(olivoFoto(2), { householdId: OLIVO_HOUSEHOLD, createdBy: OLIVO_ADMIN_MEMBERSHIP });
    const ack = await run(OLIVO_ADMIN, createPayload(olivoCupon(2), photo), OLIVO_HOUSEHOLD);
    expect(ack).toMatchObject({ status: "accepted" });
    expect((await couponRow(olivoCupon(2), OLIVO_HOUSEHOLD))!.createdBy).toBe(OLIVO_ADMIN_MEMBERSHIP);
    expect(await couponRow(olivoCupon(2))).toBeNull();
  });
});
