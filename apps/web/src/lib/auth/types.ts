import type { Capability, Role } from './capabilities';
import type { CriticalSnapshotV1 } from '$lib/offline/schema';

export interface DemoUser {
  id: string;
  membershipId: string;
  name: string;
  initials: string;
  email: string;
  role: Role;
  householdIds: string[];
  /** Resúmenes de hogar leídos de la base de datos en modo de autenticación real. */
  households?: HouseholdSummary[];
}

export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface HouseholdSummary {
  id: string;
  name: string;
  subtitle: string;
}

export interface AppContext {
  user: DemoUser;
  household: HouseholdSummary;
  role: Role;
  capabilities: readonly Capability[];
  locale: 'es-ES';
  timeZone: 'Europe/Madrid';
  criticalSnapshot: CriticalSnapshotV1;
  /** Clave pública Ed25519 (raw, base64url) para verificar snapshots offline. */
  snapshotPublicKey: string;
}
