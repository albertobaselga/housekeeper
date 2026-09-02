import { describe, expect, it } from "vitest";

import { computeDedupHash } from "./dedup-hash.js";

describe("computeDedupHash (sha256 de la cadena canónica)", () => {
  it("reproduce exactamente los hashes del backend Python del origen", () => {
    expect(
      computeDedupHash({
        bankRef: "21000000000000001234",
        opDate: "2026-05-04",
        amountCents: -4230n,
        concept: "COMPRA TARJETA | Fecha de operación: 02-05-2026 Peluquería Ñoño | 04000174TCR",
        balanceCents: 102345n,
        dedupRef: null,
      }),
    ).toBe("46766c6626bc6b286b628eff47d396c622da72876c9ef63456d2d428286b09f7");
    expect(
      computeDedupHash({
        bankRef: "XXXX-XXXXX-91009",
        opDate: "2026-05-06",
        amountCents: 1899n,
        concept: "AMAZON ES",
        balanceCents: null,
        dedupRef: "320261250012345678",
      }),
    ).toBe("1037a18289c3589f522a2505a6fbcee2128c7d6c3a17eb0e0ab14200b0e6e78d");
  });
});
