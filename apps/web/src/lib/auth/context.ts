import { getContext, setContext } from 'svelte';
import type { AppContext } from './types';

const APP_CONTEXT_KEY = Symbol('casa-clara-app-context');

export function provideAppContext(context: AppContext): AppContext {
  setContext(APP_CONTEXT_KEY, context);
  return context;
}

export function useAppContext(): AppContext {
  const context = getContext<AppContext | undefined>(APP_CONTEXT_KEY);
  if (!context) throw new Error('AppContext is only available inside the household shell');
  return context;
}
