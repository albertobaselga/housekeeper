import {
  capabilities,
  hasCapability,
  roleCapabilities,
  roles,
  type Capability,
  type Role
} from '@casa-clara/contracts';

export const ROLES = roles;
export const CAPABILITIES = capabilities;
export const ROLE_CAPABILITIES = roleCapabilities;
export type { Capability, Role };

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  family_admin: 'Administrador familiar',
  family_member: 'Miembro de la familia',
  employee_live_in: 'Empleada interna',
  helper: 'Apoyo del hogar',
  viewer: 'Acceso puntual'
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (roles as readonly string[]).includes(value);
}

export function capabilitiesFor(role: Role | string | null | undefined): readonly Capability[] {
  return isRole(role) ? roleCapabilities[role] : [];
}

export function can(
  role: Role | string | null | undefined,
  capability: Capability | string
): boolean {
  if (!isRole(role) || !(capabilities as readonly string[]).includes(capability)) return false;
  return hasCapability(role, capability as Capability);
}
