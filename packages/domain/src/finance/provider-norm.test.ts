import { describe, expect, it } from "vitest";

import { normalizeBankProvider, normalizeProvider, paypalVendor } from "./index.js";

describe("normalizeBankProvider (port de provider_norm.py)", () => {
  it("tarjeta: el comercio es lo que sigue al prefijo de fecha en ESA celda", () => {
    expect(
      normalizeBankProvider({
        provider: "Fecha de operación: 02-05-2026 Peluquería Ñoño",
        concept:
          "COMPRA TARJETA | 5402XXXX1111 | Fecha de operación: 02-05-2026 Peluquería Ñoño | 04000174TCR",
        codeCommon: "11",
        codeOwn: "612",
        bank: "caixabank",
      }),
    ).toBe("Peluquería Ñoño");
  });

  it("recibo SEPA: quita CORE solo si hay celda con identificador de acreedor", () => {
    expect(
      normalizeBankProvider({
        provider: "CORE IBERDROLA CLIENTES",
        concept: "RECIBO LUZ | CORE IBERDROLA CLIENTES  X0001 | ES84002A82018474   X0040",
        codeCommon: "03",
        codeOwn: "230",
        bank: "caixabank",
      }),
    ).toBe("IBERDROLA CLIENTES");
  });

  it("transferencia 04/073 a empresa: prefiere el destinatario con forma societaria", () => {
    expect(
      normalizeBankProvider({
        provider: "ORDENANTE UNO",
        concept:
          "TRANSFERENCIAS | 2860 56 0001234                    IVI MAD | IVI Madrid S.L. | ORDENANTE UNO",
        codeCommon: "04",
        codeOwn: "073",
        bank: "caixabank",
      }),
    ).toBe("IVI Madrid S.L.");
  });

  it("bizum: la persona NOMBRE;APELLIDO;APELLIDO pasa a espacios", () => {
    expect(
      normalizeBankProvider({
        provider: "ENVIO BIZUM",
        concept: "BIZUM | ENVIO BIZUM | MARIA;GARCIA;LOPEZ | Cena viernes",
        codeCommon: "04",
        codeOwn: "002",
        bank: "caixabank",
      }),
    ).toBe("MARIA GARCIA LOPEZ");
  });

  it("MyBox: la fecha de la cuota mensual queda fuera del provider", () => {
    expect(
      normalizeBankProvider({
        provider: "CUOTA AGRUPADA MYBOX 01-05-2026",
        concept: "CUOTA AGRUPADA MYBOX 01-05-2026",
        codeCommon: "05",
        codeOwn: "704",
        bank: "caixabank",
      }),
    ).toBe("CUOTA AGRUPADA MYBOX");
  });

  it("deutsche: contador de cuota del préstamo fuera", () => {
    expect(
      normalizeBankProvider({
        provider: "PRESTAMO       028-20276496",
        concept: "PRESTAMO       028-20276496",
        codeCommon: null,
        codeOwn: null,
        bank: "deutsche_bank",
      }),
    ).toBe("PRESTAMO 20276496");
  });
});

describe("paypalVendor", () => {
  it("extrae el vendor de PAYPAL *X cortando en teléfonos/referencias", () => {
    expect(paypalVendor("PAYPAL *STEAM GAMES 4029357733")).toBe("Steam Games");
    expect(paypalVendor("PAYPAL *KOBO BOOKS")).toBe("Kobo Books");
    expect(paypalVendor("AMAZON ES")).toBeNull();
  });
});

describe("normalizeProvider (entrada genérica canónica)", () => {
  it("toma la primera parte no vacía del concept y su forma normalizada", () => {
    expect(normalizeProvider("RECIBO LUZ | CORE IBERDROLA CLIENTES")).toEqual({
      provider: "RECIBO LUZ",
      providerNorm: "RECIBO LUZ",
    });
    expect(normalizeProvider("  Peluquería   Ñoño  ")).toEqual({
      provider: "Peluquería Ñoño",
      providerNorm: "PELUQUERIA NONO",
    });
    expect(normalizeProvider("   ")).toEqual({ provider: null, providerNorm: null });
  });
});
