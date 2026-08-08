import { describe, expect, it } from 'vitest';
import { HOUSEHOLD_MODULES, MODULE_CAPABILITY, guardForPath, householdPath } from '../src/lib/auth/routing';

describe('household route contract', () => {
  it('keeps every required stable module addressable', () => {
    expect(HOUSEHOLD_MODULES).toEqual([
      'today', 'employment', 'menu', 'recipes', 'wiki', 'search',
      'routines', 'calendar', 'contacts', 'emergency', 'account', 'settings'
    ]);

    // «Tu contraseña» la alcanza todo el mundo; Ajustes sigue siendo de la
    // familia. Si esto se invirtiera, la empleada quedaría sin forma de cambiar
    // su propia contraseña.
    expect(MODULE_CAPABILITY.account).toBe('emergency.read');
    expect(MODULE_CAPABILITY.settings).toBe('access.manage');

    for (const moduleName of HOUSEHOLD_MODULES) {
      const path = householdPath('household one', moduleName);
      expect(path).toBe(`/h/household%20one/${moduleName}`);
      expect(guardForPath(path)).toEqual({
        householdId: 'household one',
        module: moduleName,
        capability: MODULE_CAPABILITY[moduleName],
        known: true
      });
    }
  });

  it('allows the household index and supported wiki children', () => {
    expect(guardForPath('/h/casa-roble')).toMatchObject({ known: true, capability: null });
    expect(guardForPath('/h/casa-roble/wiki/lavadora')).toMatchObject({
      known: true,
      module: 'wiki',
      capability: 'content.read'
    });
  });

  it('autoriza cada ruta hija declarada con su propia regla, no con la del padre', () => {
    // Pactar condiciones es escribir el acuerdo: solo quien administra.
    expect(guardForPath('/h/casa-roble/employment/acuerdo')).toEqual({
      householdId: 'casa-roble',
      module: 'employment',
      capability: 'agreement.write',
      known: true
    });
    // Leerlas es otra cosa, y por eso pide otra capacidad.
    expect(guardForPath('/h/casa-roble/employment/condiciones')).toEqual({
      householdId: 'casa-roble',
      module: 'employment',
      capability: 'agreement.read',
      known: true
    });
    // Ninguna de las dos hereda `settlement.read`, la del módulo padre.
    expect(MODULE_CAPABILITY.employment).toBe('settlement.read');
  });

  it('fails closed for unknown or unsupported child paths', () => {
    expect(guardForPath('/h/casa-roble/admin')).toMatchObject({ known: false, capability: null });
    expect(guardForPath('/h/casa-roble/today/private')).toMatchObject({ known: false, capability: null });
    // Una ruta hija que nadie declaró no existe, aunque su padre sí.
    expect(guardForPath('/h/casa-roble/employment/inventada')).toMatchObject({
      known: false,
      capability: null
    });
    expect(guardForPath('/h/casa-roble/employment/acuerdo/mas')).toMatchObject({ known: false });
    expect(guardForPath('/h/%E0%A4%A/today')).toMatchObject({ known: false });
    expect(guardForPath('/login')).toBeNull();
  });
});
