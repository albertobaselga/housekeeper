import { describe, expect, it } from "vitest";

import { DomainRuleError, localDate, type LocalDate } from "../index.js";
import {
  COUPON_BUCKETS,
  COUPON_EXPIRY_NOTICE_DAYS,
  couponBucket,
  expiresSoon,
  remainingUses,
  type CouponFacts,
} from "./index.js";

const TODAY = localDate("2026-10-03");

function facts(overrides: Partial<CouponFacts> = {}): CouponFacts {
  return { maxUses: 1, liveUses: 0, expiresOn: null, discarded: false, ...overrides };
}

const on = (value: string): LocalDate => localDate(value);

/** Lanza un `DomainRuleError` y con ESE código: dos invariantes con el código cruzado no pasan. */
function expectRuleError(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainRuleError);
  expect((caught as DomainRuleError).code).toBe(code);
}

describe("cubos de un cupón (spec §6, D-visibilidad)", () => {
  it("los cuatro cubos, en el orden de los filtros", () => {
    expect(COUPON_BUCKETS).toEqual(["available", "used", "expired", "discarded"]);
  });

  it("recién guardado y sin caducidad está disponible", () => {
    expect(couponBucket(facts(), TODAY)).toBe("available");
  });

  it("caduca hoy: sigue disponible todo el día", () => {
    expect(couponBucket(facts({ expiresOn: on("2026-10-03") }), TODAY)).toBe("available");
  });

  it("caducó ayer: caducado", () => {
    expect(couponBucket(facts({ expiresOn: on("2026-10-02") }), TODAY)).toBe("expired");
  });

  it("caduca mañana o dentro de un año: disponible", () => {
    expect(couponBucket(facts({ expiresOn: on("2026-10-04") }), TODAY)).toBe("available");
    expect(couponBucket(facts({ expiresOn: on("2027-10-03") }), TODAY)).toBe("available");
  });

  it("la comparación de fechas cruza meses y años sin tropezar", () => {
    expect(couponBucket(facts({ expiresOn: on("2026-12-31") }), on("2027-01-01"))).toBe("expired");
    expect(couponBucket(facts({ expiresOn: on("2027-01-01") }), on("2026-12-31"))).toBe("available");
    expect(couponBucket(facts({ expiresOn: on("2028-02-29") }), on("2028-03-01"))).toBe("expired");
  });

  it("un solo uso: usado en cuanto se apunta el uso", () => {
    expect(couponBucket(facts({ maxUses: 1, liveUses: 0 }), TODAY)).toBe("available");
    expect(couponBucket(facts({ maxUses: 1, liveUses: 1 }), TODAY)).toBe("used");
  });

  it("varios usos: disponible mientras queden y usado al gastar el último", () => {
    expect(couponBucket(facts({ maxUses: 5, liveUses: 2 }), TODAY)).toBe("available");
    expect(couponBucket(facts({ maxUses: 5, liveUses: 4 }), TODAY)).toBe("available");
    expect(couponBucket(facts({ maxUses: 5, liveUses: 5 }), TODAY)).toBe("used");
  });

  it("más usos de los permitidos (no se controlan, D-usos): usado igualmente", () => {
    expect(couponBucket(facts({ maxUses: 1, liveUses: 3 }), TODAY)).toBe("used");
  });

  it("sin límite nunca está usado, por muchos usos que lleve", () => {
    expect(couponBucket(facts({ maxUses: null, liveUses: 0 }), TODAY)).toBe("available");
    expect(couponBucket(facts({ maxUses: null, liveUses: 999 }), TODAY)).toBe("available");
    expect(couponBucket(facts({ maxUses: null, liveUses: 4, expiresOn: on("2026-10-01") }), TODAY)).toBe(
      "expired",
    );
  });

  it("descartado manda sobre todo lo demás", () => {
    expect(couponBucket(facts({ discarded: true }), TODAY)).toBe("discarded");
    expect(couponBucket(facts({ discarded: true, liveUses: 1 }), TODAY)).toBe("discarded");
    expect(couponBucket(facts({ discarded: true, expiresOn: on("2026-01-01") }), TODAY)).toBe("discarded");
    expect(
      couponBucket(facts({ discarded: true, liveUses: 1, expiresOn: on("2026-01-01") }), TODAY),
    ).toBe("discarded");
  });

  it("gastado y caducado a la vez: cuenta como usado", () => {
    expect(couponBucket(facts({ maxUses: 2, liveUses: 2, expiresOn: on("2026-09-30") }), TODAY)).toBe("used");
  });

  it("caducado con usos pendientes: caducado", () => {
    expect(couponBucket(facts({ maxUses: 5, liveUses: 1, expiresOn: on("2026-09-30") }), TODAY)).toBe(
      "expired",
    );
  });
});

describe("usos que quedan", () => {
  it("sin límite: null, no un número", () => {
    expect(remainingUses(facts({ maxUses: null, liveUses: 0 }))).toBeNull();
    expect(remainingUses(facts({ maxUses: null, liveUses: 12 }))).toBeNull();
  });

  it("con límite: lo que falta hasta el máximo", () => {
    expect(remainingUses(facts({ maxUses: 1, liveUses: 0 }))).toBe(1);
    expect(remainingUses(facts({ maxUses: 5, liveUses: 2 }))).toBe(3);
    expect(remainingUses(facts({ maxUses: 5, liveUses: 5 }))).toBe(0);
    expect(remainingUses(facts({ maxUses: 999, liveUses: 0 }))).toBe(999);
  });

  it("nunca negativo aunque se hayan apuntado usos de más", () => {
    expect(remainingUses(facts({ maxUses: 1, liveUses: 3 }))).toBe(0);
    expect(Object.is(remainingUses(facts({ maxUses: 2, liveUses: 7 })), 0)).toBe(true);
  });

  it("no depende de la caducidad ni del descarte: es inventario, no visibilidad", () => {
    expect(remainingUses(facts({ maxUses: 3, liveUses: 1, discarded: true }))).toBe(2);
    expect(remainingUses(facts({ maxUses: 3, liveUses: 1, expiresOn: on("2020-01-01") }))).toBe(2);
  });
});

describe("caduca pronto (aviso en Hoy, D-aviso)", () => {
  it("el aviso mira tres días por delante", () => {
    expect(COUPON_EXPIRY_NOTICE_DAYS).toBe(3);
  });

  it("de hoy a hoy + 3, ambos extremos incluidos", () => {
    expect(expiresSoon(facts({ expiresOn: on("2026-10-03") }), TODAY)).toBe(true);
    expect(expiresSoon(facts({ expiresOn: on("2026-10-04") }), TODAY)).toBe(true);
    expect(expiresSoon(facts({ expiresOn: on("2026-10-06") }), TODAY)).toBe(true);
    expect(expiresSoon(facts({ expiresOn: on("2026-10-07") }), TODAY)).toBe(false);
  });

  it("ya caducado no «caduca pronto»: está en su propio filtro", () => {
    expect(expiresSoon(facts({ expiresOn: on("2026-10-02") }), TODAY)).toBe(false);
  });

  it("sin caducidad nunca avisa", () => {
    expect(expiresSoon(facts({ expiresOn: null }), TODAY)).toBe(false);
  });

  it("solo los disponibles: ni usados ni descartados avisan", () => {
    expect(expiresSoon(facts({ expiresOn: on("2026-10-04"), maxUses: 1, liveUses: 1 }), TODAY)).toBe(false);
    expect(expiresSoon(facts({ expiresOn: on("2026-10-04"), discarded: true }), TODAY)).toBe(false);
    expect(expiresSoon(facts({ expiresOn: on("2026-10-04"), maxUses: null, liveUses: 8 }), TODAY)).toBe(true);
  });

  it("cruza fin de mes, fin de año y el 29 de febrero", () => {
    expect(expiresSoon(facts({ expiresOn: on("2027-01-02") }), on("2026-12-30"))).toBe(true);
    expect(expiresSoon(facts({ expiresOn: on("2027-01-03") }), on("2026-12-30"))).toBe(false);
    // 2028 es bisiesto: del 27 de febrero al 1 de marzo hay tres días.
    expect(expiresSoon(facts({ expiresOn: on("2028-03-01") }), on("2028-02-27"))).toBe(true);
    expect(expiresSoon(facts({ expiresOn: on("2028-03-02") }), on("2028-02-27"))).toBe(false);
    // 2027 no lo es: del 26 de febrero al 1 de marzo, también tres.
    expect(expiresSoon(facts({ expiresOn: on("2027-03-01") }), on("2027-02-26"))).toBe(true);
  });

  it("la ventana se puede estrechar o ensanchar", () => {
    expect(expiresSoon(facts({ expiresOn: on("2026-10-03") }), TODAY, 0)).toBe(true);
    expect(expiresSoon(facts({ expiresOn: on("2026-10-04") }), TODAY, 0)).toBe(false);
    expect(expiresSoon(facts({ expiresOn: on("2026-10-10") }), TODAY, 7)).toBe(true);
    expect(expiresSoon(facts({ expiresOn: on("2026-10-11") }), TODAY, 7)).toBe(false);
  });

  it("una ventana negativa, no entera o de más de un año es un error de programa, no un «no»", () => {
    expect(expiresSoon(facts({ expiresOn: on("2027-10-03") }), TODAY, 365)).toBe(true);
    expect(expiresSoon(facts({ expiresOn: on("2027-10-04") }), TODAY, 366)).toBe(true);
    const withWindow = (days: number) => () => expiresSoon(facts({ expiresOn: on("2026-10-03") }), TODAY, days);
    expectRuleError(withWindow(-1), "INVALID_DAY_COUNT");
    expectRuleError(withWindow(1.5), "INVALID_DAY_COUNT");
    expectRuleError(withWindow(367), "INVALID_DAY_COUNT");
    // Sin tope, una ventana absurda se salía del calendario de `Date` y
    // reventaba con un `RangeError` sin nombre en vez de con uno de dominio.
    expectRuleError(withWindow(1e9), "INVALID_DAY_COUNT");
  });
});

describe("hechos imposibles se rechazan en vez de pintarse", () => {
  // Llegan de la base: `max_uses` tiene CHECK 1..999 y los usos vivos son un
  // recuento. Si llega otra cosa —un `count(*)` de node-postgres viene como
  // texto, por ejemplo— el fallo tiene que ser ruidoso y no un «quedan NaN».
  it("usos vivos: entero no negativo", () => {
    expectRuleError(() => couponBucket(facts({ liveUses: -1 }), TODAY), "INVALID_COUPON_USES");
    expectRuleError(() => remainingUses(facts({ liveUses: 1.5 })), "INVALID_COUPON_USES");
    expectRuleError(
      () => remainingUses(facts({ liveUses: "2" as unknown as number })),
      "INVALID_COUPON_USES",
    );
  });

  it("usos máximos: null o entero positivo", () => {
    expectRuleError(() => couponBucket(facts({ maxUses: 0 }), TODAY), "INVALID_COUPON_MAX_USES");
    expectRuleError(() => remainingUses(facts({ maxUses: -2 })), "INVALID_COUPON_MAX_USES");
    expectRuleError(
      () => expiresSoon(facts({ maxUses: 2.5, expiresOn: on("2026-10-03") }), TODAY),
      "INVALID_COUPON_MAX_USES",
    );
  });

  // `date` llega de node-postgres como `Date` si no se lee como `::text`, y un
  // cast a `LocalDate` lo deja pasar. Sin esta guarda, una fecha rota caía en
  // silencio en el cubo equivocado: «basura» como hoy daba «Caducado» y un
  // `2026-10-3` frente a `2026-10-03`, «Disponible».
  it("caducidad: null o fecha de calendario YYYY-MM-DD", () => {
    const broken = ["2026-10-3", "2026-02-30", "basura", "", "0026-12-31"];
    for (const expiresOn of broken) {
      expectRuleError(
        () => couponBucket(facts({ expiresOn: expiresOn as LocalDate }), TODAY),
        "INVALID_LOCAL_DATE",
      );
      expectRuleError(
        () => expiresSoon(facts({ expiresOn: expiresOn as LocalDate }), TODAY),
        "INVALID_LOCAL_DATE",
      );
    }
    const fromDriver = new Date("2026-10-31T00:00:00Z") as unknown as LocalDate;
    expectRuleError(() => couponBucket(facts({ expiresOn: fromDriver }), TODAY), "INVALID_LOCAL_DATE");
  });

  it("hoy: fecha de calendario YYYY-MM-DD", () => {
    for (const today of ["basura", "2026-10-3", "2026-13-01", ""]) {
      expectRuleError(() => couponBucket(facts(), today as LocalDate), "INVALID_LOCAL_DATE");
      expectRuleError(
        () => expiresSoon(facts({ expiresOn: on("2026-10-03") }), today as LocalDate),
        "INVALID_LOCAL_DATE",
      );
    }
    expectRuleError(
      () => couponBucket(facts(), new Date("2026-10-03T00:00:00Z") as unknown as LocalDate),
      "INVALID_LOCAL_DATE",
    );
  });
});
