/** Muestras SINTÉTICAS de extractos, generadas por código (jamás ficheros
 * reales): titulares, cuentas e importes inventados con el formato del banco. */
import * as XLSX from "xlsx";

import { AMEX_SHEET } from "./shared.js";

export function writeWorkbook(grid: string[][], bookType: "biff8" | "xlsx", sheet: string): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), sheet);
  return new Uint8Array(XLSX.write(wb, { bookType, type: "buffer" }) as Buffer);
}

const CAIXA_HEADER = [
  "", "Número de cuenta", "Oficina", "Referencia", "Fecha operación", "Fecha valor",
  "Ingreso (+)", "Gasto (-)", "Saldo (+)", "Saldo (-)", "Código común", "Código propio",
  "Concepto común", "Concepto propio", "Concepto complementario", "Concepto complementario",
  "Concepto complementario", "Concepto complementario", "Concepto complementario",
  "Concepto complementario", "Concepto complementario", "Concepto complementario",
  "Concepto complementario", "Concepto complementario",
];

export function caixabankSampleXls(): Uint8Array {
  const grid: string[][] = [
    ["CaixaBank — Movimientos (muestra sintética)"],
    [],
    CAIXA_HEADER,
    ["", "2100 0000 0000 0000 1234", "", "", "04/05/2026", "05/05/2026", "", "42,30",
      "1.023,45", "", "11", "612", "COMPRA TARJETA", "5402XXXX1111",
      "Fecha de operación: 02-05-2026 Peluquería Ñoño", "04000174TCR"],
    ["", "2100 0000 0000 0000 1234", "", "", "12/05/2026", "", "", "55,12",
      "", "", "03", "230", "RECIBO LUZ", "",
      "CORE IBERDROLA CLIENTES  X0001", "ES84002A82018474   X0040"],
    [],
    CAIXA_HEADER,
    ["", "2100 0000 0000 0000 5678", "", "", "20/05/2026", "20/05/2026", "25,00", "",
      "125,00", "", "04", "002", "BIZUM", "", "MARIA;GARCIA;LOPEZ", "Cena viernes"],
  ];
  return writeWorkbook(grid, "biff8", "Movimientos");
}

export function deutscheSampleXls(): Uint8Array {
  const grid: string[][] = [
    ["", "Deutsche Bank (muestra sintética)"],
    ["", "Cuenta:", "ES4400190000000000000001"],
    [],
    ["", "date", "valuedate", "concept", "", "", "", "", "amount", "balance"],
    ["", "05/05/2026", "05/05/2026", "RECIBO  IBERDROLA CLIENTES SAU", "", "", "", "", "-55,12", "1.200,00"],
    ["", "07/05/2026", "", "TRANSFERENCIA A FAVOR DE JUAN EJEMPLO", "", "", "", "", "-250,00", "950,00"],
    ["", "28/05/2026", "28/05/2026", "NOM.EX-4 A EMPRESA EJEMPLO SL", "", "", "", "", "2.500,00", "3.450,00"],
  ];
  return writeWorkbook(grid, "biff8", "Hoja1");
}

export function openbankSampleHtml(): Uint8Array {
  const html = `<html><head><title>OPENBANK - Cuentas - Movimientos</title></head><body>
<table><tr><td>Número de Cuenta:</td><td>0073 0100 5100 0000 0001</td></tr></table>
<table>
<tr><td>Fecha Operación</td><td>Fecha Valor</td><td>Concepto</td><td>Importe</td><td>Saldo</td></tr>
<tr><td>06/05/2026</td><td>06/05/2026</td><td>TRANSFERENCIA DE CARLOS EJEMPLO, CONCEPTO Aportación mayo</td><td>300,00</td><td>1.300,00</td></tr>
<tr><td>31/05/2026</td><td>-</td><td>LIQUIDACION CUENTA ABIERTA</td><td>1,23</td><td>1.301,23</td></tr>
</table></body></html>`;
  return new Uint8Array(Buffer.from(html, "latin1"));
}

export function amexSampleXlsx(): Uint8Array {
  const grid: string[][] = [
    ["Titular", "SR EJEMPLO"],
    ["Número de Cuenta"],
    ["XXXX-XXXXX-91009"],
    [],
    ["Fecha", "Descripción", "Importe", "Categoría", "Referencia"],
    ["06/05/2026", "AMAZON ES", "18,99", "Compras", "320261250012345678"],
    ["10/05/2026", "RECIBO ENVIADO A SU BANCO", "-500,00", "", "320261250099999999"],
  ];
  return writeWorkbook(grid, "xlsx", AMEX_SHEET);
}

export function amexSampleXlsxSinHoja(): Uint8Array {
  return writeWorkbook([["Fecha", "Importe"]], "xlsx", "Otra hoja");
}
