import { describe, expect, it } from 'vitest';

import { readWebHealth, renderWebMetrics } from '../src/lib/server/health.server';

describe('health and privacy-safe metrics', () => {
  it('returns a stable liveness contract without database dependency', () => {
    const health = readWebHealth(Date.parse('2026-08-07T10:00:00.000Z'));
    expect(health.status).toBe('ok');
    expect(health.checkedAt).toBe('2026-08-07T10:00:00.000Z');
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('emits Prometheus metrics without household or user labels', () => {
    const metrics = renderWebMetrics();
    expect(metrics).toContain('casa_clara_web_up 1');
    expect(metrics).not.toMatch(/household|membership|user_id/);
  });
});
