/**
 * El diccionario de causas (`error-codes.ts`) es una tabla larga que solo hace
 * falta cuando el servidor RECHAZA algo, que es lo excepcional. Cargarlo bajo
 * demanda lo saca del arranque de Hoy sin perder ni un literal: el camino
 * feliz nunca lo descarga y el camino de error lo espera unos milisegundos.
 */
export async function describeErrorCodeLazy(code: string | undefined): Promise<string | null> {
  if (!code) return null;
  return (await import('./error-codes')).describeErrorCode(code);
}
