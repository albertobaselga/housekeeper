import { get } from 'svelte/store';

import { OptimisticActions, type OptimisticActionsOptions } from '$lib/offline/optimistic';
import type { QueueOutcome } from '$lib/offline/queue-command';

import {
  createCoupon,
  discardCoupon,
  restoreCoupon,
  updateCoupon,
  useCoupon,
  voidCouponUse,
  type CouponFieldsInput
} from './commands';
import type { CouponView } from './types';
import { emptyOverlay, madridToday, type CouponOverlay } from './view';

/**
 * La cartera de cupones de UNA pantalla: lo que se ha hecho en ella y todavía
 * no ha vuelto en los datos frescos, y las acciones que lo producen. La página
 * y la ficha comparten una sola instancia.
 *
 * Todo pasa por la bandeja de salida (`OptimisticActions`): se pinta al
 * instante, se reconcilia con el acuse veraz y se deshace si el servidor dice
 * que no. Usar, anular, descartar y recuperar funcionan sin red (D-offline);
 * el alta también se encola, pero solo llega aquí con la foto ya subida.
 *
 * Hay DOS canales de aviso. «Usar» tiene el suyo (`useNote`), porque su acuse
 * lleva un «Deshacer» y dura más que un «Guardado ✓»; el resto avisa por
 * `actions.status`, que pinta el `ActionStatus` de siempre.
 */

/** Rechazos de cupones dichos para ESTA pantalla (el diccionario compartido es más genérico). */
export const COUPON_MESSAGES: Readonly<Record<string, string>> = {
  coupon_not_found: 'Ese cupón ya no está en la cartera. Vuelve a abrir la lista.',
  coupon_use_not_found: 'Ese uso ya no estaba apuntado.',
  coupon_photo_invalid: 'La foto no se ha podido unir al cupón. Vuelve a elegirla.'
};

/** El tiempo que un toque de «Usar» bloquea el siguiente en el mismo cupón. */
const DOUBLE_TAP_MS = 800;

export interface UseNote {
  tone: 'success' | 'pending' | 'error';
  text: string;
  /** Hay un uso que «Deshacer». */
  undo: boolean;
  /** El cupón del que habla: nombra el «Deshacer» y dice adónde vuelve el foco. */
  couponId: string;
  merchant: string;
  /** Lo que dirá el aviso pendiente cuando un envío posterior lo confirme. */
  settledText?: string;
}

interface LastUse {
  couponId: string;
  useId: string;
  merchant: string;
}

export interface CouponPhotoChange {
  storageObjectId: string;
  /** Vista previa en `data:`, o null si el navegador no supo dibujarla. */
  previewUrl: string | null;
}

export interface CouponWalletOptions
  extends Partial<Pick<OptimisticActionsOptions, 'queueCommandFn' | 'invalidateFn' | 'listOutboxFn'>> {
  /** «Hoy» de los usos; por defecto, el de Madrid en este momento. */
  today?: () => string;
}

export class CouponWallet {
  overlay = $state<CouponOverlay>(emptyOverlay());
  /** Guardia de doble toque de «Usar», por cupón. */
  using = $state<Record<string, true>>({});
  useNote = $state<UseNote | null>(null);

  /** Lo de la ficha y el alta: su aviso lo pinta `ActionStatus`. */
  readonly actions: OptimisticActions;
  /** Solo «Usar» y «Deshacer»: su aviso es `useNote`. */
  private readonly useActions: OptimisticActions;
  private lastUse: LastUse | null = null;
  private readonly today: () => string;

  constructor(
    private readonly householdId: string,
    options: CouponWalletOptions = {}
  ) {
    const { today, ...deps } = options;
    this.today = today ?? (() => madridToday());
    this.actions = new OptimisticActions({ householdId, invalidateToken: 'cc:coupons', ...deps });
    this.useActions = new OptimisticActions({ householdId, invalidateToken: 'cc:coupons', ...deps });
  }

  /**
   * Reconciliación diferida de lo que quedó en cola. Cuando vuelve la red, el
   * aviso pendiente pasa a decir que llegó; si el servidor lo rechaza, lo dice
   * (y su «Deshacer» desaparece).
   */
  start(): () => void {
    const stopActions = this.actions.start();
    const stopUses = this.useActions.start();
    const stopFeedback = this.useActions.status.subscribe((feedback) => {
      const current = this.useNote;
      if (feedback?.tone === 'error') {
        // El rechazo llega diferido: habla del cupón del aviso que había, si lo había.
        this.useNote = {
          tone: 'error',
          text: feedback.text,
          undo: false,
          couponId: current?.couponId ?? '',
          merchant: current?.merchant ?? ''
        };
      } else if (feedback?.tone === 'success' && current?.tone === 'pending' && current.settledText) {
        this.useNote = { ...current, tone: 'success', text: current.settledText, settledText: undefined };
      }
    });
    return () => {
      stopActions();
      stopUses();
      stopFeedback();
    };
  }

  dismissUseNote(): void {
    this.useNote = null;
  }

  /**
   * Retira los avisos de éxito (y de «pendiente») que ya no vienen a cuento:
   * al cerrar la ficha (`null`) o al abrir otro cupón (su id). Sin esto, la
   * ficha de la panadería pintaba «Uso anulado ✓ · Droguería Sol» (revisión
   * UX, ronda 2, m8). El «Deshacer» del cupón que se mira se queda: es suyo.
   * Los errores no se retiran solos: se cierran con su botón o con la próxima
   * acción, para que nadie se pierda un rechazo.
   */
  retireNotes(keepCouponId: string | null): void {
    if (get(this.actions.status)?.tone !== 'error') this.actions.dismiss();
    const note = this.useNote;
    if (note && note.tone !== 'error' && note.couponId !== keepCouponId) this.useNote = null;
  }

  async use(coupon: CouponView, usedByName: string): Promise<void> {
    if (this.using[coupon.id]) return;
    this.using[coupon.id] = true;
    const envelope = useCoupon({ householdId: this.householdId, couponId: coupon.id, usedOn: this.today() });
    const entry = { id: envelope.payload.useId, usedOn: envelope.payload.usedOn, usedByName };
    const forget = () => {
      const remaining = (this.overlay.addedUses[coupon.id] ?? []).filter((use) => use.id !== entry.id);
      if (remaining.length > 0) this.overlay.addedUses[coupon.id] = remaining;
      else delete this.overlay.addedUses[coupon.id];
    };
    try {
      const outcome = await this.useActions.run(envelope, {
        apply: () => {
          this.overlay.addedUses[coupon.id] = [entry, ...(this.overlay.addedUses[coupon.id] ?? [])];
          this.lastUse = { couponId: coupon.id, useId: entry.id, merchant: coupon.merchant };
          this.useNote = {
            tone: 'success',
            text: `Uso apuntado ✓ · ${coupon.merchant}`,
            undo: true,
            couponId: coupon.id,
            merchant: coupon.merchant
          };
        },
        revert: () => {
          forget();
          if (this.lastUse?.useId === entry.id) this.lastUse = null;
        },
        settle: forget,
        messageOverrides: COUPON_MESSAGES
      });
      this.noteFor(outcome, coupon, {
        success: `Uso apuntado ✓ · ${coupon.merchant}`,
        pending: `Uso apuntado en este dispositivo · ${coupon.merchant}. Se enviará al recuperar la conexión.`,
        undo: this.lastUse?.useId === entry.id
      });
    } finally {
      setTimeout(() => delete this.using[coupon.id], DOUBLE_TAP_MS);
    }
  }

  /** «Deshacer» del aviso: anula exactamente el último uso apuntado aquí. */
  async undoLastUse(): Promise<void> {
    const last = this.lastUse;
    if (!last) return;
    this.lastUse = null;
    const outcome = await this.runVoid(this.useActions, last.couponId, last.useId);
    this.noteFor(outcome, { id: last.couponId, merchant: last.merchant }, {
      success: `Uso anulado ✓ · ${last.merchant}`,
      pending: `Uso anulado en este dispositivo · ${last.merchant}. Se enviará al recuperar la conexión.`,
      undo: false
    });
  }

  /** «Anular este uso» de la ficha. */
  async voidUse(coupon: CouponView, useId: string): Promise<QueueOutcome> {
    // Si es el uso recién apuntado, su «Deshacer» ya no tiene nada que deshacer.
    if (this.lastUse?.useId === useId) {
      this.lastUse = null;
      this.useNote = null;
    }
    const outcome = await this.runVoid(this.actions, coupon.id, useId);
    this.echo(outcome, `Uso anulado ✓ · ${coupon.merchant}`);
    return outcome;
  }

  async discard(coupon: CouponView): Promise<QueueOutcome> {
    const outcome = await this.setDiscarded(coupon, true);
    this.echo(outcome, `Cupón descartado ✓ · ${coupon.merchant}`);
    return outcome;
  }

  async restore(coupon: CouponView): Promise<QueueOutcome> {
    const outcome = await this.setDiscarded(coupon, false);
    this.echo(outcome, `Cupón recuperado ✓ · ${coupon.merchant}`);
    return outcome;
  }

  /** Alta con la foto ya subida: el cupón aparece al instante en «Disponibles». */
  async create(fields: CouponFieldsInput, photo: CouponPhotoChange, createdByName: string): Promise<QueueOutcome> {
    const envelope = createCoupon({
      ...fields,
      householdId: this.householdId,
      photoStorageObjectId: photo.storageObjectId
    });
    const { payload } = envelope;
    const draft: CouponView = {
      id: payload.couponId,
      merchant: payload.merchant,
      offer: payload.offer,
      code: payload.code,
      expiresOn: payload.expiresOn,
      maxUses: payload.maxUses,
      liveUses: 0,
      remaining: payload.maxUses,
      notes: payload.notes,
      // El cubo y «caduca pronto» los recalcula `effectiveCoupons` con el dominio.
      bucket: 'available',
      expiresSoon: false,
      discardedAt: null,
      createdAt: envelope.occurredAt,
      createdByName,
      photoUrl: photo.previewUrl ?? '',
      uses: []
    };
    const forget = () => {
      this.overlay.created = this.overlay.created.filter((candidate) => candidate.id !== draft.id);
    };
    const outcome = await this.actions.run(
      envelope,
      {
        apply: () => {
          this.overlay.created = [draft, ...this.overlay.created];
        },
        revert: forget,
        settle: forget,
        messageOverrides: COUPON_MESSAGES
      }
    );
    this.echo(outcome, `Cupón guardado ✓ · ${payload.merchant}`);
    return outcome;
  }

  /** Edición: sustitución completa de los campos y, si se cambió, la foto. */
  async update(coupon: CouponView, fields: CouponFieldsInput, photo: CouponPhotoChange | null): Promise<QueueOutcome> {
    const envelope = updateCoupon({
      ...fields,
      householdId: this.householdId,
      couponId: coupon.id,
      ...(photo ? { photoStorageObjectId: photo.storageObjectId } : {})
    });
    const { payload } = envelope;
    const forget = () => {
      delete this.overlay.edited[coupon.id];
      delete this.overlay.photos[coupon.id];
    };
    const outcome = await this.actions.run(envelope, {
      apply: () => {
        this.overlay.edited[coupon.id] = {
          merchant: payload.merchant,
          offer: payload.offer,
          code: payload.code,
          expiresOn: payload.expiresOn,
          maxUses: payload.maxUses,
          notes: payload.notes
        };
        if (photo?.previewUrl) this.overlay.photos[coupon.id] = photo.previewUrl;
      },
      revert: forget,
      settle: forget,
      messageOverrides: COUPON_MESSAGES
    });
    this.echo(outcome, `Cambios guardados ✓ · ${payload.merchant}`);
    return outcome;
  }

  /**
   * El acuse dice QUÉ se hizo y con el mismo verbo del botón (sistema móvil
   * §2.5, P2-9): con dos cupones de la misma tienda, un «Guardado ✓» a secas
   * no confirma cuál, y «Sí, anular» no puede acabar en «Guardado». Solo con
   * el acuse del servidor; sin red, el «guardado en este dispositivo» de
   * siempre sigue siendo la verdad, y un rechazo trae su propio motivo.
   */
  private echo(outcome: QueueOutcome, text: string): void {
    if (outcome === 'synced') this.actions.status.set({ tone: 'success', text });
  }

  private async runVoid(channel: OptimisticActions, couponId: string, useId: string): Promise<QueueOutcome> {
    const forget = () => {
      delete this.overlay.voidedUses[useId];
    };
    return await channel.run(voidCouponUse({ householdId: this.householdId, couponId, useId }), {
      apply: () => {
        this.overlay.voidedUses[useId] = true;
      },
      revert: forget,
      settle: () => {
        forget();
        // Si el uso anulado era uno apuntado aquí, ya no hay nada que superponer.
        const remaining = (this.overlay.addedUses[couponId] ?? []).filter((use) => use.id !== useId);
        if (remaining.length > 0) this.overlay.addedUses[couponId] = remaining;
        else delete this.overlay.addedUses[couponId];
      },
      messageOverrides: COUPON_MESSAGES
    });
  }

  private async setDiscarded(coupon: CouponView, discarded: boolean): Promise<QueueOutcome> {
    const envelope = discarded
      ? discardCoupon({ householdId: this.householdId, couponId: coupon.id })
      : restoreCoupon({ householdId: this.householdId, couponId: coupon.id });
    const forget = () => {
      delete this.overlay.discarded[coupon.id];
    };
    return await this.actions.run(envelope, {
      apply: () => {
        this.overlay.discarded[coupon.id] = discarded;
      },
      revert: forget,
      settle: forget,
      messageOverrides: COUPON_MESSAGES
    });
  }

  private noteFor(
    outcome: QueueOutcome,
    coupon: { id: string; merchant: string },
    texts: { success: string; pending: string; undo: boolean }
  ): void {
    const about = { couponId: coupon.id, merchant: coupon.merchant };
    if (outcome === 'synced') {
      this.useNote = { tone: 'success', text: texts.success, undo: texts.undo, ...about };
    } else if (outcome === 'queued') {
      this.useNote = { tone: 'pending', text: texts.pending, undo: texts.undo, settledText: texts.success, ...about };
    } else {
      const feedback = get(this.useActions.status);
      this.useNote = { tone: 'error', text: feedback?.text ?? 'No se pudo guardar el cambio.', undo: false, ...about };
    }
  }
}
