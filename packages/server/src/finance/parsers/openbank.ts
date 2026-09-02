import type { ParsedRow } from "@housekeeper/domain/finance";

import { FinanceParserError, balanceCentsOf, buildRaw, parseDateEs, toCents } from "./shared.js";

const DATE_RX = /^\d{2}\/\d{2}\/\d{4}$/;
const TRANSFER_RX = /^TRANSFERENCIA(?:\s+INMEDIATA)?\s+(?:A\s+FAVOR\s+DE|DE)\s+(.*)/i;

/** Subconjunto de la tabla de entidades HTML con nombre que puede aparecer de
 * verdad en un extracto español (acentos, ñ, símbolos de puntuación y moneda).
 * `html.parser.HTMLParser` del origen decodifica la tabla HTML5 completa
 * (~2000 entradas); no la replicamos entera a propósito porque un extracto
 * bancario no trae `&hearts;` ni jeroglíficos — solo las que sí pueden salir
 * de un exportador que escapó un `<td>` con tildes. Cualquier entidad con
 * nombre fuera de esta lista se deja literal, igual que el origen deja las
 * inválidas.
 * `Object.create(null)` en vez de `{}`: sin `Object.prototype` en la cadena,
 * `&constructor;`/`&toString;`/etc. no encuentran nada que devolver y caen al
 * mismo "desconocida → literal" que cualquier otra entidad inexistente, en
 * vez de filtrar código fuente de `Object` dentro de `concept`.
 * `nbsp` decodifica al espacio duro U+00A0 (no U+0020): es lo que hace
 * `html.unescape` del origen, y un `&nbsp;` interior sí sobrevive al `trim()`
 * de las celdas separadoras vacías porque solo afecta los extremos. */
const NAMED_ENTITIES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", uuml: "ü", ntilde: "ñ",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Uuml: "Ü", Ntilde: "Ñ",
  iexcl: "¡", iquest: "¿", euro: "€", ordf: "ª", ordm: "º", sup2: "²",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", mdash: "—", ndash: "–",
});

/** `String.fromCodePoint` lanza `RangeError` fuera de 0..0x10FFFF o en el
 * hueco de subrogados (0xD800..0xDFFF). `html.unescape` del origen no falla
 * ahí: sustituye por el carácter de reemplazo U+FFFD. Una referencia numérica
 * fuera de rango en un extracto real es absurda, pero no debe escapar como
 * `RangeError` crudo cuando todo lo demás en el módulo falla como
 * `FinanceParserError` — o, aquí, simplemente no falla. */
function charFromCodePoint(cp: number): string {
  if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
  return String.fromCodePoint(cp);
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole: string, ref: string) => {
    const r = ref.toLowerCase();
    if (r.startsWith("#x")) return charFromCodePoint(Number.parseInt(r.slice(2), 16));
    if (r.startsWith("#")) return charFromCodePoint(Number(r.slice(1)));
    return NAMED_ENTITIES[ref] ?? NAMED_ENTITIES[r] ?? whole;
  });
}

/** Aplana el HTML de OpenBank a filas de celdas de texto (una lista por <tr>). */
function htmlTableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const td of (tr[1] as string).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)) {
      const inner = (td[1] as string).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "");
      cells.push(decodeEntities(inner).trim());
    }
    rows.push(cells);
  }
  return rows;
}

function obProvider(concept: string): string {
  const m = TRANSFER_RX.exec(concept);
  if (m !== null) {
    return ((m[1] as string).split(/,?\s*CONCEPTO\b/i)[0] as string).trim().slice(0, 200);
  }
  if (concept.toUpperCase().startsWith("LIQUIDACION")) return "Openbank";
  return concept.trim().slice(0, 200);
}

/** Port de parsers/openbank.py::parse (HTML disfrazado de .xls, iso-8859-1). */
export function parseOpenbank(bytes: Uint8Array): ParsedRow[] {
  const html = new TextDecoder("iso-8859-1").decode(bytes);
  // Filtrar las celdas vacías (no solo las separadoras de maquetación) colapsa
  // también una "Fecha Valor" vacía y desplaza el resto de columnas: la fila
  // puede acabar con menos de 5 celdas y perderse en silencio más abajo, o con
  // las columnas corridas si tiene 6+. Es el mismo comportamiento de
  // openbank.py (usa "-" y no vacío para "sin fecha valor" en los extractos
  // reales), así que la verificación cruzada de la fase 3 no lo nota: ambos
  // backends pierden la misma fila. Deliberado, no un descuido.
  const cellRows = htmlTableRows(html)
    .map((row) => row.filter((c) => c.trim() !== ""))
    .filter((row) => row.length > 0);

  let bankRef: string | null = null;
  for (const row of cellRows) {
    const head = (row[0] as string).trim().replace(/:+$/, "").toLowerCase();
    if (head.startsWith("número de cuenta") && row.length >= 2) {
      bankRef = (row[1] as string).replace(/ /g, "");
      break;
    }
  }
  if (bankRef === null) {
    throw new FinanceParserError("no se encontró el número de cuenta de OpenBank", 0);
  }
  const headers = cellRows.find((row) => row[0] === "Fecha Operación") ?? [];

  const rows: ParsedRow[] = [];
  cellRows.forEach((row, i) => {
    if (row.length < 5 || !DATE_RX.test(row[0] as string)) return;
    const [opRaw, valRaw, concept, importe, saldo] = row as [string, string, string, string, string];
    const amount = toCents(importe);
    if (amount === null) throw new FinanceParserError(`importe vacío en ${JSON.stringify(concept)}`, i);
    rows.push({
      accountRef: bankRef as string,
      bankRef: bankRef as string,
      opDate: parseDateEs(opRaw, i),
      valueDate: DATE_RX.test(valRaw) ? parseDateEs(valRaw, i) : null,
      concept,
      provider: obProvider(concept),
      amountCents: amount,
      balanceCents: balanceCentsOf(saldo, i), // vacío → null; ilegible → error
      codeCommon: null,
      codeOwn: null,
      dedupRef: null,
      bankCategory: null,
      raw: buildRaw(headers, row),
    });
  });
  if (rows.length === 0) throw new FinanceParserError("fichero de OpenBank sin movimientos", 0);
  return rows;
}
