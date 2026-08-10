import { describe, expect, it } from 'vitest';

import { inspectBuildEnvironment } from '../scripts/check-deployment-config.mjs';

/**
 * El guardián de la build. Su valor está en los tres desenlaces, no en dos:
 * lo incoherente muere, lo vacío avisa y sigue, lo completo calla. Confundir
 * «vacío» con «incoherente» bloquearía el despliegue de arranque, que es
 * justamente el que hay que poder hacer.
 */

const REAL: Record<string, string> = {
  DATABASE_URL: 'postgresql://app@db.example.supabase.co:6543/postgres',
  DATABASE_AUTH_URL: 'postgresql://auth@db.example.supabase.co:6543/postgres',
  BETTER_AUTH_SECRET: 'x'.repeat(48),
  BETTER_AUTH_URL: 'https://www.example.test',
  SNAPSHOT_SIGNING_KEY_B64: 'AAAA'
};

const VERCEL_PRODUCTION = { VERCEL: '1', VERCEL_ENV: 'production' };

describe('lo incoherente muere en la build, que es donde no cuesta el acceso a nadie', () => {
  it('base real con la identidad a medias', () => {
    const verdict = inspectBuildEnvironment({ ...VERCEL_PRODUCTION, DATABASE_URL: REAL.DATABASE_URL });
    expect(verdict.level).toBe('fail');
    expect(verdict.lines.join('\n')).toContain('DATABASE_AUTH_URL');
  });

  it('el selector de cuentas sintéticas metido en una build de producción', () => {
    const verdict = inspectBuildEnvironment({
      ...VERCEL_PRODUCTION,
      ...REAL,
      CASA_CLARA_FIXTURE_LOGIN: 'true'
    });
    expect(verdict.level).toBe('fail');
    expect(verdict.lines.join('\n')).toContain('CASA_CLARA_FIXTURE_LOGIN');
  });

  it('ALLOW_SYNTHETIC_DATA_ONLY en producción, aunque valga "false"', () => {
    // Una variable presente en el panel es una variable que alguien puede
    // voltear un martes por la tarde. La ausencia es el único estado firme.
    for (const value of ['true', 'false', '']) {
      const verdict = inspectBuildEnvironment({
        ...VERCEL_PRODUCTION,
        ...REAL,
        ALLOW_SYNTHETIC_DATA_ONLY: value
      });
      expect(verdict.level, `valor ${JSON.stringify(value)}`).toBe('fail');
      expect(verdict.lines.join('\n')).toContain('ALLOW_SYNTHETIC_DATA_ONLY');
    }
  });

  it('un valor inventado en CASA_CLARA_FIXTURE_LOGIN revienta en vez de adivinar', () => {
    expect(() => inspectBuildEnvironment({ ...REAL, CASA_CLARA_FIXTURE_LOGIN: 'quizá' })).toThrow(
      /CASA_CLARA_FIXTURE_LOGIN/
    );
  });
});

describe('lo vacío avisa, pero deja construir', () => {
  it('sin DATABASE_URL la build sigue: un despliegue de arranque tiene que poder hacerse', () => {
    const verdict = inspectBuildEnvironment({ ...VERCEL_PRODUCTION });
    expect(verdict.level).toBe('warn');
    expect(verdict.lines.join('\n')).toContain('DATABASE_URL');
  });

  it('pero calla en una build de maqueta, donde no tener base es lo normal', () => {
    // Avisar en cada `pnpm build` de las suites sería ruido, y el ruido enseña
    // a no leer los avisos.
    const verdict = inspectBuildEnvironment({ CASA_CLARA_FIXTURE_LOGIN: 'true' });
    expect(verdict.lines.join('\n')).not.toContain('Sin DATABASE_URL');
  });

  it('la clave de firma ausente avisa, no mata', () => {
    const verdict = inspectBuildEnvironment({
      ...VERCEL_PRODUCTION,
      ...REAL,
      SNAPSHOT_SIGNING_KEY_B64: undefined
    });
    expect(verdict.level).toBe('warn');
    expect(verdict.lines.join('\n')).toContain('SNAPSHOT_SIGNING_KEY_B64');
  });
});

describe('lo completo calla', () => {
  it('la configuración de un hogar real pasa en verde', () => {
    const verdict = inspectBuildEnvironment({ ...VERCEL_PRODUCTION, ...REAL });
    expect(verdict.level).toBe('ok');
  });

  it('el modo local sin base pasa en verde: es como corren las suites de maqueta', () => {
    // Ni VERCEL ni base de datos: `pnpm build` de siempre.
    expect(inspectBuildEnvironment({ CASA_CLARA_FIXTURE_LOGIN: 'true' }).level).toBe('ok');
  });

  it('la batería e2e con base de datos, fuera de la plataforma, pasa en verde', () => {
    // playwright.db.config.ts: base real de pruebas + selector pedido a mano.
    const verdict = inspectBuildEnvironment({
      DATABASE_URL: REAL.DATABASE_URL,
      CASA_CLARA_FIXTURE_LOGIN: 'true'
    });
    expect(verdict.level).not.toBe('fail');
  });

  it('staging solo-sintético con identidad completa pasa en verde', () => {
    // infra/compose.staging.yml. No es Vercel, así que la variable es legítima.
    const verdict = inspectBuildEnvironment({ ...REAL, ALLOW_SYNTHETIC_DATA_ONLY: 'true' });
    expect(verdict.level).toBe('ok');
  });
});

describe('el mensaje de la negativa tranquiliza a quien lo lee', () => {
  it('el resumen de una build correcta dice en qué estado quedó', () => {
    const verdict = inspectBuildEnvironment({ ...VERCEL_PRODUCTION, ...REAL });
    expect(verdict.lines.join('\n')).toMatch(/base sí/);
    expect(verdict.lines.join('\n')).toMatch(/selector sintético fuera/);
  });
});
