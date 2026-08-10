import type { DemoUser, HouseholdMembership } from './types';

/**
 * Papel y membresía de una identidad EN EL HOGAR QUE SE PIDE.
 *
 * Es la única puerta legítima al rol. Antes el rol salía de la primera
 * membresía de la lista (`memberships.rows[0]`) y acompañaba a la persona a
 * cualquier hogar: quien administraba su casa entraba de administrador en la
 * casa ajena donde solo echaba una mano, y bastaba con una segunda empleada en
 * el mismo hogar para que la aritmética de permisos dejara de corresponder a
 * quien mira. Aquí el hogar es un argumento obligatorio, no un supuesto.
 *
 * Devuelve null cuando no hay identidad o cuando esa identidad no tiene
 * membresía viva en ese hogar: quien llama debe tratar ese null como un 404,
 * nunca como «pues el papel de siempre».
 */
export function membershipIn(
  user: DemoUser | null | undefined,
  householdId: string
): HouseholdMembership | null {
  if (!user) return null;
  for (const membership of user.memberships) {
    if (membership.householdId === householdId) return membership;
  }
  return null;
}

/** ¿Esta identidad pertenece a ese hogar? Atajo legible de `membershipIn`. */
export function belongsToHousehold(
  user: DemoUser | null | undefined,
  householdId: string
): boolean {
  return membershipIn(user, householdId) !== null;
}

/**
 * Hogar al que llevar a alguien que entra sin destino. El primero de su lista
 * (el más antiguo, por `created_at`); no tiene más significado que ese, y por
 * eso solo lo usan las redirecciones de cortesía, jamás una decisión de
 * permisos.
 */
export function landingHouseholdId(user: DemoUser | null | undefined): string | null {
  return user?.memberships[0]?.householdId ?? null;
}
