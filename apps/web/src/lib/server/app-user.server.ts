import type { Pool } from 'pg';

import type { DemoUser, HouseholdSummary } from '$lib/auth/types';
import { isRole } from '@casa-clara/contracts';

import { getDatabasePool } from './db.server';

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase('es') ?? '')
    .join('');
}

/**
 * Resuelve el perfil de aplicación de una identidad autenticada leyendo sus
 * membresías vivas bajo RLS (solo `app.user_id` fijado). La política de la base
 * excluye membresías revocadas o caducadas, así que la revocación se aplica en
 * cada petición sin lógica adicional aquí.
 */
export async function resolveAppUser(
  userId: string,
  email: string,
  fallbackName: string,
  // Inyectable como en el resto de lecturas del servidor: la suite de
  // integración le pasa su propio pool sin tocar DATABASE_URL del proceso.
  databasePool: Pool | null = getDatabasePool()
): Promise<DemoUser | null> {
  const pool = databasePool;
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true)", [userId]);
    const memberships = await client.query<{
      id: string;
      household_id: string;
      role: string;
      display_name: string | null;
    }>(
      `select m.id, m.household_id, m.role::text as role, p.display_name
         from app.household_memberships m
         left join app.user_profiles p on p.user_id = m.user_id
        where m.user_id = $1
        order by m.created_at`,
      [userId]
    );
    const first = memberships.rows[0];
    if (!first || !isRole(first.role)) {
      await client.query('commit');
      return null;
    }
    const households: HouseholdSummary[] = [];
    for (const row of memberships.rows) {
      await client.query('select app.set_household_context($1, $2)', [row.household_id, row.id]);
      const summary = await client.query<{ display_name: string }>(
        'select display_name from app.households where id = $1',
        [row.household_id]
      );
      const displayName = summary.rows[0]?.display_name;
      if (displayName) {
        // Sin adjetivos: esta rama es la de una instalación real. El aviso de
        // datos sintéticos lo pone el banner del AppShell cuando el entorno se
        // declara como tal (ALLOW_SYNTHETIC_DATA_ONLY), no este subtítulo.
        households.push({ id: row.household_id, name: displayName, subtitle: 'Tu hogar' });
      }
    }
    await client.query('commit');
    const name = first.display_name?.trim() || fallbackName;
    return {
      id: userId,
      membershipId: first.id,
      name,
      initials: initialsFor(name) || '·',
      email,
      role: first.role,
      householdIds: [...new Set(memberships.rows.map((row) => row.household_id))],
      households
    };
  } catch {
    await client.query('rollback').catch(() => {});
    return null;
  } finally {
    client.release();
  }
}
