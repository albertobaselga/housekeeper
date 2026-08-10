import { describe, expect, it } from 'vitest';

import {
  DwellClock,
  MIN_DWELL_MS,
  countsAsRead,
  pendingReadsKey,
  rememberPendingRead,
  takePendingReads,
  type PendingReadStorage
} from '../src/lib/guide/reading';

function fakeStorage(): PendingReadStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  };
}

describe('qué cuenta como leída', () => {
  it('exige haber visto el final Y un mínimo de permanencia', () => {
    // Pasar de página al instante no es leer: con 52 notas se «terminaría» el
    // manual en diez segundos y la casilla marcada no serviría a nadie.
    expect(countsAsRead({ dwellMs: 0, reachedEnd: true })).toBe(false);
    expect(countsAsRead({ dwellMs: MIN_DWELL_MS - 1, reachedEnd: true })).toBe(false);
    // Estar mucho rato sin llegar al final tampoco: la nota queda a medias.
    expect(countsAsRead({ dwellMs: 10 * 60_000, reachedEnd: false })).toBe(false);
    // Las dos señales juntas, sí.
    expect(countsAsRead({ dwellMs: MIN_DWELL_MS, reachedEnd: true })).toBe(true);
  });

  it('el umbral no crece con el texto: no es un examen de velocidad', () => {
    // Misma regla para una nota de tres líneas y para una de tres pantallas.
    expect(countsAsRead({ dwellMs: 2_500, reachedEnd: true })).toBe(true);
    expect(countsAsRead({ dwellMs: 90_000, reachedEnd: true })).toBe(true);
  });
});

describe('cronómetro de permanencia', () => {
  it('solo cuenta con la pestaña a la vista', () => {
    let now = 0;
    const clock = new DwellClock(() => now);
    clock.start();
    now = 1_500;
    expect(clock.elapsedMs).toBe(1_500);

    // Se va a otra pestaña: el tiempo deja de correr.
    clock.pause();
    now = 60_000;
    expect(clock.elapsedMs).toBe(1_500);

    // Vuelve: sigue donde lo dejó.
    clock.start();
    now = 60_800;
    expect(clock.elapsedMs).toBe(2_300);
    expect(countsAsRead({ dwellMs: clock.elapsedMs, reachedEnd: true })).toBe(true);

    clock.reset();
    expect(clock.elapsedMs).toBe(0);
  });

  it('empezar dos veces no duplica el tiempo', () => {
    let now = 0;
    const clock = new DwellClock(() => now);
    clock.start();
    clock.start();
    now = 1_000;
    expect(clock.elapsedMs).toBe(1_000);
  });
});

describe('lecturas pendientes de enviar (sin conexión)', () => {
  const household = '10000000-0000-4000-8000-000000000001';

  it('guarda por hogar, no repite y se vacía al recogerlas', () => {
    const storage = fakeStorage();
    rememberPendingRead(storage, household, 'nota-a');
    rememberPendingRead(storage, household, 'nota-b');
    rememberPendingRead(storage, household, 'nota-a');
    expect(storage.data.has(pendingReadsKey(household))).toBe(true);

    expect(takePendingReads(storage, household)).toEqual(['nota-b', 'nota-a']);
    // Recogerlas las vacía: quien llama se compromete a enviarlas.
    expect(takePendingReads(storage, household)).toEqual([]);
  });

  it('no guarda ninguna fecha: ni el propio dispositivo sabe cuándo fue', () => {
    const storage = fakeStorage();
    rememberPendingRead(storage, household, 'nota-a');
    const raw = storage.data.get(pendingReadsKey(household))!;
    expect(JSON.parse(raw)).toEqual(['nota-a']);
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('un contenido corrupto no rompe la lectura', () => {
    const storage = fakeStorage();
    storage.setItem(pendingReadsKey(household), '{no es json');
    expect(takePendingReads(storage, household)).toEqual([]);
  });

  it('cada hogar lleva su propia lista', () => {
    const storage = fakeStorage();
    rememberPendingRead(storage, household, 'nota-a');
    rememberPendingRead(storage, '20000000-0000-4000-8000-000000000001', 'nota-z');
    expect(takePendingReads(storage, household)).toEqual(['nota-a']);
    expect(takePendingReads(storage, '20000000-0000-4000-8000-000000000001')).toEqual(['nota-z']);
  });
});
