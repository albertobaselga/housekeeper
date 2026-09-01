/**
 * Captura TEMPRANA de `beforeinstallprompt`, sin dependencias.
 *
 * Chromium dispara ese evento UNA sola vez, a menudo antes de que nada
 * diferido llegue a registrar un listener: `InstallBanner.svelte` cargaba
 * `$lib/pwa/install` con `import()` dentro de `onMount`, y para cuando ese
 * módulo se evaluaba el evento ya había pasado y no volvía. Este módulo se
 * importa ESTÁTICAMENTE desde el layout raíz (`routes/+layout.svelte`),
 * así que se evalúa —y registra su listener— antes de que monte ningún
 * componente.
 *
 * Cada byte de aquí viaja en el arranque de TODA la aplicación, incluida Hoy
 * (`pnpm --filter @housekeeper/web verify:bundle`): por eso no importa nada,
 * ni siquiera un tipo de otro módulo.
 */

export interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  prompt(): Promise<void>;
}

let captured: BeforeInstallPromptEvent | null = null;
const listeners = new Set<(event: BeforeInstallPromptEvent | null) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Obligatorio: sin esto Chromium enseña su propio mini-infobar y el
    // evento no queda disponible para el botón propio.
    event.preventDefault();
    captured = event as BeforeInstallPromptEvent;
    for (const listener of listeners) listener(captured);
  });
  window.addEventListener('appinstalled', () => {
    captured = null;
    for (const listener of listeners) listener(null);
  });
}

/** El evento diferido AHORA MISMO, o `null` si no ha llegado (o ya se usó). */
export function capturedPrompt(): BeforeInstallPromptEvent | null {
  return captured;
}

/** Avisa cuando cambia el evento diferido. Devuelve cómo dejar de escuchar. */
export function onCapturedPromptChange(listener: (event: BeforeInstallPromptEvent | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** El evento diferido se consume una sola vez: tras usarlo, se olvida. */
export function clearCapturedPrompt(): void {
  captured = null;
}
