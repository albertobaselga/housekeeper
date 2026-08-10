import { describe, expect, it } from 'vitest';

import { readWebHealth, renderWebMetrics } from '../src/lib/server/health.server';

describe('health and privacy-safe metrics', () => {
  it('returns a stable liveness contract without database dependency', () => {
    const health = readWebHealth(Date.parse('2026-08-07T10:00:00.000Z'));
    expect(health.status).toBe('ok');
    expect(health.checkedAt).toBe('2026-08-07T10:00:00.000Z');
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('publica las dos declaraciones del despliegue para poder auditarlas con un curl', () => {
    // «Comprobar que ALLOW_SYNTHETIC_DATA_ONLY no está definida en producción» y
    // «comprobar que el selector de cuentas sintéticas no está en el paquete»
    // pasan de ser una inspección visual del banner y un grep sobre la función
    // desplegada a ser dos campos de /api/health.
    expect(readWebHealth(Date.now(), true).synthetic).toBe(true);
    expect(readWebHealth(Date.now(), false).synthetic).toBe(false);
    expect(readWebHealth().synthetic).toBe(false);
    expect(readWebHealth().fixtureLogin).toBe(__FIXTURE_LOGIN__);
  });

  it('no filtra nada más que esas dos banderas y la disponibilidad', () => {
    // La salud es pública: ni nombres de variables, ni valores, ni rastro del hogar.
    const serialised = JSON.stringify(readWebHealth());
    expect(serialised).not.toMatch(/DATABASE|SECRET|household|user/i);
  });

  it('emits Prometheus metrics without household or user labels', () => {
    const metrics = renderWebMetrics();
    expect(metrics).toContain('casa_clara_web_up 1');
    expect(metrics).not.toMatch(/household|membership|user_id/);
  });
});
