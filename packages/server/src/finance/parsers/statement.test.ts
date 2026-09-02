import { describe, expect, it } from "vitest";

import { FinanceParserError, parseStatement } from "./index.js";
import {
  amexSampleXlsx,
  caixabankSampleXls,
  deutscheSampleXls,
  openbankSampleHtml,
} from "./synthetic-samples.js";

describe("parseStatement (despacho por banco detectado)", () => {
  it("devuelve banco, refs únicas y filas", () => {
    const st = parseStatement(caixabankSampleXls(), "mov.xls");
    expect(st.bank).toBe("caixabank");
    expect(st.accountRefs).toEqual(["21000000000000001234", "21000000000000005678"]);
    expect(st.rows).toHaveLength(3);
    expect(parseStatement(openbankSampleHtml(), "mov.xls").bank).toBe("openbank");
  });

  it("despacha también los otros dos bancos de la tabla PARSERS", () => {
    // El nombre del fichero no decide nada: el despacho es por contenido.
    const amex = parseStatement(amexSampleXlsx(), "cualquiera.xls");
    expect(amex.bank).toBe("amex");
    expect(amex.accountRefs).toEqual(["XXXX-XXXXX-91009"]);
    expect(amex.rows).toHaveLength(2);

    const deutsche = parseStatement(deutscheSampleXls(), "cualquiera.xlsx");
    expect(deutsche.bank).toBe("deutsche_bank");
    expect(deutsche.accountRefs).toEqual(["ES4400190000000000000001"]);
    expect(deutsche.rows).toHaveLength(3);
  });
  it("contenido no reconocido lanza FinanceParserError con el nombre del fichero", () => {
    expect(() => parseStatement(new Uint8Array(Buffer.from("nada")), "raro.xls")).toThrow(/raro\.xls/);
    expect(() => parseStatement(new Uint8Array(Buffer.from("nada")), "raro.xls")).toThrow(FinanceParserError);
  });
});
