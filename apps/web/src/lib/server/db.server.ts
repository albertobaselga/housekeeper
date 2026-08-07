import pg from 'pg';
import { env } from '$env/dynamic/private';

let pool: pg.Pool | null | undefined;

/**
 * Pool perezoso hacia Postgres. Devuelve null cuando no hay DATABASE_URL: la demo
 * sin base de datos sigue funcionando en lectura, pero la sincronización responde
 * 503 en lugar de fingir confirmaciones.
 */
export function getDatabasePool(): pg.Pool | null {
  if (pool !== undefined) return pool;
  pool = env.DATABASE_URL ? new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 }) : null;
  return pool;
}
