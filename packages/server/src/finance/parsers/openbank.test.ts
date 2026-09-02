import { describe, expect, it } from "vitest";

import { FinanceParserError } from "./shared.js";
import { parseOpenbank } from "./openbank.js";
import { openbankSampleHtml } from "./synthetic-samples.js";

/** Construye el HTML mínimo de OpenBank (cuenta + cabecera + filas dadas), para
 * ejercer ramas de provider/entidades sin depender de `openbankSampleHtml()`. */
function openbankMiniHtml(account: string, dataRows: string[]): Uint8Array {
  const html = `<html><body>
<table><tr><td>Número de Cuenta:</td><td>${account}</td></tr></table>
<table>
<tr><td>Fecha Operación</td><td>Fecha Valor</td><td>Concepto</td><td>Importe</td><td>Saldo</td></tr>
${dataRows.join("\n")}
</table></body></html>`;
  return new Uint8Array(Buffer.from(html, "latin1"));
}

describe("parseOpenbank (HTML iso-8859-1 sintético, sin skip)", () => {
  const rows = parseOpenbank(openbankSampleHtml());
  it("lee la cuenta sin espacios y las dos filas con acentos intactos", () => {
    expect(rows).toHaveLength(2);
    // CCC español = 20 dígitos: «0073 0100 5100 0000 0001» sin espacios.
    expect(rows[0]?.accountRef).toBe("00730100510000000001");
    expect(rows[0]?.bankRef).toBe("00730100510000000001");
    expect(rows[0]?.concept).toBe("TRANSFERENCIA DE CARLOS EJEMPLO, CONCEPTO Aportación mayo");
  });
  it("deriva el provider de transferencias y liquidaciones", () => {
    expect(rows[0]).toMatchObject({ provider: "CARLOS EJEMPLO", amountCents: 30000n, balanceCents: 130000n });
    // La segunda fila trae «-» en Fecha Valor: celda presente y no-fecha ⇒ null.
    expect(rows[1]).toMatchObject({ provider: "Openbank", amountCents: 123n, valueDate: null });
  });
  it("construye raw con las claves de la cabecera", () => {
    expect(rows[0]?.raw).toMatchObject({ "Fecha Operación": "06/05/2026", Importe: "300,00", Saldo: "1.300,00" });
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

describe("parseOpenbank — decodeEntities y ramas del derivador de provider", () => {
  it("decodifica entidades con nombre, hexadecimales y decimales del concepto", () => {
    const bytes = openbankMiniHtml("0073 0100 5100 0000 0002", [
      '<tr><td>06/05/2026</td><td>06/05/2026</td>' +
        '<td>PAGO Villal&oacute;n &amp; Hijos &quot;S&#x41;&quot; &#67;asa</td>' +
        "<td>10,00</td><td>10,00</td></tr>",
    ]);
    const rows = parseOpenbank(bytes);
    expect(rows[0]?.concept).toBe('PAGO Villalón & Hijos "SA" Casa');
  });
  it("una entidad con nombre desconocida se deja literal, como el origen con las inválidas", () => {
    const bytes = openbankMiniHtml("0073 0100 5100 0000 0003", [
      "<tr><td>06/05/2026</td><td>06/05/2026</td><td>PAGO &hearts; rareza</td><td>10,00</td><td>10,00</td></tr>",
    ]);
    const rows = parseOpenbank(bytes);
    expect(rows[0]?.concept).toBe("PAGO &hearts; rareza");
  });
  it("una entidad heredada de Object.prototype no inyecta código: se deja literal como cualquier desconocida", () => {
    const bytes = openbankMiniHtml("0073 0100 5100 0000 0006", [
      "<tr><td>06/05/2026</td><td>06/05/2026</td>" +
        "<td>PAGO &constructor; &toString; &hasOwnProperty; fin</td><td>10,00</td><td>10,00</td></tr>",
    ]);
    const rows = parseOpenbank(bytes);
    expect(rows[0]?.concept).toBe("PAGO &constructor; &toString; &hasOwnProperty; fin");
  });
  it("&nbsp; decodifica al espacio duro U+00A0, como el origen, no a un espacio normal", () => {
    const bytes = openbankMiniHtml("0073 0100 5100 0000 0007", [
      "<tr><td>06/05/2026</td><td>06/05/2026</td><td>PAGO A&nbsp;&nbsp;B fin</td><td>10,00</td><td>10,00</td></tr>",
    ]);
    const rows = parseOpenbank(bytes);
    expect(rows[0]?.concept).toBe("PAGO A  B fin");
  });
  it("una referencia numérica fuera de rango no lanza RangeError: se sustituye por el carácter de reemplazo", () => {
    const bytes = openbankMiniHtml("0073 0100 5100 0000 0008", [
      "<tr><td>06/05/2026</td><td>06/05/2026</td>" +
        "<td>PAGO &#x110000; &#9999999999; &#xD800; fin</td><td>10,00</td><td>10,00</td></tr>",
    ]);
    expect(() => parseOpenbank(bytes)).not.toThrow();
    const rows = parseOpenbank(bytes);
    expect(rows[0]?.concept).toBe("PAGO � � � fin");
  });
  it("una entidad con nombre que lleva dígito se decodifica (p.ej. &sup2;)", () => {
    const bytes = openbankMiniHtml("0073 0100 5100 0000 0009", [
      "<tr><td>06/05/2026</td><td>06/05/2026</td><td>ALQUILER LOCAL 40m&sup2; fin</td><td>10,00</td><td>10,00</td></tr>",
    ]);
    const rows = parseOpenbank(bytes);
    expect(rows[0]?.concept).toBe("ALQUILER LOCAL 40m² fin");
  });
  it("deriva el provider de «TRANSFERENCIA A FAVOR DE» y de la variante INMEDIATA", () => {
    const bytes = openbankMiniHtml("0073 0100 5100 0000 0004", [
      "<tr><td>06/05/2026</td><td>06/05/2026</td>" +
        "<td>TRANSFERENCIA A FAVOR DE ANA EJEMPLO, CONCEPTO Alquiler</td><td>-500,00</td><td>500,00</td></tr>",
      "<tr><td>07/05/2026</td><td>07/05/2026</td>" +
        "<td>TRANSFERENCIA INMEDIATA DE LUIS EJEMPLO, CONCEPTO Regalo</td><td>20,00</td><td>520,00</td></tr>",
    ]);
    const rows = parseOpenbank(bytes);
    expect(rows.map((r) => r.provider)).toEqual(["ANA EJEMPLO", "LUIS EJEMPLO"]);
  });
  it("cuando el concepto no es transferencia ni liquidación, el provider es el concepto crudo truncado", () => {
    const bytes = openbankMiniHtml("0073 0100 5100 0000 0005", [
      "<tr><td>06/05/2026</td><td>06/05/2026</td>" +
        "<td>COMPRA TARJETA SUPERMERCADO EJEMPLO</td><td>-12,34</td><td>487,66</td></tr>",
    ]);
    const rows = parseOpenbank(bytes);
    expect(rows[0]?.provider).toBe("COMPRA TARJETA SUPERMERCADO EJEMPLO");
  });
});
