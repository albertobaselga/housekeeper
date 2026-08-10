import { describe, expect, it } from 'vitest';

import { checkDeploymentConfig } from '../src/lib/server/deployment-config.js';
import { SYNTHETIC_BANNER_TEXT, isLocalHostname, syntheticGuard } from '../src/lib/server/synthetic.server';

describe('syntheticGuard (ALLOW_SYNTHETIC_DATA_ONLY)', () => {
  it("solo el literal 'true' declara el entorno solo-sintético", () => {
    expect(syntheticGuard({ ALLOW_SYNTHETIC_DATA_ONLY: 'true' }).syntheticOnly).toBe(true);
    expect(syntheticGuard({ ALLOW_SYNTHETIC_DATA_ONLY: 'TRUE' }).syntheticOnly).toBe(false);
    expect(syntheticGuard({ ALLOW_SYNTHETIC_DATA_ONLY: '1' }).syntheticOnly).toBe(false);
    expect(syntheticGuard({ ALLOW_SYNTHETIC_DATA_ONLY: 'false' }).syntheticOnly).toBe(false);
    expect(syntheticGuard({}).syntheticOnly).toBe(false);
  });

  it('el texto del banner es el aviso exigido por el baseline', () => {
    expect(SYNTHETIC_BANNER_TEXT).toBe('Entorno sintético: no introduzcas datos reales');
  });
});

describe('el cartel dejó de ser sólo un cartel', () => {
  it('la afirmación falsa ahora cuesta el despliegue, no un párrafo', () => {
    // La decisión está razonada en synthetic.server.ts: la variable no puede
    // distinguir un dato real de uno inventado, así que su único cerrojo
    // honesto es hacer cara la afirmación falsa. Declararse solo-sintético y
    // ser producción son incompatibles, y gana la negativa.
    const enProduccion = checkDeploymentConfig({
      env: { ALLOW_SYNTHETIC_DATA_ONLY: 'true', VERCEL_ENV: 'production' },
      fixtureLogin: false
    });
    expect(enProduccion.ok).toBe(false);
    expect(enProduccion.problem?.code).toBe('synthetic-flag-in-production');
  });

  it('y sigue sin estorbar donde la variable tiene sentido', () => {
    // Staging y CI: solo-sintético de verdad, y ninguno es producción de Vercel.
    expect(
      checkDeploymentConfig({ env: { ALLOW_SYNTHETIC_DATA_ONLY: 'true' }, fixtureLogin: false }).ok
    ).toBe(true);
  });
});

describe('isLocalHostname', () => {
  it('reconoce solo los orígenes locales', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      expect(isLocalHostname(host), host).toBe(true);
    }
    for (const host of ['staging.casaclara.test', 'casaclara.example', '192.168.1.10', 'localhost.evil.com']) {
      expect(isLocalHostname(host), host).toBe(false);
    }
  });
});
