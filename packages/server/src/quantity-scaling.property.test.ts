import { describe, expect, it } from "vitest";

import {
  formatHundredths,
  scaleHundredths,
  scaleIngredientHundredths,
  toHundredths,
} from "./commands/menu.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tests de propiedades sin dependencias nuevas (AC-22): un generador
// pseudoaleatorio con semilla FIJA (mulberry32) produce los mismos 500 casos en
// cada ejecución, así que cualquier fallo es reproducible con el índice del
// caso. Las utilidades bajo prueba son exactamente las que usa
// aggregateShoppingList en packages/server/src/commands/menu.ts.
// ─────────────────────────────────────────────────────────────────────────────

const CASES = 500;
const SEED = 0xac22;

/** PRNG determinista de 32 bits (mulberry32). Devuelve valores en [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intBetween(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** Baraja determinista de Fisher-Yates con el mismo PRNG sembrado. */
function shuffled<T>(random: () => number, values: readonly T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = intBetween(random, 0, index);
    [copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T];
  }
  return copy;
}

describe("AC-22: propiedades del escalado exacto de cantidades (500 casos, semilla fija)", () => {
  it("formato y parseo son inversos exactos: céntimas → texto → céntimas sin pérdida", () => {
    const random = mulberry32(SEED);
    for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
      // Desde 0.01 hasta 100000.00 en céntimas, límites de recipe_ingredients
      // (numeric(10,2) > 0).
      const hundredths = BigInt(intBetween(random, 1, 10_000_000));
      const text = formatHundredths(hundredths);
      expect(toHundredths(text), `caso ${caseIndex}: ${text}`).toBe(hundredths);
      // La coma decimal española parsea idéntica al punto.
      expect(toHundredths(text.replace(".", ","))).toBe(hundredths);
    }
  });

  it("linear con ratio entero escala exacto y la vuelta restaura la cantidad original", () => {
    const random = mulberry32(SEED + 1);
    for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
      const quantity = BigInt(intBetween(random, 1, 1_000_000));
      const base = intBetween(random, 1, 12);
      const factor = intBetween(random, 1, 8);
      const target = base * factor;

      // Sin resto no hay redondeo: el resultado es la multiplicación exacta…
      const scaled = scaleHundredths(quantity, target, base);
      expect(scaled, `caso ${caseIndex}: ${quantity}×${factor}`).toBe(quantity * BigInt(factor));
      // …y la ida y vuelta por céntimas devuelve la cantidad original.
      expect(scaleHundredths(scaled, base, target)).toBe(quantity);
      // También sobrevive a pasar por el formato decimal (round-trip completo).
      expect(toHundredths(formatHundredths(scaled))).toBe(scaled);
    }
  });

  it("linear con ratio arbitrario: el error frente al valor racional exacto es ≤ media céntima", () => {
    const random = mulberry32(SEED + 2);
    for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
      const quantity = BigInt(intBetween(random, 1, 1_000_000));
      const base = intBetween(random, 1, 12);
      const target = intBetween(random, 1, 24);

      const scaled = scaleHundredths(quantity, target, base);
      // |scaled - quantity·target/base| ≤ 1/2 céntima, es decir
      // |2·scaled·base - 2·quantity·target| ≤ base.
      const doubledError = 2n * scaled * BigInt(base) - 2n * quantity * BigInt(target);
      const magnitude = doubledError < 0n ? -doubledError : doubledError;
      expect(magnitude <= BigInt(base), `caso ${caseIndex}: ${quantity}·${target}/${base}`).toBe(true);
      // El redondeo es half-up: nunca por debajo del cociente truncado.
      expect(scaled >= (quantity * BigInt(target)) / BigInt(base)).toBe(true);
    }
  });

  it("fixed es invariante a cualquier cambio de raciones", () => {
    const random = mulberry32(SEED + 3);
    for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
      const quantity = BigInt(intBetween(random, 1, 1_000_000));
      const base = intBetween(random, 1, 12);
      const target = intBetween(random, 1, 24);
      expect(
        scaleIngredientHundredths(quantity, "fixed", target, base),
        `caso ${caseIndex}: fixed ${quantity} con ${base}→${target}`,
      ).toBe(quantity);
      // Y linear delega en scaleHundredths, sin ninguna otra transformación.
      expect(scaleIngredientHundredths(quantity, "linear", target, base)).toBe(
        scaleHundredths(quantity, target, base),
      );
    }
  });

  it("la suma agregada es exacta, conmutativa y asociativa en cualquier orden y agrupación", () => {
    const random = mulberry32(SEED + 4);
    for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
      const quantities = Array.from({ length: intBetween(random, 2, 12) }, () =>
        BigInt(intBetween(random, 1, 5_000_000)),
      );

      const forward = quantities.reduce((total, value) => total + value, 0n);
      const reversed = [...quantities].reverse().reduce((total, value) => total + value, 0n);
      const permuted = shuffled(random, quantities).reduce((total, value) => total + value, 0n);
      // Agrupación distinta: mitades sumadas por separado y combinadas después.
      const half = Math.floor(quantities.length / 2);
      const grouped =
        quantities.slice(0, half).reduce((total, value) => total + value, 0n) +
        quantities.slice(half).reduce((total, value) => total + value, 0n);

      expect(reversed, `caso ${caseIndex}`).toBe(forward);
      expect(permuted).toBe(forward);
      expect(grouped).toBe(forward);
      // El total agregado también sobrevive al formato decimal sin pérdida.
      expect(toHundredths(formatHundredths(forward))).toBe(forward);
    }
  });
});
