// La matriz se importa del submódulo, NUNCA de la raíz `@housekeeper/contracts`:
// la raíz viaja en el arranque de todas las pantallas (verifica la firma del
// paquete offline) y arrastraría ~1,2 kB de tablas que el cliente no usa —
// las capacidades de la sesión llegan ya resueltas en `AppContextV1`.
// Ver la cabecera de `packages/contracts/src/capabilities.ts`.
import {
  capabilities,
  hasCapability,
  roleCapabilities,
  roles,
  type Capability,
  type Role
} from '@housekeeper/contracts/capabilities';

export const ROLES = roles;
export const CAPABILITIES = capabilities;
export const ROLE_CAPABILITIES = roleCapabilities;
export type { Capability, Role };

// Las etiquetas de los papeles NO están aquí: viven en `./role-labels.ts` para
// que la cabecera del hogar pueda pintarlas sin arrastrar la matriz. No las
// reexportes desde este módulo; volverías a juntar las dos cosas en el trozo.

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
