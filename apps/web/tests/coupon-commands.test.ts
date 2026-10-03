import { describe, expect, it } from 'vitest';

import type { CommandEnvelopeV1 } from '@housekeeper/contracts';

// La validación zod de los payloads vive AQUÍ, en el test: el código de
// `lib/coupons/commands.ts` que llega al navegador no importa zod jamás.
import { commandEnvelopeSchema, couponCommandPayloadSchema } from '@housekeeper/contracts/schemas';

import {
  createCoupon,
  discardCoupon,
  restoreCoupon,
  updateCoupon,
  useCoupon,
  voidCouponUse
} from '../src/lib/coupons/commands';
import { FIXTURE_HOUSEHOLD } from './helpers';

const COUPON = 'ca000000-0000-4000-8000-000000000001';
const PHOTO = 'ca100000-0000-4000-8000-000000000001';
const USE = 'ca200000-0000-4000-8000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const options = { operationId: '99999999-0000-4000-8000-000000000001', occurredAt: '2026-10-03T10:00:00.000Z' };

/** Sobre válido para el contrato Y payload válido para el esquema de cupones. */
function expectValid(envelope: CommandEnvelopeV1<unknown>): void {
  expect(commandEnvelopeSchema.safeParse(envelope).success).toBe(true);
  const parsed = couponCommandPayloadSchema.safeParse(envelope.payload);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  expect(envelope.aggregateType).toBe('coupon');
}

describe('constructores de comandos de cupones', () => {
  it('create: recorta el texto, vacío → null y genera el id del cupón en el cliente', () => {
    const envelope = createCoupon(
      {
        householdId: FIXTURE_HOUSEHOLD,
        merchant: '  Frutería Lola ',
        offer: ' 2 × 1 en naranjas  ',
        code: '   ',
        expiresOn: '',
        maxUses: 1,
        notes: '  ',
        photoStorageObjectId: PHOTO
      },
      options
    );
    expectValid(envelope);
    expect(envelope.payload).toEqual({
      action: 'create',
      couponId: envelope.payload.couponId,
      merchant: 'Frutería Lola',
      offer: '2 × 1 en naranjas',
      code: null,
      expiresOn: null,
      maxUses: 1,
      notes: null,
      photoStorageObjectId: PHOTO
    });
    expect(envelope.payload.couponId).toMatch(UUID);
    // El agregado es el cupón: el outbox los agrupa por él.
    expect(envelope.aggregateId).toBe(envelope.payload.couponId);
    expect(envelope.operationId).toBe(options.operationId);
  });

  it('create: dos altas seguidas no comparten id; uno dado se respeta', () => {
    const base = {
      householdId: FIXTURE_HOUSEHOLD,
      merchant: 'Droguería',
      offer: '10 % de descuento',
      code: 'AHORRA10',
      expiresOn: '2026-10-31',
      maxUses: null,
      notes: 'Solo en la tienda del centro',
      photoStorageObjectId: PHOTO
    };
    const first = createCoupon(base);
    const second = createCoupon(base);
    expect(first.payload.couponId).not.toBe(second.payload.couponId);
    expect(createCoupon({ ...base, couponId: COUPON }).payload.couponId).toBe(COUPON);
    expectValid(first);
    expect(first.payload).toMatchObject({ code: 'AHORRA10', expiresOn: '2026-10-31', maxUses: null });
  });

  it('update: sustitución completa, sin foto nueva no manda la clave', () => {
    const envelope = updateCoupon(
      {
        householdId: FIXTURE_HOUSEHOLD,
        couponId: COUPON,
        merchant: 'Droguería',
        offer: '15 % de descuento',
        code: ' X1 ',
        expiresOn: '2026-11-30',
        maxUses: 5,
        notes: ''
      },
      options
    );
    expectValid(envelope);
    expect(envelope.payload).toEqual({
      action: 'update',
      couponId: COUPON,
      merchant: 'Droguería',
      offer: '15 % de descuento',
      code: 'X1',
      expiresOn: '2026-11-30',
      maxUses: 5,
      notes: null
    });
    // Ni siquiera con `undefined`: el servidor pregunta `!== undefined`, pero
    // lo que no cambia no viaja.
    expect('photoStorageObjectId' in envelope.payload).toBe(false);
  });

  it('update: con foto nueva la manda', () => {
    const envelope = updateCoupon({
      householdId: FIXTURE_HOUSEHOLD,
      couponId: COUPON,
      merchant: 'Droguería',
      offer: '15 % de descuento',
      code: null,
      expiresOn: null,
      maxUses: null,
      notes: null,
      photoStorageObjectId: PHOTO
    });
    expectValid(envelope);
    expect(envelope.payload).toMatchObject({ photoStorageObjectId: PHOTO });
  });

  it('use: id del uso del cliente y fecha local; «Deshacer» anula ESE uso', () => {
    const use = useCoupon({ householdId: FIXTURE_HOUSEHOLD, couponId: COUPON, usedOn: '2026-10-03' }, options);
    expectValid(use);
    expect(use.payload).toEqual({ action: 'use', couponId: COUPON, useId: use.payload.useId, usedOn: '2026-10-03' });
    expect(use.payload.useId).toMatch(UUID);
    expect(use.aggregateId).toBe(COUPON);

    const undo = voidCouponUse({ householdId: FIXTURE_HOUSEHOLD, couponId: COUPON, useId: use.payload.useId });
    expectValid(undo);
    expect(undo.payload).toEqual({ action: 'void_use', couponId: COUPON, useId: use.payload.useId });
    expect(useCoupon({ householdId: FIXTURE_HOUSEHOLD, couponId: COUPON, usedOn: '2026-10-03', useId: USE }).payload.useId).toBe(USE);
  });

  it('discard y restore', () => {
    const discard = discardCoupon({ householdId: FIXTURE_HOUSEHOLD, couponId: COUPON });
    const restore = restoreCoupon({ householdId: FIXTURE_HOUSEHOLD, couponId: COUPON });
    expectValid(discard);
    expectValid(restore);
    expect(discard.payload).toEqual({ action: 'discard', couponId: COUPON });
    expect(restore.payload).toEqual({ action: 'restore', couponId: COUPON });
  });

  it('el constructor no valida: lo que no cumple el contrato lo para el esquema', () => {
    // Un comercio en blanco sale recortado a '' y el contrato lo rechaza: la
    // pantalla lo impide antes (campo obligatorio), y si no, el servidor.
    const blank = createCoupon({
      householdId: FIXTURE_HOUSEHOLD,
      merchant: '   ',
      offer: 'Algo',
      code: null,
      expiresOn: null,
      maxUses: null,
      notes: null,
      photoStorageObjectId: PHOTO
    });
    expect(blank.payload.merchant).toBe('');
    expect(couponCommandPayloadSchema.safeParse(blank.payload).success).toBe(false);
  });
});
