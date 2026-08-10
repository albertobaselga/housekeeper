import { describe, expect, it } from 'vitest';

import {
  DATABASE_VAR,
  DURABILITY_VARS,
  IDENTITY_VARS,
  checkDeploymentConfig,
  missingDurabilityVars
} from '../src/lib/server/deployment-config.js';

/**
 * La regla indivisible. Estas pruebas fijan las tres promesas del expediente:
 *
 * 1. Sin base de datos no se exige nada (el desarrollo local y las suites de
 *    maqueta arrancan igual que antes).
 * 2. Con base de datos, base e identidad entran juntas o no entra ninguna.
 * 3. El mensaje dice EXACTAMENTE qué falta, porque es una instrucción para
 *    quien va a arreglarlo desde el panel de variables.
 */

/** Configuración completa y coherente de un hogar real. */
const REAL: Record<string, string> = {
  DATABASE_URL: 'postgresql://app@db.example.supabase.co:6543/postgres',
  DATABASE_AUTH_URL: 'postgresql://auth@db.example.supabase.co:6543/postgres',
  BETTER_AUTH_SECRET: 'x'.repeat(48),
  BETTER_AUTH_URL: 'https://www.example.test'
};

function check(env: Record<string, string | undefined>, fixtureLogin = false) {
  return checkDeploymentConfig({ env, fixtureLogin });
}

describe('sin base de datos, la regla duerme', () => {
  it('no exige nada cuando no hay DATABASE_URL: es el modo local sin base', () => {
    expect(check({}).ok).toBe(true);
  });

  it('tampoco la despierta el paquete con selector, que es como corren las maquetas', () => {
    expect(check({}, true).ok).toBe(true);
  });

  it('una DATABASE_URL vacía o en blanco cuenta como ausente, no como presente a medias', () => {
    expect(check({ DATABASE_URL: '' }).ok).toBe(true);
    expect(check({ DATABASE_URL: '   ' }).ok).toBe(true);
  });

  it('no exige la identidad por el mero hecho de que sobre alguna de sus variables', () => {
    // Media identidad sin base tampoco es peligrosa: no hay nada real detrás.
    expect(check({ BETTER_AUTH_SECRET: 'x'.repeat(48) }).ok).toBe(true);
  });
});

describe('con base de datos, base e identidad son indivisibles', () => {
  it('acepta la configuración completa', () => {
    expect(check(REAL)).toEqual({ ok: true, problem: null });
  });

  it.each(IDENTITY_VARS)('rechaza el despliegue si falta %s', (missing) => {
    const result = check({ ...REAL, [missing]: undefined });
    expect(result.ok).toBe(false);
    expect(result.problem?.code).toBe('incomplete-identity');
    expect(result.problem?.missing).toEqual([missing]);
    // El mensaje nombra la variable: es la instrucción para el panel.
    expect(result.problem?.message).toContain(missing);
  });

  it('es exactamente el escenario letal del expediente: base real, identidad ausente', () => {
    // DATABASE_URL de la casa real + DATABASE_AUTH_URL ausente era la
    // combinación que dejaba vivo el selector de cuentas sintéticas sobre
    // datos reales bajo RLS. Ahora el despliegue se niega a servir.
    const result = check({ DATABASE_URL: REAL.DATABASE_URL });
    expect(result.ok).toBe(false);
    expect(result.problem?.code).toBe('incomplete-identity');
    expect(result.problem?.missing).toEqual([...IDENTITY_VARS]);
  });

  it('enumera TODAS las que faltan, no sólo la primera', () => {
    const result = check({
      DATABASE_URL: REAL.DATABASE_URL,
      BETTER_AUTH_URL: REAL.BETTER_AUTH_URL
    });
    expect(result.problem?.missing).toEqual(['DATABASE_AUTH_URL', 'BETTER_AUTH_SECRET']);
    for (const name of ['DATABASE_AUTH_URL', 'BETTER_AUTH_SECRET']) {
      expect(result.problem?.message).toContain(name);
    }
  });

  it('el mensaje ofrece las dos salidas: completar la identidad o retirar la base', () => {
    const message = check({ DATABASE_URL: REAL.DATABASE_URL }).problem?.message ?? '';
    expect(message).toContain(DATABASE_VAR);
    expect(message).toMatch(/retira/i);
  });

  it('una variable en blanco no cuenta como definida', () => {
    const result = check({ ...REAL, BETTER_AUTH_SECRET: '   ' });
    expect(result.problem?.missing).toEqual(['BETTER_AUTH_SECRET']);
  });
});

describe('la dirección de identidad tiene que poder llevar cookies de sesión', () => {
  it('rechaza http contra un dominio que no es local', () => {
    const result = check({ ...REAL, BETTER_AUTH_URL: 'http://www.example.test' });
    expect(result.ok).toBe(false);
    expect(result.problem?.code).toBe('insecure-auth-url');
  });

  it('rechaza un valor que ni siquiera es una dirección', () => {
    expect(check({ ...REAL, BETTER_AUTH_URL: 'www.example.test' }).problem?.code).toBe(
      'insecure-auth-url'
    );
  });

  it('admite http en local, que es como arranca la demo y las suites', () => {
    for (const base of ['http://localhost:3000', 'http://127.0.0.1:4317']) {
      expect(check({ ...REAL, BETTER_AUTH_URL: base }).ok, base).toBe(true);
    }
  });
});

describe('el paquete con selector dentro no puede ser el de producción', () => {
  it('se niega a servir como producción de Vercel', () => {
    const result = check({ VERCEL: '1', VERCEL_ENV: 'production' }, true);
    expect(result.ok).toBe(false);
    expect(result.problem?.code).toBe('fixture-bundle-in-production');
  });

  it('se niega en cualquier despliegue de Vercel si además hay base de datos', () => {
    // Selector de cuentas de mentira sobre datos de verdad, en una URL pública:
    // la vista previa es tan pública como producción.
    const result = check({ VERCEL: '1', VERCEL_ENV: 'preview', ...REAL }, true);
    expect(result.ok).toBe(false);
    expect(result.problem?.code).toBe('fixture-bundle-with-database');
  });

  it('sí lo admite fuera de la plataforma, que es donde vive la batería e2e con base', () => {
    // playwright.db.config.ts construye exactamente así, y a propósito.
    expect(check({ DATABASE_URL: REAL.DATABASE_URL }, true).ok).toBe(true);
  });

  it('una vista previa de maqueta sin base sigue siendo legítima', () => {
    expect(check({ VERCEL: '1', VERCEL_ENV: 'preview' }, true).ok).toBe(true);
  });
});

describe('ALLOW_SYNTHETIC_DATA_ONLY como cerrojo, no como cartel', () => {
  it('declararse solo-sintético y ser producción son incompatibles, y gana la negativa', () => {
    const result = check({ ...REAL, ALLOW_SYNTHETIC_DATA_ONLY: 'true', VERCEL_ENV: 'production' });
    expect(result.ok).toBe(false);
    expect(result.problem?.code).toBe('synthetic-flag-in-production');
    expect(result.problem?.message).toContain('ALLOW_SYNTHETIC_DATA_ONLY');
  });

  it('la contradicción se comprueba antes que ninguna otra cosa', () => {
    // Con la identidad además incompleta, el motivo que se enseña es el cartel
    // mentiroso: es el que explica por qué este despliegue no debería existir.
    const result = check({
      DATABASE_URL: REAL.DATABASE_URL,
      ALLOW_SYNTHETIC_DATA_ONLY: 'true',
      VERCEL_ENV: 'production'
    });
    expect(result.problem?.code).toBe('synthetic-flag-in-production');
  });

  it('no estorba en staging ni en CI, que es donde la variable tiene sentido', () => {
    // infra/compose.staging.yml: solo-sintético con identidad completa y sin
    // VERCEL_ENV. Tiene que arrancar.
    expect(check({ ...REAL, ALLOW_SYNTHETIC_DATA_ONLY: 'true' }).ok).toBe(true);
    expect(check({ ALLOW_SYNTHETIC_DATA_ONLY: 'true' }, true).ok).toBe(true);
  });

  it('sólo el literal "true" declara nada; cualquier otra cosa no es una declaración', () => {
    for (const value of ['TRUE', '1', 'false', 'sí']) {
      expect(check({ ...REAL, ALLOW_SYNTHETIC_DATA_ONLY: value, VERCEL_ENV: 'production' }).ok, value).toBe(
        true
      );
    }
  });
});

describe('durabilidad: se avisa, no se tumba', () => {
  it('reclama la clave de firma sólo cuando hay base de datos', () => {
    expect(missingDurabilityVars({})).toEqual([]);
    expect(missingDurabilityVars(REAL)).toEqual([...DURABILITY_VARS]);
  });

  it('su ausencia NO impide arrancar: rompe snapshots, no la identidad', () => {
    expect(check(REAL).ok).toBe(true);
  });

  it('calla cuando está puesta', () => {
    expect(missingDurabilityVars({ ...REAL, SNAPSHOT_SIGNING_KEY_B64: 'AAAA' })).toEqual([]);
  });
});
