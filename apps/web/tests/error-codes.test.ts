import { describe, expect, it } from 'vitest';

import { describeErrorCode } from '../src/lib/offline/error-codes';
import { describeErrorCode as describeFromOutbox } from '../src/lib/employment/outbox';

describe('diccionario compartido de códigos de error', () => {
  it('traduce códigos de todos los módulos, no solo empleo', () => {
    // Empleo (histórico)
    expect(describeErrorCode('settlement_not_open')).toBe('La cuenta del mes ya no está abierta');
    expect(describeErrorCode('not_allowed')).toBe('Tu rol no permite esta acción');
    // El parte semanal se retiró (0029): su código murió con él y ya no se
    // traduce. Un móvil que lo recibiera vería la frase llana genérica.
    expect(describeErrorCode('week_already_reported')).toBeNull();
    // Genéricos del dispatcher, incluidos los que emite el propio /api/v1/sync
    // cuando rechaza sin llegar al comando.
    expect(describeErrorCode('unsupported_aggregate')).toBe('La aplicación no reconoce este tipo de cambio');
    expect(describeErrorCode('not_authorized')).toBe('Tu acceso a este hogar no lo permite');
    expect(describeErrorCode('operation_conflict')).toBe('Otro cambio llegó antes con otro contenido');
    expect(describeErrorCode('constraint_violation')).toBe(
      'El cambio no encaja con lo que ya hay guardado'
    );
    expect(describeErrorCode('invalid_envelope')).toBe('Los datos del cambio no eran válidos');
    expect(describeErrorCode('transient')).toBe('No se pudo guardar ahora mismo; se reintenta solo');
    expect(describeErrorCode('internal')).toBe('Algo falló al guardar; se reintenta solo');
    // Guía de la casa (wiki)
    expect(describeErrorCode('wiki_revision_conflict')).toBe(
      'Otra persona guardó cambios mientras editabas; revisa su versión antes de guardar la tuya'
    );
    expect(describeErrorCode('slug_taken')).toBe('Ya existe una nota con ese nombre');
    // Menú/compra
    expect(describeErrorCode('menu_content_changed')).toBe('El menú cambió mientras confirmabas: revísalo');
    expect(describeErrorCode('allergen_conflict')).toBe('Choca con un alérgeno declarado del hogar');
    // Accesos: sus mensajes viven como messageOverrides de Ajustes (fuera del
    // grafo inicial de Hoy); aquí caen en la frase genérica.
    expect(describeErrorCode('already_revoked')).toBeNull();
  });

  it('un código sin traducir nunca se escupe crudo en pantalla', () => {
    expect(describeErrorCode('martian_error')).toBeNull();
    expect(describeErrorCode(undefined)).toBeNull();
    expect(describeErrorCode('')).toBeNull();
  });

  it('el reexport histórico de lib/employment/outbox sigue funcionando', () => {
    expect(describeFromOutbox('settlement_not_open')).toBe('La cuenta del mes ya no está abierta');
    expect(describeFromOutbox).toBe(describeErrorCode);
  });
});
