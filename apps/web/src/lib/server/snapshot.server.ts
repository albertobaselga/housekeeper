import { API_VERSION, CRITICAL_SNAPSHOT_TTL_MS, type CriticalSnapshotV1 } from '@casa-clara/contracts';
import { canonicalSha256, signCriticalSnapshot } from '@casa-clara/server';

import { getCriticalSnapshotPayload } from './fixtures.server';
import { getSnapshotKeys } from './keys.server';

/**
 * Construye y firma el snapshot crítico del contrato. El contenido sigue siendo
 * la fixture sintética hasta que los módulos de dominio lean de Postgres; la
 * envolvente (versión, etag, caducidad de 24 h y firma Ed25519) ya es la real.
 */
export function buildCriticalSnapshot(householdId: string, membershipId: string): CriticalSnapshotV1 {
  const payload = getCriticalSnapshotPayload();
  const etag = canonicalSha256(payload);
  const generatedAt = new Date();
  const expiresAt = new Date(generatedAt.getTime() + CRITICAL_SNAPSHOT_TTL_MS);
  return signCriticalSnapshot(
    {
      apiVersion: API_VERSION,
      schemaVersion: 1,
      householdId,
      membershipId,
      version: `fixture-${etag.slice(0, 12)}`,
      etag,
      cursor: generatedAt.toISOString(),
      generatedAt: generatedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      payload
    },
    getSnapshotKeys().privateKeyPem
  );
}
