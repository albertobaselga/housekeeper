import { describe, expect, it } from 'vitest';

import { mergeAccountDraft } from '../src/lib/finance/account-drafts';

interface Account {
  id: string;
  name: string;
  bank: string | null;
  kind: string;
  ownerLabel: string;
  bankRef: string;
  ownerAliases: string[];
  transferRefs: string[];
}

const ACCOUNT: Account = {
  id: 'a1',
  name: 'Cuenta vieja',
  bank: 'Banco',
  kind: 'comun',
  ownerLabel: 'Ana',
  bankRef: '00001234',
  ownerAliases: [],
  transferRefs: []
};

describe(
  'mergeAccountDraft: Important 1, revisión ronda 1 de Task 13 — dos ediciones seguidas de ' +
    'la misma fila con la cola offline no se pisan',
  () => {
    it('sin borrador previo, el parche se aplica tal cual sobre la foto del servidor', () => {
      expect(mergeAccountDraft(ACCOUNT, undefined, { name: 'Cuenta nueva' })).toEqual({
        ...ACCOUNT,
        name: 'Cuenta nueva'
      });
    });

    it('con un borrador pendiente (primer onblur en cola, sin invalidate), el segundo campo editado no borra el primero', () => {
      // El primer `onblur` (rename) ya viajó y quedó `queued`: la página lo
      // recuerda en `drafts`, pero `account` sigue siendo la fila del server
      // sin el rename.
      const draft: Partial<Account> = { name: 'Cuenta nueva' };
      const next = mergeAccountDraft(ACCOUNT, draft, { ownerLabel: 'Beatriz' });
      expect(next.name).toBe('Cuenta nueva'); // el primer cambio sobrevive
      expect(next.ownerLabel).toBe('Beatriz'); // el segundo también se aplica
      expect(next.bank).toBe(ACCOUNT.bank); // el resto de la foto viaja intacto
    });

    it('un tercer campo editado acumula sobre los dos anteriores', () => {
      const draft: Partial<Account> = { name: 'Cuenta nueva', ownerLabel: 'Beatriz' };
      const next = mergeAccountDraft(ACCOUNT, draft, { ownerAliases: ['Bea'] });
      expect(next.name).toBe('Cuenta nueva');
      expect(next.ownerLabel).toBe('Beatriz');
      expect(next.ownerAliases).toEqual(['Bea']);
    });

    it('si el nuevo parche toca el MISMO campo que el borrador, el parche nuevo gana (es el más reciente)', () => {
      const draft: Partial<Account> = { name: 'Cuenta nueva' };
      const next = mergeAccountDraft(ACCOUNT, draft, { name: 'Cuenta más nueva' });
      expect(next.name).toBe('Cuenta más nueva');
    });
  }
);
