import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

describe("SheetJS en ESM/NodeNext (humo previo a los parsers)", () => {
  it("expone read/write en el namespace", () => {
    expect(typeof XLSX.read).toBe("function");
    expect(typeof XLSX.write).toBe("function");
  });

  it("round-trip BIFF8 con acentos intactos", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Número de cuenta", "Peluquería Ñoño"]]), "H");
    const bytes = new Uint8Array(XLSX.write(wb, { bookType: "biff8", type: "buffer" }) as Buffer);
    const back = XLSX.read(bytes, { type: "array" });
    const grid: unknown[][] = XLSX.utils.sheet_to_json(
      back.Sheets[back.SheetNames[0] as string] as XLSX.WorkSheet,
      { header: 1, raw: true, defval: "" },
    );
    expect(grid[0]).toEqual(["Número de cuenta", "Peluquería Ñoño"]);
  });
});
