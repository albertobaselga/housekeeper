import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  ROLES,
  ROLE_CAPABILITIES,
  can,
  capabilitiesFor
} from '../src/lib/auth/capabilities';

describe('capability matrix', () => {
  it('defines exactly the five product roles', () => {
    expect(ROLES).toEqual([
      'family_admin',
      'family_member',
      'employee_live_in',
      'helper',
      'viewer'
    ]);
    expect(new Set(ROLES).size).toBe(5);
    expect(Object.keys(ROLE_CAPABILITIES)).toHaveLength(5);
  });

  it('uses only the shared contract capability vocabulary', () => {
    expect(CAPABILITIES).toEqual([
      'access.manage', 'agreement.read', 'agreement.write', 'calendar.read', 'calendar.write',
      'comment.create', 'contact.read', 'contact.write', 'content.read', 'content.write',
      'content.publish', 'emergency.read', 'expense.create.self', 'export.employment.self',
      'finance.access', 'guide.write', 'leave.approve', 'leave.request.self', 'menu.read', 'menu.write', 'payment.confirm.self',
      'payment.register', 'routine.read', 'routine.toggle', 'search.use', 'settlement.close',
      'settlement.read', 'work.confirm', 'work.register.self'
    ]);
    for (const grants of Object.values(ROLE_CAPABILITIES)) {
      expect(grants.every((grant) => CAPABILITIES.includes(grant))).toBe(true);
    }
  });

  it('keeps privileged and self-service operations scoped', () => {
    expect(can('family_admin', 'access.manage')).toBe(true);
    expect(can('family_admin', 'settlement.close')).toBe(true);
    expect(can('family_member', 'content.write')).toBe(true);
    expect(can('family_member', 'settlement.close')).toBe(false);
    expect(can('employee_live_in', 'work.register.self')).toBe(true);
    expect(can('employee_live_in', 'content.write')).toBe(false);
    // Escribir la Guía de la casa es SOLO de la administración: ni la familia
    // no administradora ni la interna dibujan un control de escritura.
    expect(can('family_admin', 'guide.write')).toBe(true);
    expect(can('family_member', 'guide.write')).toBe(false);
    expect(can('employee_live_in', 'guide.write')).toBe(false);
    expect(can('helper', 'guide.write')).toBe(false);
    expect(can('viewer', 'guide.write')).toBe(false);
    expect(can('helper', 'routine.toggle')).toBe(true);
    expect(can('helper', 'calendar.read')).toBe(false);
    expect(capabilitiesFor('viewer')).toEqual(
      expect.arrayContaining(['contact.read', 'emergency.read', 'calendar.read'])
    );
    expect(capabilitiesFor('viewer')).toHaveLength(3);
    // Finanzas: la capacidad solo existe para la administración; la segunda
    // llave (la concesión por membresía) vive en la base, no en esta matriz.
    expect(can('family_admin', 'finance.access')).toBe(true);
    expect(can('family_member', 'finance.access')).toBe(false);
    expect(can('employee_live_in', 'finance.access')).toBe(false);
    expect(can('helper', 'finance.access')).toBe(false);
    expect(can('viewer', 'finance.access')).toBe(false);
  });

  it('fails closed for unknown roles and capabilities', () => {
    expect(can('owner', 'access.manage')).toBe(false);
    expect(can('family_admin', 'root.everything')).toBe(false);
    expect(capabilitiesFor(null)).toEqual([]);
    expect(capabilitiesFor('')).toEqual([]);
  });
});
