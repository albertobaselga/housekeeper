import { describe, expect, it } from 'vitest';

import { availableEditorTabs, nextEditorTab } from '../src/lib/wiki/editor-tabs';

describe('conmutador Visual/Markdown del editor de wiki', () => {
  it('ofrece ambas pestañas cuando el editor visual está disponible', () => {
    expect(availableEditorTabs(true)).toEqual(['visual', 'markdown']);
  });

  it('solo deja Markdown cuando Milkdown ha fallado', () => {
    expect(availableEditorTabs(false)).toEqual(['markdown']);
  });

  it('navega con flechas y envuelve en círculo', () => {
    expect(nextEditorTab('visual', 'ArrowRight', true)).toBe('markdown');
    expect(nextEditorTab('markdown', 'ArrowRight', true)).toBe('visual');
    expect(nextEditorTab('visual', 'ArrowLeft', true)).toBe('markdown');
    expect(nextEditorTab('markdown', 'ArrowLeft', true)).toBe('visual');
  });

  it('Home y End van a los extremos', () => {
    expect(nextEditorTab('markdown', 'Home', true)).toBe('visual');
    expect(nextEditorTab('visual', 'End', true)).toBe('markdown');
  });

  it('ignora teclas que no navegan', () => {
    expect(nextEditorTab('visual', 'Enter', true)).toBeNull();
    expect(nextEditorTab('visual', 'a', true)).toBeNull();
  });

  it('sin editor visual siempre se queda en Markdown', () => {
    expect(nextEditorTab('markdown', 'ArrowRight', false)).toBe('markdown');
    expect(nextEditorTab('markdown', 'Home', false)).toBe('markdown');
  });
});
