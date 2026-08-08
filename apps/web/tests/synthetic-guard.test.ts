import { describe, expect, it } from 'vitest';

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
