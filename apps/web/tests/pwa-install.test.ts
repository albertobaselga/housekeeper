import { describe, expect, it } from 'vitest';

import { shouldOfferInstall, type InstallOfferFacts } from '../src/lib/pwa/install';

/**
 * La decisión pura del banner de instalación, sin tocar el DOM: cada rama de
 * `shouldOfferInstall` se cubre por separado para que un cambio en el orden de
 * las reglas se note aquí y no en producción.
 */
describe('qué ofrecer en el banner de instalación', () => {
  const base: InstallOfferFacts = {
    standalone: false,
    apple: false,
    hasDeferredPrompt: false,
    coarsePointer: true,
    dismissedThisVisit: false
  };

  it('no ofrece nada si ya entró desde el icono de la pantalla de inicio', () => {
    expect(shouldOfferInstall({ ...base, standalone: true })).toBe('none');
    // Ni aunque el resto de condiciones apunten a ofrecer algo: standalone gana.
    expect(shouldOfferInstall({ ...base, standalone: true, hasDeferredPrompt: true })).toBe('none');
    expect(shouldOfferInstall({ ...base, standalone: true, apple: true })).toBe('none');
  });

  it('no ofrece nada si ya se descartó en esta visita', () => {
    expect(shouldOfferInstall({ ...base, dismissedThisVisit: true, hasDeferredPrompt: true })).toBe('none');
    expect(shouldOfferInstall({ ...base, dismissedThisVisit: true, apple: true })).toBe('none');
  });

  it('no ofrece nada fuera de un puntero grueso (ratón, no dedo)', () => {
    expect(shouldOfferInstall({ ...base, coarsePointer: false, hasDeferredPrompt: true })).toBe('none');
    expect(shouldOfferInstall({ ...base, coarsePointer: false, apple: true })).toBe('none');
  });

  it('ofrece el diálogo nativo cuando Chromium ya disparó el evento diferido', () => {
    expect(shouldOfferInstall({ ...base, hasDeferredPrompt: true })).toBe('prompt');
    // El evento diferido manda incluso si además fuera Apple (no puede pasar en
    // la práctica, pero la regla no depende de que sea imposible).
    expect(shouldOfferInstall({ ...base, hasDeferredPrompt: true, apple: true })).toBe('prompt');
  });

  it('ofrece las instrucciones de iOS en Apple sin instalar y sin evento diferido', () => {
    expect(shouldOfferInstall({ ...base, apple: true })).toBe('ios-instructions');
  });

  it('no ofrece nada fuera de Apple y sin evento diferido', () => {
    expect(shouldOfferInstall(base)).toBe('none');
  });
});
