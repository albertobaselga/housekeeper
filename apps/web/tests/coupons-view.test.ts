import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkCouponDraft,
  draftFromCoupon,
  emptyCouponDraft,
  expiryInWords,
  COUPON_DATE_MAX,
  COUPON_DATE_MIN
} from '../src/lib/coupons/draft';
import type { CouponView } from '../src/lib/coupons/types';
import {
  bucketFromParam,
  countByBucket,
  effectiveCoupons,
  elsewhereHint,
  emptyOverlay,
  expiryLabel,
  headerTitle,
  madridToday,
  matchesQuery,
  merchantsFrom,
  paramForBucket,
  rowDetail,
  shortDate,
  useLine,
  usesLabel,
  visibleCoupons
} from '../src/lib/coupons/view';

const TODAY = '2026-10-03'; // sábado

function coupon(overrides: Partial<CouponView> = {}): CouponView {
  return {
    id: 'ca000000-0000-4000-8000-000000000001',
    merchant: 'Frutería Lola',
    offer: '2 × 1 en naranjas',
    code: null,
    expiresOn: null,
    maxUses: 1,
    liveUses: 0,
    remaining: 1,
    notes: null,
    bucket: 'available',
    expiresSoon: false,
    discardedAt: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    createdByName: 'Marta',
    photoUrl: '/api/v1/households/h/coupons/c/photo',
    uses: [],
    ...overrides
  };
}

describe('fechas y textos en palabras, nunca en ISO', () => {
  it('fecha corta con el día de la semana; el año solo si no es el de hoy', () => {
    expect(shortDate('2026-10-10', TODAY)).toBe('sáb 10 oct');
    expect(shortDate('2026-10-09', TODAY)).toBe('vie 9 oct');
    expect(shortDate('2026-09-01', TODAY)).toBe('mar 1 sept');
    expect(shortDate('2027-01-04', TODAY)).toBe('lun 4 ene 2027');
  });

  it('caducidad', () => {
    expect(expiryLabel(null, TODAY)).toBe('Sin caducidad');
    expect(expiryLabel('2026-10-03', TODAY)).toBe('Caduca hoy');
    expect(expiryLabel('2026-10-04', TODAY)).toBe('Caduca mañana');
    expect(expiryLabel('2026-10-09', TODAY)).toBe('Caduca el vie 9 oct');
    expect(expiryLabel('2026-09-29', TODAY)).toBe('Caducó el mar 29 sept');
  });

  it('la marca de usos, con el plural resuelto', () => {
    expect(usesLabel({ maxUses: 1, liveUses: 0 })).toBe('Un solo uso');
    expect(usesLabel({ maxUses: 1, liveUses: 1 })).toBe('Un solo uso · usado');
    expect(usesLabel({ maxUses: 5, liveUses: 0 })).toBe('Quedan 5 usos');
    expect(usesLabel({ maxUses: 5, liveUses: 2 })).toBe('2 de 5 usados · quedan 3');
    expect(usesLabel({ maxUses: 5, liveUses: 4 })).toBe('4 de 5 usados · queda 1');
    expect(usesLabel({ maxUses: 5, liveUses: 5 })).toBe('5 de 5 usados');
    // Nada impide apuntar de más (D-usos): se cuenta la verdad.
    expect(usesLabel({ maxUses: 2, liveUses: 3 })).toBe('3 de 2 usados');
    expect(usesLabel({ maxUses: null, liveUses: 0 })).toBe('Sin límite de usos');
    expect(usesLabel({ maxUses: null, liveUses: 1 })).toBe('Sin límite · usado 1 vez');
    expect(usesLabel({ maxUses: null, liveUses: 4 })).toBe('Sin límite · usado 4 veces');
  });

  it('la línea de apoyo de la fila', () => {
    expect(rowDetail(coupon({ expiresOn: '2026-10-09', maxUses: 5, liveUses: 2 }), TODAY)).toBe(
      'Caduca el vie 9 oct · 2 de 5 usados · quedan 3'
    );
    expect(rowDetail(coupon({ bucket: 'discarded', discardedAt: '2026-09-30T22:30:00Z' }), TODAY)).toBe(
      // Las 22:30 UTC del 30 ya son las 00:30 del 1 de octubre en Madrid.
      'Descartado el jue 1 oct · Un solo uso'
    );
  });

  it('detrás de «Caduca pronto», la línea sigue la frase en vez de repetir «Caduca»', () => {
    // La fila pinta el chip y, detrás, esta línea: «Caduca pronto el lun 5
    // oct», y no «Caduca prontoCaduca el lun 5 oct» (revisión UX, ronda 2, m6).
    const soon = (expiresOn: string) => coupon({ expiresOn, expiresSoon: true });
    expect(rowDetail(soon('2026-10-05'), TODAY)).toBe('el lun 5 oct · Un solo uso');
    expect(rowDetail(soon(TODAY), TODAY)).toBe('hoy · Un solo uso');
    expect(rowDetail(soon('2026-10-04'), TODAY)).toBe('mañana · Un solo uso');
  });

  it('en «Usados», la fila dice cuándo se usó: es por lo que ese filtro ordena', () => {
    const usedOnce = coupon({
      expiresOn: '2026-12-02',
      bucket: 'used',
      liveUses: 1,
      remaining: 0,
      uses: [{ id: 'u1', usedOn: '2026-10-01', usedByName: 'Marta' }]
    });
    expect(rowDetail(usedOnce, TODAY)).toBe('Usado el jue 1 oct · Un solo uso');
    const usedUp = coupon({
      bucket: 'used',
      maxUses: 2,
      liveUses: 2,
      remaining: 0,
      uses: [
        { id: 'u2', usedOn: '2026-10-02', usedByName: 'Marta' },
        { id: 'u1', usedOn: '2026-09-20', usedByName: 'Alberto' }
      ]
    });
    expect(rowDetail(usedUp, TODAY)).toBe('Usado el vie 2 oct · 2 de 2 usados');
  });

  it('cada uso dice cuándo y quién', () => {
    expect(useLine({ id: 'u', usedOn: '2026-10-06', usedByName: 'Marta' }, TODAY)).toBe('Usado el mar 6 oct por Marta');
  });

  it('el título dice el estado', () => {
    expect(headerTitle(0)).toBe('Cupones · 0 disponibles');
    expect(headerTitle(1)).toBe('Cupones · 1 disponible');
    expect(headerTitle(7)).toBe('Cupones · 7 disponibles');
  });

  it('hoy es el de Madrid, no el del reloj UTC', () => {
    // 23:30 UTC del 3 de octubre ya es día 4 en Madrid (UTC+2 en horario de verano).
    expect(madridToday(new Date('2026-10-03T23:30:00Z'))).toBe('2026-10-04');
    expect(madridToday(new Date('2026-10-03T21:30:00Z'))).toBe('2026-10-03');
  });

  describe('hoy no depende del patrón corto de fecha del navegador', () => {
    afterEach(() => vi.restoreAllMocks());

    it('aunque `format()` de en-CA cambie de patrón, sale YYYY-MM-DD', () => {
      // Ya pasó con una versión de ICU en Chrome: en-CA dejó de dar y-MM-dd.
      // «Usar» mandaría entonces un usedOn que el contrato rechaza.
      // `format` es un getter que devuelve la función ya ligada.
      const prototype = Intl.DateTimeFormat.prototype as unknown as { format: unknown };
      vi.spyOn(prototype, 'format', 'get').mockReturnValue(() => '10/4/2026');
      expect(madridToday(new Date('2026-10-03T23:30:00Z'))).toBe('2026-10-04');
    });
  });
});

describe('lo buscado está en otro filtro', () => {
  it('un filtro, en singular; varios, en plural', () => {
    expect(elsewhereHint([])).toBeNull();
    expect(elsewhereHint(['used'])).toBe('Sí hay en «Usados»: está en su filtro, arriba.');
    expect(elsewhereHint(['used', 'expired'])).toBe('Sí hay en «Usados» y «Caducados»: están en sus filtros, arriba.');
    expect(elsewhereHint(['used', 'expired', 'discarded'])).toBe(
      'Sí hay en «Usados», «Caducados» y «Descartados»: están en sus filtros, arriba.'
    );
  });
});

describe('filtros en la URL', () => {
  it('?ver= en castellano, disponibles por defecto', () => {
    expect(bucketFromParam(null)).toBe('available');
    expect(bucketFromParam('usados')).toBe('used');
    expect(bucketFromParam('caducados')).toBe('expired');
    expect(bucketFromParam('descartados')).toBe('discarded');
    expect(bucketFromParam('cualquier-cosa')).toBe('available');
    expect(paramForBucket('expired')).toBe('caducados');
  });
});

describe('búsqueda local', () => {
  it('por comercio, oferta, código y notas, sin acentos ni mayúsculas', () => {
    const c = coupon({ merchant: 'Panadería Ñandú', offer: 'Café gratis', code: 'CAFE-26', notes: 'Solo por la mañana' });
    expect(matchesQuery(c, '')).toBe(true);
    expect(matchesQuery(c, 'panaderia')).toBe(true);
    expect(matchesQuery(c, 'ÑANDU')).toBe(true);
    expect(matchesQuery(c, 'cafe gratis')).toBe(true);
    expect(matchesQuery(c, 'cafe-26')).toBe(true);
    expect(matchesQuery(c, 'manana')).toBe(true);
    expect(matchesQuery(c, 'farmacia')).toBe(false);
  });
});

describe('el estado optimista recalcula el cubo con el dominio', () => {
  it('usar un cupón de un solo uso lo pasa a «Usados» al instante', () => {
    const base = coupon();
    const overlay = emptyOverlay();
    overlay.addedUses[base.id] = [{ id: 'u1', usedOn: TODAY, usedByName: 'Tú' }];
    const [after] = effectiveCoupons([base], overlay, TODAY);
    expect(after).toMatchObject({ liveUses: 1, remaining: 0, bucket: 'used' });
    expect(after?.uses.map((use) => use.id)).toEqual(['u1']);
  });

  it('el uso ya confirmado no se cuenta dos veces mientras llega el acuse', () => {
    const use = { id: 'u1', usedOn: TODAY, usedByName: 'Marta' };
    const base = coupon({ maxUses: 5, liveUses: 1, remaining: 4, uses: [use] });
    const overlay = emptyOverlay();
    overlay.addedUses[base.id] = [{ ...use, usedByName: 'Tú' }];
    expect(effectiveCoupons([base], overlay, TODAY)[0]).toMatchObject({ liveUses: 1, remaining: 4 });
  });

  it('anular un uso lo quita y devuelve el cupón a disponibles', () => {
    const use = { id: 'u1', usedOn: '2026-10-01', usedByName: 'Marta' };
    const base = coupon({ liveUses: 1, remaining: 0, bucket: 'used', uses: [use] });
    const overlay = emptyOverlay();
    overlay.voidedUses.u1 = true;
    expect(effectiveCoupons([base], overlay, TODAY)[0]).toMatchObject({ liveUses: 0, remaining: 1, bucket: 'available', uses: [] });
  });

  it('descartar y recuperar', () => {
    const base = coupon();
    const overlay = emptyOverlay();
    overlay.discarded[base.id] = true;
    const discarded = effectiveCoupons([base], overlay, TODAY)[0];
    expect(discarded?.bucket).toBe('discarded');
    expect(discarded?.discardedAt).not.toBeNull();
    overlay.discarded[base.id] = false;
    const restored = effectiveCoupons([{ ...base, bucket: 'discarded', discardedAt: '2026-10-01T10:00:00Z' }], overlay, TODAY)[0];
    expect(restored).toMatchObject({ bucket: 'available', discardedAt: null });
  });

  it('editar la caducidad mueve el cupón de cubo y enciende «caduca pronto»', () => {
    const base = coupon({ expiresOn: '2026-09-01', bucket: 'expired' });
    const overlay = emptyOverlay();
    overlay.edited[base.id] = { merchant: 'Frutería Lola', offer: 'Otra oferta', code: 'X', expiresOn: '2026-10-05', maxUses: 1, notes: null };
    expect(effectiveCoupons([base], overlay, TODAY)[0]).toMatchObject({
      offer: 'Otra oferta',
      code: 'X',
      bucket: 'available',
      expiresSoon: true
    });
  });

  it('un alta propia aparece hasta que los datos frescos la traen', () => {
    const created = coupon({ id: 'nuevo' });
    const overlay = emptyOverlay();
    overlay.created.push(created);
    expect(effectiveCoupons([], overlay, TODAY).map((c) => c.id)).toEqual(['nuevo']);
    expect(effectiveCoupons([coupon({ id: 'nuevo', merchant: 'De la base' })], overlay, TODAY).map((c) => c.merchant)).toEqual([
      'De la base'
    ]);
  });
});

describe('lista por filtro y recuentos', () => {
  const list = [
    coupon({ id: 'a', merchant: 'Zapatería', expiresOn: null }),
    coupon({ id: 'b', merchant: 'Bazar', expiresOn: '2026-10-20' }),
    coupon({ id: 'c', merchant: 'Ahorro', expiresOn: '2026-10-05', expiresSoon: true }),
    coupon({ id: 'd', merchant: 'Droguería', bucket: 'used', liveUses: 1, uses: [{ id: 'u', usedOn: '2026-10-01', usedByName: 'Marta' }] }),
    coupon({ id: 'e', merchant: 'Óptica', bucket: 'expired', expiresOn: '2026-09-01' }),
    coupon({ id: 'f', merchant: 'Kiosco', bucket: 'expired', expiresOn: '2026-09-20' }),
    coupon({ id: 'g', merchant: 'Librería', bucket: 'discarded', discardedAt: '2026-10-01T10:00:00Z' })
  ];

  it('cuenta por cubo', () => {
    expect(countByBucket(list)).toEqual({ available: 3, used: 1, expired: 2, discarded: 1 });
  });

  it('disponibles: lo que caduca antes, primero; sin caducidad, al final', () => {
    expect(visibleCoupons(list, 'available', '').map((c) => c.id)).toEqual(['c', 'b', 'a']);
  });

  it('caducados: lo más reciente primero', () => {
    expect(visibleCoupons(list, 'expired', '').map((c) => c.id)).toEqual(['f', 'e']);
  });

  it('la búsqueda filtra dentro del filtro', () => {
    expect(visibleCoupons(list, 'available', 'bazar').map((c) => c.id)).toEqual(['b']);
    expect(visibleCoupons(list, 'used', 'bazar')).toEqual([]);
  });

  it('comercios para el datalist: sin repetir, sin distinguir mayúsculas, en orden', () => {
    expect(merchantsFrom([coupon({ merchant: 'Bazar' }), coupon({ merchant: 'bazar ' }), coupon({ merchant: 'Ahorro' })])).toEqual([
      'Ahorro',
      'Bazar'
    ]);
  });
});

describe('el borrador del formulario (el enganche de la fase 2)', () => {
  it('vacío: un solo uso por defecto', () => {
    expect(emptyCouponDraft()).toEqual({
      merchant: '',
      offer: '',
      code: '',
      expiresOn: '',
      usesMode: 'single',
      usesCount: '',
      notes: ''
    });
  });

  it('desde un cupón, para editar', () => {
    expect(draftFromCoupon(coupon({ maxUses: 5, code: 'X', expiresOn: '2026-10-09', notes: 'n' }))).toMatchObject({
      usesMode: 'multiple',
      usesCount: '5',
      code: 'X',
      expiresOn: '2026-10-09',
      notes: 'n'
    });
    expect(draftFromCoupon(coupon({ maxUses: null })).usesMode).toBe('unlimited');
    expect(draftFromCoupon(coupon({ maxUses: 1 })).usesMode).toBe('single');
  });

  it('valida lo que la base rechazaría, con frases llanas', () => {
    const ok = { ...emptyCouponDraft(), merchant: ' Bazar ', offer: ' 5 € ' };
    expect(checkCouponDraft(ok)).toEqual({
      ok: true,
      fields: { merchant: 'Bazar', offer: '5 €', code: null, expiresOn: null, maxUses: 1, notes: null }
    });
    expect(checkCouponDraft({ ...ok, merchant: '  ' })).toMatchObject({ ok: false, field: 'merchant' });
    expect(checkCouponDraft({ ...ok, offer: '' })).toMatchObject({ ok: false, field: 'offer' });
    expect(checkCouponDraft({ ...ok, merchant: 'x'.repeat(121) })).toMatchObject({ ok: false, field: 'merchant' });
    expect(checkCouponDraft({ ...ok, code: 'x'.repeat(121) })).toMatchObject({ ok: false, field: 'code' });
    expect(checkCouponDraft({ ...ok, notes: 'x'.repeat(1001) })).toMatchObject({ ok: false, field: 'notes' });
    expect(checkCouponDraft({ ...ok, usesMode: 'unlimited' })).toMatchObject({ ok: true, fields: { maxUses: null } });
    expect(checkCouponDraft({ ...ok, usesMode: 'multiple', usesCount: '5' })).toMatchObject({ ok: true, fields: { maxUses: 5 } });
    for (const usesCount of ['', '1', '1000', '2,5', 'tres']) {
      expect(checkCouponDraft({ ...ok, usesMode: 'multiple', usesCount }), usesCount).toMatchObject({ ok: false, field: 'usesCount' });
    }
  });

  it('la caducidad elegida se repite en palabras: el campo nativo puede pintar mm/dd', () => {
    expect(expiryInWords('', TODAY)).toBeNull();
    expect(expiryInWords('2026-11-02', TODAY)).toBe('Caduca el lun 2 nov');
    expect(expiryInWords('2026-10-04', TODAY)).toBe('Caduca mañana');
    expect(expiryInWords('2027-01-04', TODAY)).toBe('Caduca el lun 4 ene 2027');
    // Lo que el formulario rechazaría no se dice en palabras: ya lo dirá el error.
    expect(expiryInWords('0026-11-02', TODAY)).toBeNull();
    expect(expiryInWords('2026-02-30', TODAY)).toBeNull();
  });

  it('la caducidad entre 2000 y 2999, como el contrato', () => {
    const ok = { ...emptyCouponDraft(), merchant: 'Bazar', offer: '5 €' };
    expect(COUPON_DATE_MIN).toBe('2000-01-01');
    expect(COUPON_DATE_MAX).toBe('2999-12-31');
    expect(checkCouponDraft({ ...ok, expiresOn: '2026-10-31' })).toMatchObject({ ok: true, fields: { expiresOn: '2026-10-31' } });
    for (const expiresOn of ['0026-10-31', '1999-12-31', '3000-01-01', '2026-02-30', 'mañana']) {
      expect(checkCouponDraft({ ...ok, expiresOn }), expiresOn).toMatchObject({ ok: false, field: 'expiresOn' });
    }
  });
});
