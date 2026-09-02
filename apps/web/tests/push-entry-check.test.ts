import { describe, expect, it } from 'vitest';

import { afterActivate, entryPushAction } from '../src/lib/push/entry-check';
import type { EnableResult, PushAvailability } from '../src/lib/push/subscribe';

/**
 * La decisión pura de qué hacer con los avisos AL ENTRAR en el hogar. Cada
 * rama por separado: es la máquina que decide entre silencio, auto-reparación
 * y el banner descartable, y una regla mal ordenada aquí se traduce en el
 * diálogo nativo disparándose sin un toque, que es justo lo que el §0.5 no
 * negocia.
 */
describe('qué hacer con los avisos al entrar', () => {
  const available = (permission: 'default' | 'granted'): PushAvailability => ({ kind: 'available', permission });

  it('calla ante lo bloqueado: ya lo explica «Tu cuenta»', () => {
    expect(entryPushAction({ kind: 'blocked' }, false, false)).toBe('none');
    expect(entryPushAction({ kind: 'blocked' }, true, false)).toBe('none');
  });

  it('calla en iOS sin instalar: lo cubre el banner de instalación, no se duplica', () => {
    expect(entryPushAction({ kind: 'needs-home-screen' }, false, false)).toBe('none');
  });

  it('calla si el navegador no sabe hacerlo', () => {
    expect(entryPushAction({ kind: 'unsupported' }, false, false)).toBe('none');
  });

  it('no hace nada con permiso concedido y suscripción viva', () => {
    expect(entryPushAction(available('granted'), true, false)).toBe('none');
  });

  it('repara en silencio con permiso concedido pero sin suscripción viva', () => {
    // El permiso ya está dado: `enablePush` no abre ningún diálogo, así que no
    // hay toque que pedir antes de reparar la fila del servidor.
    expect(entryPushAction(available('granted'), false, false)).toBe('self-heal');
    // Ni descartar el banner cambia esto: es una avería, no un ofrecimiento.
    expect(entryPushAction(available('granted'), false, true)).toBe('self-heal');
  });

  it('ofrece el banner propio con el permiso por decidir', () => {
    expect(entryPushAction(available('default'), false, false)).toBe('offer');
  });

  it('calla si ya se descartó el banner en esta visita', () => {
    expect(entryPushAction(available('default'), false, true)).toBe('none');
  });
});

/**
 * Qué hacer tras pulsar «Activar»: el resultado de `enablePush` ya no se
 * descarta. Cada rama por separado, igual que `entryPushAction`.
 */
describe('qué hacer tras pulsar «Activar»', () => {
  it('listo si funcionó', () => {
    expect(afterActivate({ ok: true } satisfies EnableResult)).toBe('done');
  });

  it('vuelve al ofrecimiento ante un contratiempo del momento (sin red, el servidor falló)', () => {
    expect(afterActivate({ ok: false, reason: 'failed' } satisfies EnableResult)).toBe('retry');
  });

  it('remite a Tu cuenta y calla si el navegador acaba de bloquearlo: no hay reintento posible', () => {
    expect(afterActivate({ ok: false, reason: 'denied' } satisfies EnableResult)).toBe('blocked');
  });
});
