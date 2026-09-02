import { describe, expect, it } from "vitest";

import { dayDiffIso, normText, normalizeConcept } from "./index.js";

describe("normText (port de money.py::norm_text)", () => {
  it("quita tildes por NFKD, colapsa espacios y pasa a mayúsculas", () => {
    // valores dorados calculados con la función Python del origen
    expect(normText("  Peluquería   Ñoño  ")).toBe("PELUQUERIA NONO");
    expect(normText("café   con LECHE")).toBe("CAFE CON LECHE");
    expect(normText("ya limpio")).toBe("YA LIMPIO");
  });
});

describe("normalizeConcept (port de money.py::normalize_concept)", () => {
  it("colapsa espacios internos y recorta a 80 caracteres", () => {
    expect(normalizeConcept("  RECIBO   LUZ  ")).toBe("RECIBO LUZ");
    expect(normalizeConcept("x".repeat(100))).toBe("x".repeat(80));
  });
  it("devuelve «—» si queda vacío", () => {
    expect(normalizeConcept("   ")).toBe("—");
  });
});

describe("dayDiffIso", () => {
  it("calcula la diferencia en días de calendario", () => {
    expect(dayDiffIso("2026-06-16", "2026-06-15")).toBe(1);
    expect(dayDiffIso("2026-06-01", "2026-05-29")).toBe(3);
    expect(dayDiffIso("2026-05-29", "2026-06-01")).toBe(-3);
  });
});
