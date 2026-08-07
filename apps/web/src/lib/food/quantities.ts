/**
 * Aritmética decimal exacta para cantidades de ingredientes (numeric(10,2) en
 * la base). Todo opera sobre centésimas como BigInt: aquí no entra ningún
 * float, ni para escalar ni para agregar (AC-22, AC-24). Módulo puro sin
 * dependencias: lo comparten el servidor (agregado de compra) y el navegador
 * (escalado de raciones en la ficha de receta).
 */

/** "1", "1.5", "1,50" → centésimas (150n). Null si no es una cantidad válida. */
export function toHundredths(value: string): bigint | null {
  const match = /^(\d{1,8})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const hundredths = BigInt(match[1]!) * 100n + BigInt(fraction === '' ? '0' : fraction);
  return hundredths > 0n ? hundredths : null;
}

/** Centésimas → decimal canónico con punto y sin ceros de cola: 225n → "2.25", 230n → "2.3", 200n → "2". */
export function fromHundredths(hundredths: bigint): string {
  const units = hundredths / 100n;
  const rest = hundredths % 100n;
  if (rest === 0n) return units.toString();
  const two = rest.toString().padStart(2, '0');
  return `${units}.${two.endsWith('0') ? two.slice(0, 1) : two}`;
}

/**
 * Escala lineal exacta: quantity × servings / baseServings con redondeo half-up
 * a la centésima (la única pérdida posible, y solo cuando la división no es
 * exacta; 4→6 sobre "1.50" da "2.25" sin redondeo alguno).
 */
export function scaleQuantity(quantity: string, servings: number, baseServings: number): string | null {
  const hundredths = toHundredths(quantity);
  if (hundredths === null || !Number.isInteger(servings) || !Number.isInteger(baseServings)) return null;
  if (servings <= 0 || baseServings <= 0) return null;
  const numerator = hundredths * BigInt(servings);
  const denominator = BigInt(baseServings);
  const scaled = (numerator + denominator / 2n) / denominator;
  return fromHundredths(scaled);
}

/** Suma exacta de dos cantidades decimales ("1.5" + "0.75" → "2.25"). */
export function addQuantities(a: string, b: string): string | null {
  const first = toHundredths(a);
  const second = toHundredths(b);
  if (first === null || second === null) return null;
  return fromHundredths(first + second);
}

/** Presentación en español: "2.25" → "2,25". */
export function formatQuantityEs(value: string): string {
  return value.replace('.', ',');
}
