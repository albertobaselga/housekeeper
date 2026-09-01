import type { Pool } from 'pg';

import type { Role } from '@housekeeper/contracts';
import { createLogger, withAuthorizedTransaction } from '@housekeeper/server';

import { CONTACT_KINDS, type ContactKind } from '$lib/contacts/kinds';

import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:contacts');

const FAMILY_ROLES: readonly Role[] = ['family_admin', 'family_member'];

export type { ContactKind };

export interface ContactView {
  id: string;
  name: string;
  roleLabel: string;
  phone: string;
  kind: ContactKind;
  featured: boolean;
  notes: string;
}

export interface ContactsDirectory {
  householdId: string;
  role: Role;
  /** Solo la familia gestiona el directorio (policy contacts_family_write). */
  canWrite: boolean;
  /** Contactos activos (sin archivar), ordenados por tipo y posición. */
  contacts: ContactView[];
}

/**
 * Directorio real del hogar leído de Postgres bajo RLS: los cinco roles ven
 * los contactos (contacts_read exige contexto de hogar + rol activo).
 *
 * `null` significa exactamente dos cosas, las dos inofensivas: no hay pool
 * (demostración sin `DATABASE_URL`) o no hay membresía viva. Cualquier avería
 * de infraestructura ya NO se colapsa aquí: sale como `DataUnavailableError` y
 * la página responde 503. Esta distinción es la que impide que un corte de
 * base de datos acabe pintando teléfonos inventados en Emergencias.
 */
export async function loadContacts(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<ContactsDirectory | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      const result = await client.query<{
        id: string;
        name: string;
        roleLabel: string;
        phone: string;
        kind: ContactKind;
        featured: boolean;
        notes: string;
      }>(
        `select id, name, role_label as "roleLabel", phone, kind, featured, notes
           from app.contacts
          where household_id = $1 and archived_at is null
          order by array_position($2::text[], kind), position, name`,
        [householdId, CONTACT_KINDS]
      );
      return {
        householdId,
        role: membership.role,
        canWrite: FAMILY_ROLES.includes(membership.role),
        contacts: result.rows.map((row) => ({ ...row }))
      } satisfies ContactsDirectory;
    });
  } catch (cause) {
    return unreadable(log, 'contacts', cause);
  }
}

export interface EmergencyLive {
  householdId: string;
  canWrite: boolean;
  /** Contactos destacados (featured) del hogar; el 112 va aparte, fijo en la UI. */
  featured: ContactView[];
}

/**
 * Vista de Emergencias real: solo los contactos destacados del hogar. El 112
 * NO sale de la base de datos: la página lo pinta siempre, fijo. Sin pool o
 * sin membresía devuelve null; con base configurada y avería, lanza.
 */
export async function loadEmergencyContacts(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<EmergencyLive | null> {
  const directory = await loadContacts(user, householdId, pool);
  if (!directory) return null;
  return {
    householdId,
    canWrite: directory.canWrite,
    featured: directory.contacts.filter((contact) => contact.featured)
  };
}

export interface SnapshotContact {
  id: string;
  name: string;
  phone: string;
  kind: string;
}

/**
 * Contactos del CriticalSnapshot (offline y búsqueda local): el 112 fijo
 * primero y después los destacados REALES del hogar. Devuelve null sin pool o
 * sin membresía; con base configurada el snapshot resultante lleva el 112 y
 * nada más, nunca la maqueta.
 */
export async function loadSnapshotContacts(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<SnapshotContact[] | null> {
  const directory = await loadContacts(user, householdId, pool);
  if (!directory) return null;
  return [
    { id: 'emergency-112', name: 'Emergencias', phone: '112', kind: 'emergency' },
    ...directory.contacts
      .filter((contact) => contact.featured)
      .map((contact) => ({ id: contact.id, name: contact.name, phone: contact.phone, kind: contact.kind }))
  ];
}
