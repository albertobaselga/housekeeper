import { describe, expect, it } from "vitest";

import { dedupKey } from "./index.js";

describe("dedupKey (cadena canónica de money.py::dedup_hash)", () => {
  it("compone bank_ref|fecha|importe|concepto normalizado|saldo", () => {
    expect(
      dedupKey({
        bankRef: "21000000000000001234",
        opDate: "2026-05-04",
        amountCents: -4230n,
        concept: "COMPRA TARJETA | Fecha de operación: 02-05-2026 Peluquería Ñoño | 04000174TCR",
        balanceCents: 102345n,
        dedupRef: null,
      }),
    ).toBe(
      "21000000000000001234|2026-05-04|-4230|COMPRA TARJETA | FECHA DE OPERACION: 02-05-2026 PELUQUERIA NONO | 04000174TCR|102345",
    );
  });

  it("serializa el saldo null como el literal Python «None» y añade la ref de Amex al final", () => {
    expect(
      dedupKey({
        bankRef: "XXXX-XXXXX-91009",
        opDate: "2026-05-06",
        amountCents: 1899n,
        concept: "AMAZON ES",
        balanceCents: null,
        dedupRef: "320261250012345678",
      }),
    ).toBe("XXXX-XXXXX-91009|2026-05-06|1899|AMAZON ES|None|320261250012345678");
  });
});
