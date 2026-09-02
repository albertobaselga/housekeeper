import { describe, expect, it } from "vitest";

import { FinanceParserError } from "./shared.js";
import { parseOpenbank } from "./openbank.js";
import { openbankSampleHtml } from "./synthetic-samples.js";

describe("parseOpenbank (HTML iso-8859-1 sintético, sin skip)", () => {
  const rows = parseOpenbank(openbankSampleHtml());
  it("lee la cuenta sin espacios y las dos filas con acentos intactos", () => {
    expect(rows).toHaveLength(2);
    // CCC español = 20 dígitos: «0073 0100 5100 0000 0001» sin espacios.
    expect(rows[0]?.accountRef).toBe("00730100510000000001");
    expect(rows[0]?.concept).toBe("TRANSFERENCIA DE CARLOS EJEMPLO, CONCEPTO Aportación mayo");
  });
  it("deriva el provider de transferencias y liquidaciones", () => {
    expect(rows[0]).toMatchObject({ provider: "CARLOS EJEMPLO", amountCents: 30000n, balanceCents: 130000n });
    // La segunda fila trae «-» en Fecha Valor: celda presente y no-fecha ⇒ null.
    expect(rows[1]).toMatchObject({ provider: "Openbank", amountCents: 123n, valueDate: null });
  });
  it("un HTML sin cuenta lanza FinanceParserError", () => {
    expect(() =>
      parseOpenbank(new Uint8Array(Buffer.from("<html><body><table></table></body></html>", "latin1"))),
    ).toThrow(FinanceParserError);
  });
  it("un saldo ilegible lanza FinanceParserError en vez de quedarse en null", () => {
    const corrupto = `<html><body>
<table><tr><td>Número de Cuenta:</td><td>0073 0100 5100 0000 0001</td></tr></table>
<table>
<tr><td>Fecha Operación</td><td>Fecha Valor</td><td>Concepto</td><td>Importe</td><td>Saldo</td></tr>
<tr><td>06/05/2026</td><td>06/05/2026</td><td>PAGO</td><td>300,00</td><td>SALDO NO DISPONIBLE</td></tr>
</table></body></html>`;
    expect(() => parseOpenbank(new Uint8Array(Buffer.from(corrupto, "latin1")))).toThrow(
      /saldo ilegible/,
    );
  });
});
