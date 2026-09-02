import { describe, expect, it } from "vitest";

import { FinanceParserError, parseStatement } from "./index.js";
import { caixabankSampleXls, openbankSampleHtml } from "./synthetic-samples.js";

describe("parseStatement (despacho por banco detectado)", () => {
  it("devuelve banco, refs únicas y filas", () => {
    const st = parseStatement(caixabankSampleXls(), "mov.xls");
    expect(st.bank).toBe("caixabank");
    expect(st.accountRefs).toEqual(["21000000000000001234", "21000000000000005678"]);
    expect(st.rows).toHaveLength(3);
    expect(parseStatement(openbankSampleHtml(), "mov.xls").bank).toBe("openbank");
  });
  it("contenido no reconocido lanza FinanceParserError con el nombre del fichero", () => {
    expect(() => parseStatement(new Uint8Array(Buffer.from("nada")), "raro.xls")).toThrow(/raro\.xls/);
    expect(() => parseStatement(new Uint8Array(Buffer.from("nada")), "raro.xls")).toThrow(FinanceParserError);
  });
});
