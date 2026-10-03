import type {
  CommandEnvelopeV1,
  CouponCreatePayloadV1,
  CouponDiscardPayloadV1,
  CouponRestorePayloadV1,
  CouponUpdatePayloadV1,
  CouponUsePayloadV1,
  CouponVoidUsePayloadV1
} from '@housekeeper/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';

/**
 * Constructores puros de los comandos de cupones (spec de cupones §5 y §8.2).
 * Producen los payloads de `couponCommandPayloadSchema`; la validación zod vive
 * en los tests y en el servidor, nunca en el paquete del navegador. Los tipos
 * son las interfaces de `@housekeeper/contracts`, que solo existen al compilar.
 *
 * Dos reglas que vienen del contrato y se cumplen AQUÍ, en el cliente:
 *
 * · Los identificadores del cupón y de cada uso los genera el cliente. El alta
 *   y el uso son idempotentes por ese id aunque «Reintentar» cambie el
 *   `operationId`, y «Deshacer» anula exactamente el uso que se apuntó.
 * · El texto se recorta y lo que queda vacío viaja como `null`, siempre con su
 *   clave: el `update` es una sustitución completa y una clave ausente no
 *   significa «déjalo como estaba». La foto es la excepción: solo viaja si
 *   cambia.
 */

interface EnvelopeOptions {
  operationId?: string;
  occurredAt?: string;
}

/** Los campos que la persona escribe, tal como salen del formulario. */
export interface CouponFieldsInput {
  merchant: string;
  offer: string;
  code: string | null;
  /** `YYYY-MM-DD` del `<input type="date">`; vacío = no caduca. */
  expiresOn: string | null;
  /** `null` = sin límite. */
  maxUses: number | null;
  notes: string | null;
}

function optionalText(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function normalizedFields(input: CouponFieldsInput) {
  return {
    merchant: input.merchant.trim(),
    offer: input.offer.trim(),
    code: optionalText(input.code),
    expiresOn: optionalText(input.expiresOn),
    maxUses: input.maxUses,
    notes: optionalText(input.notes)
  };
}

function couponEnvelope<TPayload extends { couponId: string }>(
  householdId: string,
  payload: TPayload,
  options: EnvelopeOptions
): CommandEnvelopeV1<TPayload> {
  return createCommandEnvelope({
    ...options,
    householdId,
    aggregateType: 'coupon',
    aggregateId: payload.couponId,
    payload
  }) as CommandEnvelopeV1<TPayload>;
}

export function createCoupon(
  input: CouponFieldsInput & { householdId: string; couponId?: string; photoStorageObjectId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<CouponCreatePayloadV1> {
  return couponEnvelope(
    input.householdId,
    {
      action: 'create',
      couponId: input.couponId ?? crypto.randomUUID(),
      ...normalizedFields(input),
      photoStorageObjectId: input.photoStorageObjectId
    } satisfies CouponCreatePayloadV1,
    options
  );
}

export function updateCoupon(
  input: CouponFieldsInput & { householdId: string; couponId: string; photoStorageObjectId?: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<CouponUpdatePayloadV1> {
  return couponEnvelope(
    input.householdId,
    {
      action: 'update',
      couponId: input.couponId,
      ...normalizedFields(input),
      ...(input.photoStorageObjectId ? { photoStorageObjectId: input.photoStorageObjectId } : {})
    } satisfies CouponUpdatePayloadV1,
    options
  );
}

export function useCoupon(
  input: { householdId: string; couponId: string; usedOn: string; useId?: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<CouponUsePayloadV1> {
  return couponEnvelope(
    input.householdId,
    {
      action: 'use',
      couponId: input.couponId,
      useId: input.useId ?? crypto.randomUUID(),
      usedOn: input.usedOn
    } satisfies CouponUsePayloadV1,
    options
  );
}

export function voidCouponUse(
  input: { householdId: string; couponId: string; useId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<CouponVoidUsePayloadV1> {
  return couponEnvelope(
    input.householdId,
    { action: 'void_use', couponId: input.couponId, useId: input.useId } satisfies CouponVoidUsePayloadV1,
    options
  );
}

export function discardCoupon(
  input: { householdId: string; couponId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<CouponDiscardPayloadV1> {
  return couponEnvelope(
    input.householdId,
    { action: 'discard', couponId: input.couponId } satisfies CouponDiscardPayloadV1,
    options
  );
}

export function restoreCoupon(
  input: { householdId: string; couponId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<CouponRestorePayloadV1> {
  return couponEnvelope(
    input.householdId,
    { action: 'restore', couponId: input.couponId } satisfies CouponRestorePayloadV1,
    options
  );
}
