import { describe, expect, it } from 'vitest';

// La validación zod de los payloads congelados vive AQUÍ, en el test: el
// código de `$lib/contacts/commands.ts` que llega al navegador no importa zod.
import {
  commandEnvelopeSchema,
  contactArchivePayloadSchema,
  contactCommandPayloadSchema,
  contactUpsertPayloadSchema
} from '@casa-clara/contracts/schemas';

import { archiveContact, upsertContact } from '../src/lib/contacts/commands';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const CONTACT = '51000000-0000-4000-8000-000000000001';
const OPTIONS = {
  operationId: '99999999-0000-4000-8000-000000000021',
  occurredAt: '2026-08-07T10:00:00.000Z'
};

describe('constructores de envelopes de contactos', () => {
  it('upsertContact (alta) valida contra el contrato y recorta los campos', () => {
    const envelope = upsertContact(
      {
        householdId: HOUSEHOLD,
        name: '  Centro Pediátrico Olmo ',
        roleLabel: ' Pediatría ',
        phone: ' 910 000 111 ',
        kind: 'health',
        featured: true,
        notes: '  Preguntar por consulta 3 '
      },
      OPTIONS
    );

    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('contact');
    expect(envelope.aggregateId).toBeNull();
    expect(contactCommandPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'upsert',
      name: 'Centro Pediátrico Olmo',
      roleLabel: 'Pediatría',
      phone: '910 000 111',
      kind: 'health',
      featured: true,
      notes: 'Preguntar por consulta 3'
    });
  });

  it('upsertContact (edición) lleva contactId y omite opcionales vacíos', () => {
    const envelope = upsertContact(
      {
        householdId: HOUSEHOLD,
        contactId: CONTACT,
        name: 'Carmen · 2.º B',
        roleLabel: '   ',
        phone: '600 000 344',
        kind: 'home',
        featured: false,
        notes: ''
      },
      OPTIONS
    );

    expect(envelope.aggregateId).toBe(CONTACT);
    const payload = contactUpsertPayloadSchema.parse(envelope.payload);
    expect(payload.contactId).toBe(CONTACT);
    expect(payload).not.toHaveProperty('roleLabel');
    expect(payload).not.toHaveProperty('notes');
  });

  it('el teléfono sale del constructor con el patrón del CHECK de la tabla', () => {
    const envelope = upsertContact(
      { householdId: HOUSEHOLD, name: 'Test', phone: 'no-es-telefono', kind: 'otros', featured: false },
      OPTIONS
    );
    // El constructor no valida (eso es del servidor/test): zod lo rechaza.
    expect(contactCommandPayloadSchema.safeParse(envelope.payload).success).toBe(false);

    const valid = upsertContact(
      { householdId: HOUSEHOLD, name: 'Test', phone: '+34 910 000 111', kind: 'otros', featured: false },
      OPTIONS
    );
    expect(contactCommandPayloadSchema.safeParse(valid.payload).success).toBe(true);
  });

  it('archiveContact valida contra el contrato', () => {
    const envelope = archiveContact({ householdId: HOUSEHOLD, contactId: CONTACT }, OPTIONS);
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('contact');
    expect(envelope.aggregateId).toBe(CONTACT);
    expect(contactArchivePayloadSchema.parse(envelope.payload)).toEqual({
      action: 'archive',
      contactId: CONTACT
    });
  });
});
