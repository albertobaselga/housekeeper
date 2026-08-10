import { describe, expect, it } from 'vitest';

import { belongsToHousehold, landingHouseholdId, membershipIn } from '../src/lib/auth/membership';
import { capabilitiesFor, can } from '../src/lib/auth/capabilities';
import type { DemoUser } from '../src/lib/auth/types';

const ROBLE = '10000000-0000-4000-8000-000000000001';
const OLIVO = '20000000-0000-4000-8000-000000000001';

/**
 * Una identidad con dos casas. En la suya administra; en la de al lado solo
 * mira. Es el caso que rompía: el rol salía de la primera membresía y viajaba
 * a la segunda casa intacto.
 */
const DOS_CASAS: DemoUser = {
  id: 'fixture:doble:persona',
  name: 'Persona Sintética',
  initials: 'PS',
  email: 'persona@ejemplo.test',
  memberships: [
    { householdId: ROBLE, membershipId: 'membresia-roble', role: 'family_admin' },
    { householdId: OLIVO, membershipId: 'membresia-olivo', role: 'viewer' }
  ]
};

describe('el papel es del hogar, no de la persona', () => {
  it('devuelve la membresía del hogar que se pide, no la primera de la lista', () => {
    expect(membershipIn(DOS_CASAS, ROBLE)).toEqual({
      householdId: ROBLE,
      membershipId: 'membresia-roble',
      role: 'family_admin'
    });
    expect(membershipIn(DOS_CASAS, OLIVO)).toEqual({
      householdId: OLIVO,
      membershipId: 'membresia-olivo',
      role: 'viewer'
    });
  });

  /**
   * La regresión con nombre y apellidos. Si alguien vuelve a leer el rol de
   * `memberships[0]`, esta expectativa cae: en el olivo esta persona NO
   * administra, y las capacidades que se le calculen allí tampoco pueden ser
   * las de administrar.
   */
  it('en el segundo hogar no arrastra las capacidades del primero', () => {
    const olivo = membershipIn(DOS_CASAS, OLIVO);
    expect(olivo?.role).not.toBe(DOS_CASAS.memberships[0]!.role);
    expect(olivo?.role).toBe('viewer');

    const capabilities = capabilitiesFor(olivo?.role);
    expect(capabilities).not.toContain('access.manage');
    expect(capabilities).not.toContain('agreement.write');
    expect(can(olivo?.role, 'access.manage')).toBe(false);
    // Y lo que sí le toca allí sigue estando: Hoy y las urgencias.
    expect(can(olivo?.role, 'emergency.read')).toBe(true);
  });

  it('el identificador de membresía también es el del hogar de la URL', () => {
    // El expediente compara `agreement.employeeMembershipId` con la membresía
    // de quien mira: con la de otra casa, «su» acuerdo dejaría de ser suyo.
    expect(membershipIn(DOS_CASAS, OLIVO)?.membershipId).toBe('membresia-olivo');
  });

  it('un hogar ajeno no devuelve nada, ni siquiera un papel de cortesía', () => {
    expect(membershipIn(DOS_CASAS, '30000000-0000-4000-8000-000000000009')).toBeNull();
    expect(belongsToHousehold(DOS_CASAS, '30000000-0000-4000-8000-000000000009')).toBe(false);
    expect(belongsToHousehold(DOS_CASAS, OLIVO)).toBe(true);
  });

  it('sin identidad no hay membresía que valga', () => {
    expect(membershipIn(null, ROBLE)).toBeNull();
    expect(membershipIn(undefined, ROBLE)).toBeNull();
    expect(belongsToHousehold(null, ROBLE)).toBe(false);
    expect(landingHouseholdId(null)).toBeNull();
  });

  it('el hogar de aterrizaje es el primero, y solo sirve para redirigir', () => {
    expect(landingHouseholdId(DOS_CASAS)).toBe(ROBLE);
  });
});
