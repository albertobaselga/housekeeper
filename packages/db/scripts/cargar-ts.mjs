// Cargar TS del monorepo desde un guion .mjs con `node` a pelo: el type
// stripping de Node 24 no reescribe los especificadores «./x.js» → x.ts que
// usan los fuentes, así que este hook reintenta con .ts SOLO si la
// resolución original falla. Importar SIEMPRE con importarModuloTs (dinámico).
import { registerHooks } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

let hooksInstalados = false;

function instalarResolucionTs() {
  if (hooksInstalados) return;
  hooksInstalados = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.endsWith('.js')) {
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        }
        throw error;
      }
    }
  });
}

/** Ruta canónica del hash de deduplicación de fase 2. */
export const rutaDedupHash = new URL('../../server/src/finance/dedup-hash.ts', import.meta.url);

export async function importarModuloTs(url) {
  instalarResolucionTs();
  return import(url.href ?? url);
}

// Autosonda: imprime el hash de una fila fija (la que espera el test).
const esEjecucionDirecta =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esEjecucionDirecta) {
  const { computeDedupHash } = await importarModuloTs(rutaDedupHash);
  console.log(computeDedupHash({
    bankRef: '00490001512345678901', opDate: '2026-01-10', amountCents: -2550n,
    concept: 'COMPRA SONDA', balanceCents: 150000n, dedupRef: null
  }));
}
