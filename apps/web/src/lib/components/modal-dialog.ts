import { tick } from 'svelte';
import type { Action } from 'svelte/action';

/**
 * Diálogo accesible mínimo: foco inicial, ciclo de Tab dentro del nodo,
 * Escape cierra, bloqueo de scroll del fondo y foco de vuelta al disparador.
 * Vivía en AppShell.svelte; se extrae aquí porque el módulo Finanzas usa el
 * mismo contrato (§8 de la spec ordena reutilizarlo) y una segunda copia se
 * quedaría atrás en la primera corrección.
 */
export const modalDialog: Action<HTMLElement, { onClose: () => void }> = (node, options) => {
  const previous = document.activeElement as HTMLElement | null;
  const focusables = () =>
    Array.from(
      node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    );
  void tick().then(() => {
    (node.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? node).focus();
  });
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      options.onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === node)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };
  node.addEventListener('keydown', onKeydown);
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return {
    destroy() {
      node.removeEventListener('keydown', onKeydown);
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    }
  };
};
