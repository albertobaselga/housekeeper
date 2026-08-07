import type { Capability, Role } from './capabilities';
import type { CriticalSnapshotV1 } from '$lib/offline/schema';

export interface DemoUser {
  id: string;
  name: string;
  initials: string;
  email: string;
  role: Role;
  householdIds: string[];
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
}
