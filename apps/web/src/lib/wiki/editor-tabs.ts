/**
 * Lógica pura del conmutador Visual/Markdown del editor de wiki. El estado es
 * mínimo (dos pestañas y un flag de disponibilidad del editor visual), pero la
 * navegación por teclado del patrón WAI-ARIA de tabs vive aquí para poder
 * testearla sin DOM.
 */

export type EditorTab = 'visual' | 'markdown';

export const EDITOR_TABS: readonly EditorTab[] = ['visual', 'markdown'];

/** Pestañas seleccionables: sin editor visual solo queda Markdown. */
export function availableEditorTabs(visualAvailable: boolean): readonly EditorTab[] {
  return visualAvailable ? EDITOR_TABS : ['markdown'];
}

/**
 * Siguiente pestaña según la tecla pulsada (ArrowLeft/ArrowRight/Home/End,
 * con envoltura circular). Devuelve null si la tecla no navega: el caller no
 * debe hacer preventDefault en ese caso.
 */
export function nextEditorTab(
  current: EditorTab,
  key: string,
  visualAvailable: boolean
): EditorTab | null {
  const tabs = availableEditorTabs(visualAvailable);
  const index = Math.max(0, tabs.indexOf(current));
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return tabs[(index + 1) % tabs.length]!;
    case 'ArrowLeft':
    case 'ArrowUp':
      return tabs[(index - 1 + tabs.length) % tabs.length]!;
    case 'Home':
      return tabs[0]!;
    case 'End':
      return tabs[tabs.length - 1]!;
    default:
      return null;
  }
}
