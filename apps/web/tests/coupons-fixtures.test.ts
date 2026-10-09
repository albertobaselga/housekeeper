import { describe, expect, it, vi } from 'vitest';

import { getCouponsFixture } from '../src/lib/server/fixtures.server';

// `demoOnly()` consulta `$env/dynamic/private` en cada llamada: sin fijarlo,
// quien tenga DATABASE_URL exportada en su shell vería esto fallar en falso.
vi.mock('$env/dynamic/private', () => ({ env: {} }));

describe('maqueta de cupones (modo demo, sin base)', () => {
  const data = getCouponsFixture('2026-10-03');

  it('cubre los cuatro filtros y deja una lista principal de al menos tres', () => {
    expect(data.today).toBe('2026-10-03');
    expect(data.counts.available).toBeGreaterThanOrEqual(3);
    expect(data.counts.used).toBeGreaterThanOrEqual(1);
    expect(data.counts.expired).toBeGreaterThanOrEqual(1);
    expect(data.counts.discarded).toBeGreaterThanOrEqual(1);
    const total = data.counts.available + data.counts.used + data.counts.expired + data.counts.discarded;
    expect(total).toBe(data.coupons.length);
  });

  it('trae lo que la pantalla tiene que saber pintar', () => {
    // Uno que caduca pronto, uno de varios usos ya empezado y uno sin límite.
    expect(data.coupons.some((coupon) => coupon.expiresSoon)).toBe(true);
    expect(
      data.coupons.some(
        (coupon) => coupon.bucket === 'available' && (coupon.maxUses ?? 0) > 1 && coupon.liveUses > 0 && (coupon.remaining ?? 0) > 0
      )
    ).toBe(true);
    expect(data.coupons.some((coupon) => coupon.bucket === 'available' && coupon.maxUses === null && coupon.liveUses > 0)).toBe(true);
    expect(data.merchants.length).toBeGreaterThan(0);
  });

  it('las fechas siguen al «hoy» que se le da: el filtro no se queda viejo', () => {
    const later = getCouponsFixture('2027-03-15');
    expect(later.counts).toEqual(data.counts);
    expect(later.coupons.find((coupon) => coupon.expiresSoon)?.expiresOn?.startsWith('2027-03')).toBe(true);
  });

  it('las fotos son sintéticas y viajan en `data:`, que la CSP sí admite', () => {
    for (const coupon of data.coupons) expect(coupon.photoUrl).toMatch(/^data:image\/svg\+xml,/);
  });

  it('sin «hoy» válido usa el de Madrid en vez de romper', () => {
    expect(getCouponsFixture('').today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
