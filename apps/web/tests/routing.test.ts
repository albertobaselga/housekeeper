import { describe, expect, it } from 'vitest';
import { can } from '../src/lib/auth/capabilities';
import {
  HOUSEHOLD_MODULES,
  MODULE_CAPABILITY,
  guardForPath,
  householdPath,
  pickHousehold
} from '../src/lib/auth/routing';

describe('household route contract', () => {
  it('keeps every required stable module addressable', () => {
    expect(HOUSEHOLD_MODULES).toEqual([
      'today', 'employment', 'menu', 'recipes', 'wiki', 'search',
      'routines', 'calendar', 'contacts', 'emergency', 'account', 'personal', 'finanzas', 'settings'
    ]);

    // «Tu cuenta» la alcanza todo el mundo; Ajustes sigue siendo de la familia.
    // Si esto se invirtiera, la empleada quedaría sin forma de cambiar su propia
    // contraseña — y sin forma de encender o apagar sus avisos, que es lo otro
    // que vive ahí y que nadie más puede tocar por ella.
    expect(MODULE_CAPABILITY.account).toBe('emergency.read');
    expect(MODULE_CAPABILITY.settings).toBe('access.manage');
    // Personal enseña nombres, fechas y sueldos de las compañeras: la misma
    // llave que Ajustes, nunca la mínima de Hoy.
    expect(MODULE_CAPABILITY.personal).toBe('access.manage');

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
    // El historial de vacaciones lo abren los mismos tres que la política
    // `vacation_periods_read` deja leer: administración, familia y la propia
    // empleada. Al apoyo y al visor no les llega ni la ruta.
    expect(guardForPath('/h/casa-roble/employment/vacaciones')).toEqual({
      householdId: 'casa-roble',
      module: 'employment',
      capability: 'agreement.read',
      known: true
    });
    expect(can('helper', 'agreement.read')).toBe(false);
    expect(can('viewer', 'agreement.read')).toBe(false);
    // Las dos pestañas nuevas piden la misma llave que la raíz del expediente:
    // la familia no administradora entra y ve lo pendiente en solo lectura,
    // y los importes los recorta la RLS, igual que en el resumen.
    expect(guardForPath('/h/casa-roble/employment/conceptos')).toEqual({
      householdId: 'casa-roble',
      module: 'employment',
      capability: 'settlement.read',
      known: true
    });
    expect(guardForPath('/h/casa-roble/employment/pagos')).toEqual({
      householdId: 'casa-roble',
      module: 'employment',
      capability: 'settlement.read',
      known: true
    });
    // Ninguna hija hereda `settlement.read` por colgar del padre: las que la
    // tienen la declaran.
    expect(MODULE_CAPABILITY.employment).toBe('settlement.read');
  });

  it('quien pertenece a dos casas mira la de la URL, no la primera', () => {
    const roble = { id: 'roble', name: 'Casa Roble', subtitle: 'Tu hogar' };
    const olivo = { id: 'olivo', name: 'Casa Olivo', subtitle: 'Tu hogar' };
    const dosCasas = [roble, olivo];

    expect(pickHousehold(dosCasas, 'olivo')).toBe(olivo);
    expect(pickHousehold(dosCasas, 'roble')).toBe(roble);
    // Sin membresía en esa casa no se devuelve ninguna: el layout falla con 404
    // en vez de enseñar el nombre de otra.
    expect(pickHousehold(dosCasas, 'ajena')).toBeNull();
    // Demo por fixtures: no hay lista que consultar y el respaldo entra después.
    expect(pickHousehold(undefined, 'roble')).toBeNull();
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

  it('finanzas exige el doble cerrojo en el módulo y en cada ruta hija', () => {
    expect(MODULE_CAPABILITY.finanzas).toBe('finance.access');
    for (const child of ['analitica', 'movimientos', 'revision', 'eventos', 'importar', 'ajustes']) {
      expect(guardForPath(`/h/casa-roble/finanzas/${child}`)).toEqual({
        householdId: 'casa-roble',
        module: 'finanzas',
        capability: 'finance.access',
        known: true
      });
    }
    // Fail-closed: una hija sin declarar no hereda nada.
    expect(guardForPath('/h/casa-roble/finanzas/otra')).toMatchObject({ known: false, capability: null });
    // La capacidad solo existe en la matriz para la administración.
    expect(can('family_admin', 'finance.access')).toBe(true);
    expect(can('family_member', 'finance.access')).toBe(false);
    expect(can('helper', 'finance.access')).toBe(false);
  });
});
