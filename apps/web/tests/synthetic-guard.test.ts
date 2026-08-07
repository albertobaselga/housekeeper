import { describe, expect, it } from 'vitest';

import {
  SYNTHETIC_BANNER_TEXT,
  demoPasswordBlocked,
  isLocalHostname,
  syntheticGuard
} from '../src/lib/server/synthetic.server';

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

describe('demoPasswordBlocked (403 para sesiones demo con contraseña)', () => {
  it('bloquea cuando el flag NO es true y el origen no es localhost', () => {
    expect(demoPasswordBlocked('staging.casaclara.test', {})).toBe(true);
    expect(demoPasswordBlocked('casaclara.example', { ALLOW_SYNTHETIC_DATA_ONLY: 'false' })).toBe(true);
  });

  it('permite el entorno declarado sintético en cualquier origen', () => {
    expect(demoPasswordBlocked('staging.casaclara.test', { ALLOW_SYNTHETIC_DATA_ONLY: 'true' })).toBe(false);
  });

  it('permite localhost aunque el flag no esté', () => {
    expect(demoPasswordBlocked('localhost', {})).toBe(false);
    expect(demoPasswordBlocked('127.0.0.1', {})).toBe(false);
  });
});
