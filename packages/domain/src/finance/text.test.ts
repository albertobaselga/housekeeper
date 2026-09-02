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
  // Task 99, punto 4: la misma paridad Python que normText, aplicada a
  // normalizeConcept. (a) split() sin argumentos parte por la clase \s de
  // Python (PY_SPACE_RX), no por la de JS: el NEL colapsa a espacio y el BOM
  // sobrevive. (b) el recorte a 80 es por PUNTOS DE CÓDIGO (como `[:80]` de
  // Python), no por unidades UTF-16: un emoji cuenta 1, no 2.
  it("parte por la clase de espacio de Python: NEL colapsa, el BOM sobrevive", () => {
    expect(normalizeConcept("AB﻿C")).toBe("A B﻿C");
  });
  it("recorta por puntos de código, no por unidades UTF-16 (un emoji no cuenta doble)", () => {
    const largo = "😀".repeat(50); // 50 puntos de código, 100 unidades UTF-16
    expect(normalizeConcept(largo)).toBe(largo); // NO se recorta: son 50 puntos de código
  });
});

describe("dayDiffIso", () => {
  it("calcula la diferencia en días de calendario", () => {
    expect(dayDiffIso("2026-06-16", "2026-06-15")).toBe(1);
    expect(dayDiffIso("2026-06-01", "2026-05-29")).toBe(3);
    expect(dayDiffIso("2026-05-29", "2026-06-01")).toBe(-3);
  });
});

// La clase \s de Python (modo str) NO es la de JavaScript: incluye U+001C-U+001F
// y U+0085, y excluye U+FEFF (que sí recorta el `.trim()` de JS). Los valores
// dorados de abajo se calcularon a mano con `re.sub(r"\s+", " ", s).strip()` del
// origen; cualquier divergencia cambia `concept_norm`/`provider_norm` y, peor, el
// hash de dedup que ya está migrado.
describe("normText: la clase de espacio es la de Python, no la de JS", () => {
  it("trata como espacio los separadores que Python cuenta y JS no", () => {
    expect(normText("A\u0085B")).toBe("A B"); // NEL
    expect(normText("A\u001cB")).toBe("A B"); // FS
  });

  it("conserva el BOM: U+FEFF no es espacio en Python ni lo recorta strip()", () => {
    expect(normText("\ufeffHOLA")).toBe("\ufeffHOLA");
  });

  it("colapsa los espacios compartidos y recorta solo los extremos", () => {
    expect(normText("\u00a0a\u2003b\u00a0")).toBe("A B"); // NBSP y EM SPACE
    expect(normText("  a  b  ")).toBe("A B");
  });
});
