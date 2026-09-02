/**
 * Instalación como aplicación de pantalla de inicio, desde el navegador.
 *
 * Módulo aparte y cargado bajo demanda, igual que `lib/push/subscribe.ts`: el
 * banner que lo usa lo importa con `import()` al montar, así que ni una línea
 * de esto viaja en el arranque de Hoy.
 *
 * `isInstalled()` y `looksLikeApple()` vivían en `lib/push/subscribe.ts`
 * porque ahí hacía falta distinguir «no hay canal» de «no está instalada».
 * Ahora que también las necesita el banner de instalación, viven aquí y
 * `subscribe.ts` las importa de vuelta: una sola definición para las dos
 * preguntas, no dos copias que puedan divergir.
 *
 * El listener de `beforeinstallprompt` NO vive aquí: vive en
 * `$lib/pwa/prompt-capture.ts`, importado ESTÁTICAMENTE desde el layout raíz,
 * porque Chromium dispara ese evento una sola vez y a menudo antes de que
 * este módulo diferido llegue a cargarse. Lo de aquí abajo solo LEE lo que
 * `prompt-capture.ts` ya capturó.
 */
import { capturedPrompt, onCapturedPromptChange, type BeforeInstallPromptEvent } from './prompt-capture';

export type { BeforeInstallPromptEvent };

export function looksLikeApple(): boolean {
  // iPadOS se anuncia como Macintosh con puntero táctil desde iPadOS 13.
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function isInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari en iOS no implementa `display-mode: standalone` en versiones
    // antiguas y expone esta propiedad no estándar en su lugar.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/**
 * Ya no hay nada que registrar aquí: `prompt-capture.ts`, importado
 * estáticamente desde el layout raíz, ya lo hizo al arrancar la aplicación,
 * mucho antes de que este módulo diferido llegara a evaluarse. Se conserva
 * como no-op para no romper a quien todavía la llame.
 */
export function captureInstallPrompt(): void {
  // Intencionadamente vacío: ver la cabecera del módulo.
}

/** El evento diferido AHORA MISMO, o `null` si no ha llegado (o ya se usó). */
export function currentDeferredPrompt(): BeforeInstallPromptEvent | null {
  return capturedPrompt();
}

/** Avisa cuando cambia el evento diferido. Devuelve cómo dejar de escuchar. */
export function onDeferredPromptChange(
  listener: (event: BeforeInstallPromptEvent | null) => void
): () => void {
  return onCapturedPromptChange(listener);
}

export type InstallOffer = 'prompt' | 'ios-instructions' | 'none';

export interface InstallOfferFacts {
  /** Ya entró desde el icono de la pantalla de inicio: no hay nada que ofrecer. */
  standalone: boolean;
  /** iPhone, iPad, o iPad que se anuncia como Mac con puntero táctil. */
  apple: boolean;
  /** Chromium ya disparó `beforeinstallprompt` y lo tenemos guardado. */
  hasDeferredPrompt: boolean;
  /** `(pointer: coarse)`: solo se ofrece en dedo, nunca en ratón. */
  coarsePointer: boolean;
  /** Se descartó ya en esta pestaña/sesión (ver `installDismissedThisVisit`). */
  dismissedThisVisit: boolean;
}

/**
 * Decisión PURA de qué ofrecer, sin tocar el DOM: la prueba unitaria cubre las
 * ramas sin necesitar un navegador.
 */
export function shouldOfferInstall(facts: InstallOfferFacts): InstallOffer {
  if (facts.standalone) return 'none';
  if (facts.dismissedThisVisit) return 'none';
  if (!facts.coarsePointer) return 'none';
  if (facts.hasDeferredPrompt) return 'prompt';
  if (facts.apple) return 'ios-instructions';
  return 'none';
}

const INSTALL_DISMISS_KEY = 'housekeeper-install-dismissed';

/**
 * Descartado en ESTA visita. En `sessionStorage`, no en `localStorage`:
 * reaparece en la próxima visita, a propósito (requisito literal del
 * producto, no una fuga).
 */
export function installDismissedThisVisit(): boolean {
  try {
    return sessionStorage.getItem(INSTALL_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissInstallBanner(): void {
  try {
    sessionStorage.setItem(INSTALL_DISMISS_KEY, '1');
  } catch {
    // Sin sessionStorage (modo privado extremo) el descarte no persiste, y no
    // hay nada más que romper: el banner solo volverá a aparecer antes de lo
    // esperado en esa pestaña.
  }
}
