import { API_VERSION, CRITICAL_SNAPSHOT_TTL_MS, type CriticalSnapshotV1 } from '@casa-clara/contracts';
import { canonicalSha256, signCriticalSnapshot } from '@casa-clara/server';

import type { SnapshotContact } from './contacts.server';
import { getCriticalSnapshotPayload } from './fixtures.server';
import { getSnapshotKeys } from './keys.server';

/**
 * Construye y firma el snapshot crítico del contrato. Con `realContacts`
 * (lectura RLS de app.contacts vía loadSnapshotContacts) `payload.contacts` y
 * `payload.emergency` son los del hogar de verdad: el offline y la búsqueda
 * local sirven contactos verdaderos. Sin pool (demo) el contenido sigue siendo
 * la fixture sintética; la envolvente (versión, etag, caducidad de 24 h y
 * firma Ed25519) es real en ambos casos.
 */
export function buildCriticalSnapshot(
  householdId: string,
  membershipId: string,
  realContacts?: SnapshotContact[] | null
): CriticalSnapshotV1 {
  const payload = getCriticalSnapshotPayload(realContacts ?? null);
  const etag = canonicalSha256(payload);
  const generatedAt = new Date();
  const expiresAt = new Date(generatedAt.getTime() + CRITICAL_SNAPSHOT_TTL_MS);
  return signCriticalSnapshot(
    {
      apiVersion: API_VERSION,
      schemaVersion: 1,
      householdId,
      membershipId,
      version: `${realContacts ? 'live' : 'fixture'}-${etag.slice(0, 12)}`,
      etag,
      cursor: generatedAt.toISOString(),
      generatedAt: generatedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      payload
    },
    getSnapshotKeys().privateKeyPem
  );
}
