import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import { hasCapability, roleCapabilities } from "./capabilities.js";
import {
  API_VERSION,
  type CouponCommandPayloadV1,
  type CouponCreatePayloadV1,
  type CouponDiscardPayloadV1,
  type CouponRestorePayloadV1,
  type CouponUpdatePayloadV1,
  type CouponUsePayloadV1,
  type CouponVoidUsePayloadV1,
} from "./index.js";
import {
  commandEnvelopeSchema,
  couponCommandPayloadSchema,
  couponCreatePayloadSchema,
  couponDiscardPayloadSchema,
  couponRestorePayloadSchema,
  couponUpdatePayloadSchema,
  couponUsePayloadSchema,
  couponVoidUsePayloadSchema,
} from "./schemas.js";

// Identificadores sintéticos: el prefijo `cd` es el del hogar «roble» en las
// pruebas del módulo (spec §7.1).
const COUPON = "cd100000-0000-4000-8000-000000000001";
const USE = "cd200000-0000-4000-8000-000000000001";
const PHOTO = "cd300000-0000-4000-8000-000000000001";
const OTHER_PHOTO = "cd300000-0000-4000-8000-000000000002";

const COUPON_ACTIONS = ["create", "update", "use", "void_use", "discard", "restore"];

const create = {
  action: "create",
  couponId: COUPON,
  merchant: "Súper del barrio",
  offer: "10 % en fruta",
  code: "FRUTA10",
  expiresOn: "2026-10-31",
  maxUses: 1,
  notes: "Solo de lunes a jueves",
  photoStorageObjectId: PHOTO,
};

const update = {
  action: "update",
  couponId: COUPON,
  merchant: "Súper del barrio",
  offer: "15 % en fruta",
  code: null,
  expiresOn: null,
  maxUses: null,
  notes: null,
};

function accepts(payload: unknown): boolean {
  return couponCommandPayloadSchema.safeParse(payload).success;
}

describe("capacidad coupon.access (spec §5, D-audiencia)", () => {
  it("la tiene la familia —administración y resto— y nadie más", () => {
    expect(hasCapability("family_admin", "coupon.access")).toBe(true);
    expect(hasCapability("family_member", "coupon.access")).toBe(true);
    expect(hasCapability("employee_live_in", "coupon.access")).toBe(false);
    expect(hasCapability("helper", "coupon.access")).toBe(false);
    expect(hasCapability("viewer", "coupon.access")).toBe(false);
  });

  it("ningún papel repite una capacidad en su lista", () => {
    for (const grants of Object.values(roleCapabilities)) {
      expect(new Set(grants).size).toBe(grants.length);
    }
  });
});

describe("payloads de cupones: una forma válida por acción", () => {
  it("create acepta todos los campos y conserva la acción", () => {
    const parsed = couponCreatePayloadSchema.parse(create);
    expect(parsed).toEqual(create);
  });

  it("create admite los opcionales a null: sin código, sin caducidad, sin límite de usos, sin notas", () => {
    const parsed = couponCreatePayloadSchema.parse({
      ...create,
      code: null,
      expiresOn: null,
      maxUses: null,
      notes: null,
    });
    expect(parsed.code).toBeNull();
    expect(parsed.expiresOn).toBeNull();
    expect(parsed.maxUses).toBeNull();
    expect(parsed.notes).toBeNull();
  });

  it("update sustituye los campos editables y deja la foto como está si no viaja", () => {
    const parsed = couponUpdatePayloadSchema.parse(update);
    expect(parsed).toEqual(update);
    expect("photoStorageObjectId" in parsed).toBe(false);
  });

  it("update con la foto a undefined: la clave sigue ahí, así que el handler mira el valor, no `in`", () => {
    // Zod conserva la clave que llega con `undefined`. La interfaz lo dice
    // (`?: UUID | undefined`) para que nadie pregunte con `in` y crea que hay
    // foto nueva.
    const parsed = couponUpdatePayloadSchema.parse({ ...update, photoStorageObjectId: undefined });
    expect("photoStorageObjectId" in parsed).toBe(true);
    expect(parsed.photoStorageObjectId).toBeUndefined();
    const typed: CouponUpdatePayloadV1 = {
      action: "update",
      couponId: COUPON,
      merchant: "Súper del barrio",
      offer: "15 % en fruta",
      code: null,
      expiresOn: null,
      maxUses: null,
      notes: null,
      // Con `exactOptionalPropertyTypes` esto solo compila si la interfaz admite `undefined`.
      photoStorageObjectId: undefined,
    };
    expect(couponUpdatePayloadSchema.parse(typed)).toEqual(typed);
  });

  it("update acepta una foto nueva", () => {
    expect(couponUpdatePayloadSchema.parse({ ...update, photoStorageObjectId: OTHER_PHOTO }).photoStorageObjectId).toBe(
      OTHER_PHOTO,
    );
  });

  it("use apunta un uso con id del cliente y fecha local", () => {
    const payload = { action: "use", couponId: COUPON, useId: USE, usedOn: "2026-10-03" };
    expect(couponUsePayloadSchema.parse(payload)).toEqual(payload);
  });

  it("void_use anula un uso concreto", () => {
    const payload = { action: "void_use", couponId: COUPON, useId: USE };
    expect(couponVoidUsePayloadSchema.parse(payload)).toEqual(payload);
  });

  it("discard y restore solo llevan el cupón", () => {
    expect(couponDiscardPayloadSchema.parse({ action: "discard", couponId: COUPON })).toEqual({
      action: "discard",
      couponId: COUPON,
    });
    expect(couponRestorePayloadSchema.parse({ action: "restore", couponId: COUPON })).toEqual({
      action: "restore",
      couponId: COUPON,
    });
  });

  it("la unión tiene exactamente las seis acciones de la spec, y cada una entra", () => {
    const actions = couponCommandPayloadSchema.options.map((option) => option.shape.action.value);
    expect(actions).toEqual(COUPON_ACTIONS);
    expect(accepts(create)).toBe(true);
    expect(accepts(update)).toBe(true);
    expect(accepts({ action: "use", couponId: COUPON, useId: USE, usedOn: "2026-10-03" })).toBe(true);
    expect(accepts({ action: "void_use", couponId: COUPON, useId: USE })).toBe(true);
    expect(accepts({ action: "discard", couponId: COUPON })).toBe(true);
    expect(accepts({ action: "restore", couponId: COUPON })).toBe(true);
  });

  it("la unión discrimina por action: un use sin useId da un único error, en useId", () => {
    // Aceptar o rechazar sale igual con `z.union`; lo que cambia es el error.
    // Discriminando, quien depure un `invalid_payload` lee el campo que falta
    // en la acción que pidió, no un `invalid_union` con las seis ramas.
    const result = couponCommandPayloadSchema.safeParse({ action: "use", couponId: COUPON, usedOn: "2026-10-03" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.code, issue.path.join(".")])).toEqual([
      ["invalid_type", "useId"],
    ]);
  });
});

describe("payloads de cupones: texto recortado y vacío como null", () => {
  it("recorta comercio, oferta, código y notas", () => {
    const parsed = couponCreatePayloadSchema.parse({
      ...create,
      merchant: "  Farmacia  ",
      offer: "\t2x1 en cremas \n",
      code: "  ABC-123  ",
      notes: "  Pedirlo en caja  ",
    });
    expect(parsed.merchant).toBe("Farmacia");
    expect(parsed.offer).toBe("2x1 en cremas");
    expect(parsed.code).toBe("ABC-123");
    expect(parsed.notes).toBe("Pedirlo en caja");
  });

  it("una cadena vacía o en blanco en un opcional se guarda como null, no como \"\"", () => {
    const parsed = couponCreatePayloadSchema.parse({ ...create, code: "", expiresOn: "", notes: "   \n " });
    expect(parsed.code).toBeNull();
    expect(parsed.expiresOn).toBeNull();
    expect(parsed.notes).toBeNull();
    expect(couponUpdatePayloadSchema.parse({ ...update, code: "  " }).code).toBeNull();
  });

  it("el límite se mide sobre el texto ya recortado", () => {
    expect(couponCreatePayloadSchema.safeParse({ ...create, merchant: `  ${"x".repeat(120)}  ` }).success).toBe(true);
    expect(couponCreatePayloadSchema.safeParse({ ...create, offer: `  ${"o".repeat(200)}  ` }).success).toBe(true);
    expect(couponCreatePayloadSchema.safeParse({ ...create, code: ` ${"c".repeat(120)} ` }).success).toBe(true);
    expect(couponCreatePayloadSchema.safeParse({ ...create, notes: `  ${"n".repeat(1000)}  ` }).success).toBe(true);
  });

  it("los opcionales viajan siempre: omitir uno no es lo mismo que vaciarlo", () => {
    // `update` es sustitución completa: un `code` que falta borraría el código
    // sin que nadie lo pidiera, así que se exige la clave (con null si no hay).
    const { code: _code, ...withoutCode } = update;
    expect(couponUpdatePayloadSchema.safeParse(withoutCode).success).toBe(false);
    const { notes: _notes, ...withoutNotes } = create;
    expect(couponCreatePayloadSchema.safeParse(withoutNotes).success).toBe(false);
  });
});

describe("payloads de cupones: rechazos", () => {
  it("usos máximos entre 1 y 999, enteros", () => {
    expect(accepts({ ...create, maxUses: 999 })).toBe(true);
    expect(accepts({ ...create, maxUses: 0 })).toBe(false);
    expect(accepts({ ...create, maxUses: 1000 })).toBe(false);
    expect(accepts({ ...create, maxUses: -1 })).toBe(false);
    expect(accepts({ ...create, maxUses: 2.5 })).toBe(false);
    expect(accepts({ ...create, maxUses: "3" })).toBe(false);
    expect(accepts({ ...update, maxUses: 0 })).toBe(false);
    expect(accepts({ ...update, maxUses: 1000 })).toBe(false);
  });

  it("comercio obligatorio de 1 a 120 caracteres", () => {
    expect(accepts({ ...create, merchant: "" })).toBe(false);
    expect(accepts({ ...create, merchant: "   " })).toBe(false);
    expect(accepts({ ...create, merchant: "x".repeat(120) })).toBe(true);
    expect(accepts({ ...create, merchant: "x".repeat(121) })).toBe(false);
    expect(accepts({ ...create, merchant: null })).toBe(false);
    expect(accepts({ ...update, merchant: "" })).toBe(false);
    expect(accepts({ ...update, merchant: "x".repeat(121) })).toBe(false);
  });

  it("oferta obligatoria de 1 a 200, código hasta 120 y notas hasta 1000", () => {
    expect(accepts({ ...create, offer: "" })).toBe(false);
    // En blanco no es una oferta: recortada se queda vacía. Si pasara, la
    // pararía la CHECK de la tabla a mitad de transacción, no el borde.
    expect(accepts({ ...create, offer: "   " })).toBe(false);
    expect(accepts({ ...create, offer: "o".repeat(200) })).toBe(true);
    expect(accepts({ ...create, offer: "o".repeat(201) })).toBe(false);
    expect(accepts({ ...create, code: "c".repeat(121) })).toBe(false);
    expect(accepts({ ...create, notes: "n".repeat(1000) })).toBe(true);
    expect(accepts({ ...create, notes: "n".repeat(1001) })).toBe(false);
  });

  it("las fechas tienen que existir en el calendario, no solo tener forma YYYY-MM-DD", () => {
    expect(accepts({ ...create, expiresOn: "2026-02-30" })).toBe(false);
    expect(accepts({ ...create, expiresOn: "2026-13-01" })).toBe(false);
    expect(accepts({ ...create, expiresOn: "2026-1-01" })).toBe(false);
    expect(accepts({ ...create, expiresOn: "31/10/2026" })).toBe(false);
    expect(accepts({ ...create, expiresOn: "2026-10-31T00:00:00Z" })).toBe(false);
    expect(accepts({ ...create, expiresOn: "2028-02-29" })).toBe(true);
    expect(accepts({ ...create, expiresOn: "2027-02-29" })).toBe(false);
    expect(accepts({ ...update, expiresOn: "2026-02-30" })).toBe(false);
    expect(accepts({ action: "use", couponId: COUPON, useId: USE, usedOn: "2026-02-30" })).toBe(false);
    expect(accepts({ action: "use", couponId: COUPON, useId: USE, usedOn: "" })).toBe(false);
  });

  it("las fechas van de 2000 a 2999: ni la base ni el dominio entienden los años 0000–0099", () => {
    // `z.iso.date()` deja pasar el año 0000, que Postgres rechaza (22008), y el
    // 0026, que Postgres guarda como el año 26 pero `localDate()` del dominio no
    // acepta (`Date.UTC` lleva 0–99 a 1900–1999). Un año de dos cifras tecleado
    // en un `<input type="date">` de escritorio llega justo así.
    const use = (usedOn: string) => ({ action: "use", couponId: COUPON, useId: USE, usedOn });
    for (const outOfRange of ["0000-01-01", "0026-12-31", "0099-12-31", "1999-12-31", "3000-01-01"]) {
      expect(accepts({ ...create, expiresOn: outOfRange }), `expiresOn ${outOfRange}`).toBe(false);
      expect(accepts({ ...update, expiresOn: outOfRange }), `update.expiresOn ${outOfRange}`).toBe(false);
      expect(accepts(use(outOfRange)), `usedOn ${outOfRange}`).toBe(false);
    }
    for (const edge of ["2000-01-01", "2999-12-31"]) {
      expect(accepts({ ...create, expiresOn: edge }), `expiresOn ${edge}`).toBe(true);
      expect(accepts({ ...update, expiresOn: edge }), `update.expiresOn ${edge}`).toBe(true);
      expect(accepts(use(edge)), `usedOn ${edge}`).toBe(true);
    }
  });

  it("los identificadores son uuid", () => {
    expect(accepts({ ...create, couponId: "no-es-un-uuid" })).toBe(false);
    expect(accepts({ ...create, photoStorageObjectId: "no-es-un-uuid" })).toBe(false);
    expect(accepts({ ...update, photoStorageObjectId: "no-es-un-uuid" })).toBe(false);
    expect(accepts({ action: "use", couponId: COUPON, useId: "uso-1", usedOn: "2026-10-03" })).toBe(false);
    expect(accepts({ action: "void_use", couponId: "cupon-1", useId: USE })).toBe(false);
    expect(accepts({ action: "void_use", couponId: COUPON, useId: "uso-1" })).toBe(false);
    expect(accepts({ action: "discard", couponId: "" })).toBe(false);
    expect(accepts({ action: "discard", couponId: "cupon-1" })).toBe(false);
    expect(accepts({ action: "restore", couponId: null })).toBe(false);
    expect(accepts({ action: "restore", couponId: "cupon-1" })).toBe(false);
  });

  it("create exige la foto: el cupón nace de una foto (D-extracción)", () => {
    const { photoStorageObjectId: _photo, ...withoutPhoto } = create;
    expect(accepts(withoutPhoto)).toBe(false);
    expect(accepts({ ...create, photoStorageObjectId: null })).toBe(false);
    // En `update` no se puede quitar la foto, solo cambiarla.
    expect(accepts({ ...update, photoStorageObjectId: null })).toBe(false);
  });

  it("use exige el id del uso y la fecha; void_use, el id del uso", () => {
    expect(accepts({ action: "use", couponId: COUPON, usedOn: "2026-10-03" })).toBe(false);
    expect(accepts({ action: "use", couponId: COUPON, useId: USE })).toBe(false);
    expect(accepts({ action: "void_use", couponId: COUPON })).toBe(false);
  });

  it("una acción desconocida o ausente no entra", () => {
    expect(accepts({ ...create, action: "redeem" })).toBe(false);
    expect(accepts({ action: "delete", couponId: COUPON })).toBe(false);
    expect(accepts({ couponId: COUPON })).toBe(false);
    expect(accepts(null)).toBe(false);
  });

  it("los campos de más no se rechazan pero tampoco pasan: el contrato del repo no es strict", () => {
    // Ningún esquema de `schemas.ts` usa `.strict()`; lo desconocido se cae al
    // parsear y no llega nunca al handler.
    const parsed = couponCommandPayloadSchema.parse({
      action: "discard",
      couponId: COUPON,
      discardedByMembershipId: PHOTO,
    });
    expect(parsed).toEqual({ action: "discard", couponId: COUPON });
  });
});

describe("el sobre de sync acepta aggregateType coupon", () => {
  it("valida un comando de cupón completo", () => {
    expect(
      commandEnvelopeSchema.parse({
        apiVersion: API_VERSION,
        operationId: "cd900000-0000-4000-8000-000000000001",
        householdId: "cd000000-0000-4000-8000-000000000001",
        schemaVersion: 1,
        aggregateType: "coupon",
        aggregateId: COUPON,
        baseRevision: null,
        occurredAt: "2026-10-03T10:00:00.000Z",
        payload: { action: "discard", couponId: COUPON },
      }).aggregateType,
    ).toBe("coupon");
  });
});

describe("tipos de payload de index.ts y esquemas, sin divergir", () => {
  it("lo que el esquema devuelve es exactamente la interfaz pública", () => {
    expectTypeOf<z.output<typeof couponCreatePayloadSchema>>().toEqualTypeOf<CouponCreatePayloadV1>();
    expectTypeOf<z.output<typeof couponUpdatePayloadSchema>>().toEqualTypeOf<CouponUpdatePayloadV1>();
    expectTypeOf<z.output<typeof couponUsePayloadSchema>>().toEqualTypeOf<CouponUsePayloadV1>();
    expectTypeOf<z.output<typeof couponVoidUsePayloadSchema>>().toEqualTypeOf<CouponVoidUsePayloadV1>();
    expectTypeOf<z.output<typeof couponDiscardPayloadSchema>>().toEqualTypeOf<CouponDiscardPayloadV1>();
    expectTypeOf<z.output<typeof couponRestorePayloadSchema>>().toEqualTypeOf<CouponRestorePayloadV1>();
    expectTypeOf<z.output<typeof couponCommandPayloadSchema>>().toEqualTypeOf<CouponCommandPayloadV1>();
  });
});
