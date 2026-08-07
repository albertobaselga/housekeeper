import { describe, expect, it } from 'vitest';

import { describeErrorCode } from '../src/lib/offline/error-codes';
import { describeErrorCode as describeFromOutbox } from '../src/lib/employment/outbox';

describe('diccionario compartido de códigos de error', () => {
  it('traduce códigos de todos los módulos, no solo empleo', () => {
    // Empleo (histórico)
    expect(describeErrorCode('week_already_reported')).toBe('La semana ya fue enviada');
    expect(describeErrorCode('not_allowed')).toBe('Tu rol no permite esta acción');
    // Genéricos del dispatcher
    expect(describeErrorCode('unsupported_aggregate')).toBe('El servidor no reconoce este tipo de cambio');
    // Wiki
    expect(describeErrorCode('wiki_revision_conflict')).toBe('Alguien guardó otra revisión antes que tú');
    expect(describeErrorCode('slug_taken')).toBe('Ya existe una página con ese nombre');
    // Menú/compra
    expect(describeErrorCode('menu_content_changed')).toBe('El menú cambió mientras confirmabas: revísalo');
    expect(describeErrorCode('allergen_conflict')).toBe('Choca con un alérgeno declarado del hogar');
    // Accesos
    expect(describeErrorCode('already_revoked')).toBe('El acceso ya estaba revocado');
  });

  it('degrada con seguridad: código desconocido crudo, sin código null', () => {
    expect(describeErrorCode('martian_error')).toBe('martian_error');
    expect(describeErrorCode(undefined)).toBeNull();
    expect(describeErrorCode('')).toBeNull();
  });

  it('el reexport histórico de lib/employment/outbox sigue funcionando', () => {
    expect(describeFromOutbox('settlement_not_open')).toBe('La liquidación ya no está abierta');
    expect(describeFromOutbox).toBe(describeErrorCode);
  });
});
