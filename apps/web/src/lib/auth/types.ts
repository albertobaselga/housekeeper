import type { Capability, Role } from './capabilities';
import type { CriticalSnapshotV1 } from '$lib/offline/schema';

/**
 * Lo que una identidad es EN UN HOGAR concreto. Una persona puede tener varias:
 * la familia que administra su casa y echa una mano en la de sus padres, o una
 * empleada que trabaja en dos hogares distintos con papeles distintos.
 */
export interface HouseholdMembership {
  householdId: string;
  /** Identificador de la membresía en ESE hogar (no de la persona). */
  membershipId: string;
  role: Role;
}

/**
 * Identidad autenticada tal y como la lleva `locals.user`.
 *
 * No hay `role` ni `membershipId` sueltos, y es deliberado: el papel no es una
 * propiedad de la persona sino de su relación con un hogar. Cuando existían,
 * salían de la primera membresía y viajaban a todas las pantallas, de modo que
 * quien pertenecía a dos hogares —o el día que entraba una segunda empleada—
 * operaba con permisos que no le tocaban. Para saber qué puede hacer alguien
 * aquí hay que decir dónde: `membershipIn(user, householdId)`.
 */
export interface DemoUser {
  id: string;
  name: string;
  initials: string;
  email: string;
  /** Una entrada por hogar vivo. Nunca vacía: sin membresías no hay identidad. */
  memberships: readonly HouseholdMembership[];
  /**
   * Entró con la contraseña provisional que le entregaron en mano y todavía no
   * la ha cambiado. Mientras sea cierto, el hook del servidor no la deja pasar
   * de «Tu contraseña».
   */
  mustChangePassword: boolean;
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
  /** Membresía de esta persona EN ESTE hogar, el de la URL. */
  membershipId: string;
  /** Papel EN ESTE hogar. Nunca «el papel» de la persona: eso no existe. */
  role: Role;
  capabilities: readonly Capability[];
  locale: 'es-ES';
  timeZone: 'Europe/Madrid';
  criticalSnapshot: CriticalSnapshotV1;
  /** Clave pública Ed25519 (raw, base64url) para verificar snapshots offline. */
  snapshotPublicKey: string;
  /** Entorno declarado solo-sintético: el AppShell muestra un banner discreto. */
  synthetic?: boolean;
  /**
   * Hay identidad real con contraseña: el AppShell ofrece «Tu contraseña».
   * Sin ella (demo por fixtures) el enlace no aparece, porque no habría nada
   * que cambiar detrás.
   */
  passwordAuth?: boolean;
}
