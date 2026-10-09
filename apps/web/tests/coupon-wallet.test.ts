import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandEnvelopeV1 } from '@housekeeper/contracts';

import { UploadAttachmentError } from '../src/lib/attachments/upload';
import {
  PHOTO_OFFLINE_MESSAGE,
  photoChangeHold,
  photoPreview,
  photoUploadProblem
} from '../src/lib/coupons/photo';
import type { CouponView } from '../src/lib/coupons/types';
import { effectiveCoupons } from '../src/lib/coupons/view';
import { CouponWallet } from '../src/lib/coupons/wallet.svelte';
import type { QueueCommandResult } from '../src/lib/offline/queue-command';
import { FIXTURE_HOUSEHOLD } from './helpers';

const TODAY = '2026-10-03';

function coupon(overrides: Partial<CouponView> = {}): CouponView {
  return {
    id: 'ca000000-0000-4000-8000-000000000001',
    merchant: 'Frutería Lola',
    offer: '2 × 1 en naranjas',
    code: 'NARANJA',
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

/** Cartera con la cola sustituida: cada comando responde lo que diga `outcome`. */
function wallet(outcome: () => QueueCommandResult = () => ({ outcome: 'synced', message: 'Guardado ✓' })) {
  const sent: CommandEnvelopeV1[] = [];
  const invalidated: string[] = [];
  const instance = new CouponWallet(FIXTURE_HOUSEHOLD, {
    queueCommandFn: (async (envelope: CommandEnvelopeV1) => {
      sent.push(envelope);
      return outcome();
    }) as never,
    invalidateFn: async (token: string) => {
      invalidated.push(token);
    },
    listOutboxFn: (async () => []) as never,
    today: () => TODAY
  });
  return { instance, sent, invalidated };
}

describe('la cartera: usar, deshacer, anular, descartar y recuperar', () => {
  it('«Usar» apunta el uso con la fecha de hoy y deja «Deshacer» a mano', async () => {
    const { instance, sent, invalidated } = wallet();
    const base = coupon();
    const done = instance.use(base, 'Marta');
    // Pintado ANTES del acuse: el cupón de un solo uso ya está en «Usados».
    expect(effectiveCoupons([base], instance.overlay, TODAY)[0]?.bucket).toBe('used');
    await done;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ action: 'use', couponId: base.id, usedOn: TODAY });
    expect(invalidated).toEqual(['cc:coupons']);
    expect(instance.useNote).toMatchObject({ tone: 'success', undo: true });
    expect(instance.useNote?.text).toContain('Uso apuntado ✓');
    expect(instance.useNote?.text).toContain('Frutería Lola');
  });

  it('«Deshacer» anula EXACTAMENTE el uso que se acaba de apuntar', async () => {
    const { instance, sent } = wallet(() => ({ outcome: 'queued', message: 'Guardado en este dispositivo' }));
    await instance.use(coupon(), 'Marta');
    expect(instance.useNote).toMatchObject({ tone: 'pending', undo: true });
    await instance.undoLastUse();
    expect(sent[1]?.payload).toEqual({
      action: 'void_use',
      couponId: coupon().id,
      useId: (sent[0]?.payload as { useId: string }).useId
    });
    expect(instance.useNote?.undo).toBe(false);
    // Lo apuntado y lo anulado se compensan: el cupón vuelve a estar disponible.
    expect(effectiveCoupons([coupon()], instance.overlay, TODAY)[0]).toMatchObject({ bucket: 'available', liveUses: 0 });
  });

  it('anular desde la ficha el uso recién apuntado retira su «Deshacer»', async () => {
    const { instance, sent } = wallet();
    const base = coupon({ maxUses: 5, remaining: 5 });
    await instance.use(base, 'Marta');
    const useId = (sent[0]?.payload as { useId: string }).useId;
    await instance.voidUse(base, useId);
    expect(instance.useNote).toBeNull();
    await instance.undoLastUse();
    // «Deshacer» ya no manda un segundo void_use del mismo uso.
    expect(sent.map((envelope) => (envelope.payload as { action: string }).action)).toEqual(['use', 'void_use']);
  });

  it('el uso encolado sin red cambia su aviso cuando por fin llega', async () => {
    const { instance } = wallet(() => ({ outcome: 'queued', message: 'Guardado en este dispositivo' }));
    const stop = instance.start();
    await instance.use(coupon(), 'Marta');
    expect(instance.useNote).toMatchObject({ tone: 'pending', undo: true });
    // Vuelve la red y un envío posterior lo confirma: ya no está en la bandeja.
    await (instance as unknown as { useActions: { reconcile(): Promise<void> } }).useActions.reconcile();
    expect(instance.useNote).toMatchObject({ tone: 'success', undo: true });
    expect(instance.useNote?.text).toBe('Uso apuntado ✓ · Frutería Lola');
    stop();
  });

  it('un doble toque no apunta dos usos', async () => {
    const { instance, sent } = wallet();
    const base = coupon({ maxUses: 5, remaining: 5 });
    await Promise.all([instance.use(base, 'Marta'), instance.use(base, 'Marta')]);
    expect(sent).toHaveLength(1);
  });

  it('si el servidor rechaza el uso, se deshace en pantalla y se dice por qué', async () => {
    const { instance } = wallet(() => ({ outcome: 'rejected', message: 'No se pudo guardar', errorCode: 'coupon_not_found' }));
    await instance.use(coupon(), 'Marta');
    expect(effectiveCoupons([coupon()], instance.overlay, TODAY)[0]?.bucket).toBe('available');
    expect(instance.useNote).toMatchObject({ tone: 'error', undo: false });
    expect(instance.useNote?.text).toMatch(/ya no está en la cartera/);
  });

  it('anular un uso desde la ficha, descartar y recuperar', async () => {
    const { instance, sent } = wallet(() => ({ outcome: 'queued', message: 'Guardado en este dispositivo' }));
    const used = coupon({ liveUses: 1, remaining: 0, bucket: 'used', uses: [{ id: 'u1', usedOn: TODAY, usedByName: 'Marta' }] });
    await instance.voidUse(used, 'u1');
    expect(sent[0]?.payload).toEqual({ action: 'void_use', couponId: used.id, useId: 'u1' });
    expect(effectiveCoupons([used], instance.overlay, TODAY)[0]?.bucket).toBe('available');

    await instance.discard(used);
    expect(sent[1]?.payload).toEqual({ action: 'discard', couponId: used.id });
    expect(effectiveCoupons([used], instance.overlay, TODAY)[0]?.bucket).toBe('discarded');

    await instance.restore(used);
    expect(sent[2]?.payload).toEqual({ action: 'restore', couponId: used.id });
    expect(effectiveCoupons([used], instance.overlay, TODAY)[0]?.bucket).toBe('available');
  });

  it('el alta aparece al instante con su vista previa; la edición, también', async () => {
    const { instance, sent } = wallet(() => ({ outcome: 'queued', message: 'Guardado en este dispositivo' }));
    const fields = { merchant: 'Bazar', offer: '5 €', code: null, expiresOn: '2026-10-04', maxUses: null, notes: null };
    await instance.create(fields, { storageObjectId: 'ca100000-0000-4000-8000-000000000001', previewUrl: 'data:image/jpeg;base64,AAAA' }, 'Marta');
    const created = sent[0]?.payload as { couponId: string };
    const shown = effectiveCoupons([], instance.overlay, TODAY);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ id: created.couponId, merchant: 'Bazar', bucket: 'available', expiresSoon: true, photoUrl: 'data:image/jpeg;base64,AAAA' });

    const base = coupon();
    await instance.update(base, { ...fields, merchant: 'Bazar Norte' }, { storageObjectId: 'ca100000-0000-4000-8000-000000000002', previewUrl: 'data:image/jpeg;base64,BBBB' });
    expect(sent[1]?.payload).toMatchObject({ action: 'update', couponId: base.id, merchant: 'Bazar Norte', photoStorageObjectId: 'ca100000-0000-4000-8000-000000000002' });
    expect(effectiveCoupons([base], instance.overlay, TODAY).find((shownCoupon) => shownCoupon.id === base.id)).toMatchObject({
      merchant: 'Bazar Norte',
      photoUrl: 'data:image/jpeg;base64,BBBB'
    });
  });

  it('sin red, el aviso dice «dispositivo», como el resto de la casa', async () => {
    const { instance } = wallet(() => ({ outcome: 'queued', message: 'Guardado en este dispositivo' }));
    await instance.use(coupon(), 'Marta');
    expect(instance.useNote?.text).toBe(
      'Uso apuntado en este dispositivo · Frutería Lola. Se enviará al recuperar la conexión.'
    );
  });

  it('guardar un cupón nuevo o editado dice qué se guardó (eco de la acción)', async () => {
    const { instance } = wallet();
    const fields = { merchant: 'Bazar', offer: '5 €', code: null, expiresOn: null, maxUses: 1, notes: null };
    await instance.create(fields, { storageObjectId: 'ca100000-0000-4000-8000-000000000001', previewUrl: null }, 'Marta');
    expect(get(instance.actions.status)).toEqual({ tone: 'success', text: 'Cupón guardado ✓ · Bazar' });
    await instance.update(coupon(), { ...fields, merchant: 'Bazar Norte' }, null);
    expect(get(instance.actions.status)).toEqual({ tone: 'success', text: 'Cambios guardados ✓ · Bazar Norte' });
  });

  it('sin red, el alta sigue diciendo la verdad: guardada en el dispositivo', async () => {
    const { instance } = wallet(() => ({ outcome: 'queued', message: 'Guardado en este dispositivo; se enviará al recuperar la conexión.' }));
    const fields = { merchant: 'Bazar', offer: '5 €', code: null, expiresOn: null, maxUses: 1, notes: null };
    await instance.create(fields, { storageObjectId: 'ca100000-0000-4000-8000-000000000001', previewUrl: null }, 'Marta');
    expect(get(instance.actions.status)).toMatchObject({ tone: 'pending' });
    expect(get(instance.actions.status)?.text).toContain('en este dispositivo');
  });

  it('las acciones de la ficha avisan por su propio canal, no por el de «Usar»', async () => {
    const { instance } = wallet();
    await instance.discard(coupon());
    expect(get(instance.actions.status)).toMatchObject({ tone: 'success' });
    expect(instance.useNote).toBeNull();
  });

  it('anular, descartar y recuperar dicen lo que hicieron, no un «Guardado ✓» genérico', async () => {
    // El verbo no cambia por el camino (sistema móvil §2.5, P2-9): el botón
    // «Sí, anular» acaba en «Uso anulado ✓», no en «Guardado ✓».
    const { instance } = wallet();
    const used = coupon({ liveUses: 1, remaining: 0, bucket: 'used', uses: [{ id: 'u1', usedOn: TODAY, usedByName: 'Marta' }] });
    await instance.voidUse(used, 'u1');
    expect(get(instance.actions.status)).toEqual({ tone: 'success', text: 'Uso anulado ✓ · Frutería Lola' });
    await instance.discard(used);
    expect(get(instance.actions.status)).toEqual({ tone: 'success', text: 'Cupón descartado ✓ · Frutería Lola' });
    await instance.restore(used);
    expect(get(instance.actions.status)).toEqual({ tone: 'success', text: 'Cupón recuperado ✓ · Frutería Lola' });
  });

  it('sin red, anular o descartar siguen diciendo «en este dispositivo»', async () => {
    const { instance } = wallet(() => ({ outcome: 'queued', message: 'Guardado en este dispositivo' }));
    await instance.discard(coupon());
    expect(get(instance.actions.status)).toEqual({ tone: 'pending', text: 'Guardado en este dispositivo' });
  });

  it('el aviso de «Usar» sabe de qué cupón habla (para nombrarlo y para devolver el foco)', async () => {
    const { instance } = wallet();
    const base = coupon();
    await instance.use(base, 'Marta');
    expect(instance.useNote).toMatchObject({ couponId: base.id, merchant: 'Frutería Lola', undo: true });
    await instance.undoLastUse();
    expect(instance.useNote).toMatchObject({ couponId: base.id, merchant: 'Frutería Lola', undo: false });
  });
});

describe('los avisos de un cupón no se quedan pegados a otro', () => {
  const other = coupon({ id: 'ca000000-0000-4000-8000-000000000002', merchant: 'Panadería' });

  it('al abrir otro cupón se retiran los avisos de éxito que no son suyos', async () => {
    const { instance } = wallet();
    const base = coupon({ maxUses: 5, remaining: 5 });
    await instance.use(base, 'Marta');
    await instance.discard(other);
    // En la ficha del mismo cupón, su «Deshacer» sigue; el «descartado» de
    // otro, no.
    instance.retireNotes(base.id);
    expect(instance.useNote).toMatchObject({ couponId: base.id, undo: true });
    expect(get(instance.actions.status)).toBeNull();
    // En la ficha de otro cupón, tampoco el «Uso apuntado» de este.
    instance.retireNotes(other.id);
    expect(instance.useNote).toBeNull();
  });

  it('al cerrar la ficha se retiran todos los de éxito', async () => {
    const { instance } = wallet();
    const base = coupon({ maxUses: 5, remaining: 5 });
    await instance.use(base, 'Marta');
    instance.retireNotes(null);
    expect(instance.useNote).toBeNull();
  });

  it('un error no se retira solo: se queda hasta que se cierra', async () => {
    const { instance } = wallet(() => ({ outcome: 'rejected', message: 'No se pudo guardar', errorCode: 'coupon_not_found' }));
    await instance.use(coupon(), 'Marta');
    await instance.discard(other);
    instance.retireNotes(null);
    expect(instance.useNote).toMatchObject({ tone: 'error' });
    expect(get(instance.actions.status)).toMatchObject({ tone: 'error' });
    instance.dismissUseNote();
    instance.actions.dismiss();
    expect(instance.useNote).toBeNull();
    expect(get(instance.actions.status)).toBeNull();
  });
});

describe('cuando la foto no se puede guardar', () => {
  it('sin red: se puede volver a intentar en cuanto vuelva', () => {
    expect(photoUploadProblem(new UploadAttachmentError('attachment_upload_failed'), true)).toEqual({
      message: PHOTO_OFFLINE_MESSAGE,
      retry: true
    });
  });

  it('un fallo pasajero ofrece «Volver a intentarlo»', () => {
    for (const code of ['attachment_upload_failed', 'attachments_unavailable'] as const) {
      expect(photoUploadProblem(new UploadAttachmentError(code), false)).toMatchObject({ retry: true });
    }
    expect(photoUploadProblem(new Error('lo que sea'), false)).toEqual({
      message: 'No se pudo guardar la foto. Vuelve a intentarlo.',
      retry: true
    });
  });

  it('lo que reintentar no arregla NO ofrece reintentar', () => {
    for (const code of ['attachment_too_large', 'attachment_type_not_allowed', 'attachment_infected', 'attachment_duplicate'] as const) {
      const problem = photoUploadProblem(new UploadAttachmentError(code), false);
      expect(problem.retry, code).toBe(false);
    }
  });

  it('la foto repetida dice qué hacer ahora', () => {
    expect(photoUploadProblem(new UploadAttachmentError('attachment_duplicate'), false).message).toBe(
      'Ese fichero ya lo subió alguien de la casa. Mira si ya está en la cartera o hazle otra foto.'
    );
  });
});

describe('editar con un cambio de foto a medias', () => {
  it('sin cambio de foto, o con la nueva ya guardada, se guarda sin más', () => {
    expect(photoChangeHold(false, 'failed')).toBeNull();
    expect(photoChangeHold(true, 'empty')).toBeNull();
    expect(photoChangeHold(true, 'ready')).toBeNull();
  });

  it('mientras se prepara o se sube, se espera', () => {
    expect(photoChangeHold(true, 'preparing')).toBe('busy');
    expect(photoChangeHold(true, 'uploading')).toBe('busy');
  });

  it('si la foto nueva falló, NO se guarda como si hubiera cambiado', () => {
    // Antes se mandaba la edición sin foto y la ficha decía «Guardado ✓» con
    // la foto vieja, aunque la persona había pedido cambiarla.
    expect(photoChangeHold(true, 'failed')).toBe('failed');
  });
});

describe('vista previa sin `blob:`', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => undefined }),
        toDataURL: (type: string) => `data:${type};base64,VISTA`
      })
    });
    decodedWith = [];
    vi.stubGlobal('createImageBitmap', async (_file: Blob, options?: unknown) => {
      decodedWith.push(options);
      return { width: 2000, height: 1000, close: () => undefined };
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  let decodedWith: unknown[] = [];

  it('se dibuja en un lienzo y sale como `data:`', async () => {
    expect(await photoPreview(new Blob([new Uint8Array(10)], { type: 'image/jpeg' }))).toBe('data:image/jpeg;base64,VISTA');
  });

  it('respeta la orientación de la foto, como el redibujado que se sube', async () => {
    // Si un día la vista previa se dibuja desde el original, una foto vertical
    // del móvil no puede salir tumbada.
    await photoPreview(new Blob([new Uint8Array(10)], { type: 'image/jpeg' }));
    expect(decodedWith).toEqual([{ imageOrientation: 'from-image' }]);
  });

  it('si el navegador no sabe dibujarla, no hay vista previa (y no pasa nada)', async () => {
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('no');
    });
    expect(await photoPreview(new Blob([new Uint8Array(10)]))).toBeNull();
  });
});
