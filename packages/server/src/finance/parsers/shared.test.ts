import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { FinanceParserError, balanceCentsOf, buildRaw, parseDateEs, sheetGrid, toCents } from "./shared.js";

describe("toCents (port de money.py::to_cents)", () => {
  it("entiende formato es-ES en texto y números de celda", () => {
    expect(toCents("1.023,45")).toBe(102345n);
    expect(toCents("-55,12")).toBe(-5512n);
    expect(toCents("2.500,00")).toBe(250000n);
    expect(toCents(18.99)).toBe(1899n);
    expect(toCents("")).toBeNull();
    expect(toCents(null)).toBeNull();
  });
  it("devuelve null ante texto no numérico (el llamador decide si es error)", () => {
    expect(toCents("no-numero")).toBeNull();
  });
});

describe("balanceCentsOf (saldo: vacío ≠ ilegible)", () => {
  it("celda vacía → null; celda legible → céntimos", () => {
    expect(balanceCentsOf("", 4)).toBeNull();
    expect(balanceCentsOf(null, 4)).toBeNull();
    expect(balanceCentsOf("   ", 4)).toBeNull();
    expect(balanceCentsOf("1.023,45", 4)).toBe(102345n);
  });
  it("celda con contenido ilegible lanza FinanceParserError con la fila", () => {
    // El saldo entra en la cadena canónica de dedup: un null silencioso
    // cambiaría el hash («None») y rompería la verificación cruzada de la fase 3.
    expect(() => balanceCentsOf("abc", 9)).toThrow(FinanceParserError);
    expect(() => balanceCentsOf("abc", 9)).toThrow(/Fila 9/);
  });
});

describe("parseDateEs", () => {
  it("dd/mm/yyyy → ISO; inválida lanza FinanceParserError con la fila", () => {
    expect(parseDateEs("04/05/2026", 7)).toBe("2026-05-04");
    expect(() => parseDateEs("30/02/2026", 7)).toThrow(FinanceParserError);
    expect(() => parseDateEs("no-fecha", 3)).toThrow(/Fila 3/);
  });
});

describe("sheetGrid (receta SheetJS común: header:1, raw:true, defval:'')", () => {
  it("lee la hoja por nombre si se indica", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"]]), "Hoja1");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["c", "d"]]), "Hoja2");
    expect(sheetGrid(wb, "Hoja2")).toEqual([["c", "d"]]);
  });
  it("sin nombre lee la primera hoja", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x", "y"]]), "Solo");
    expect(sheetGrid(wb)).toEqual([["x", "y"]]);
  });
  it("libro sin hojas lanza FinanceParserError", () => {
    const wb = XLSX.utils.book_new();
    expect(() => sheetGrid(wb)).toThrow(FinanceParserError);
  });
  it("hoja inexistente lanza FinanceParserError", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x"]]), "Solo");
    expect(() => sheetGrid(wb, "Otra")).toThrow(FinanceParserError);
  });
});

describe("buildRaw (port de base.py::build_raw)", () => {
  it("cabecera→valor con claves únicas, colN si falta cabecera, descarta pares vacíos", () => {
    expect(buildRaw(["A", "", "A"], ["1", "2", "3", "4"])).toEqual({
      A: "1", col1: "2", "A 2": "3", col3: "4",
    });
    // build_raw solo descarta el par TOTALMENTE vacío: con cabecera «A» y valor
    // vacío la clave se conserva (fidelidad al origen).
    expect(buildRaw(["A"], [""])).toEqual({ A: "" });
    expect(buildRaw([""], [""])).toEqual({});
  });
});
