/**
 * Suspension of the shell (FE-005; 02 §2.1). While the element is out of the document the shell
 * keeps its components and their state, but stops what watches the page: its `ResizeObserver`s and
 * its colour-scheme listener. The application sets the flag (`setSuspended` of App.svelte) and
 * components read it through the context, inside the effect that owns the observer, so the effect
 * runs again when the flag changes.
 */
import { getContext, setContext } from 'svelte';

const KEY = Symbol('de-suspended');

/** Called by the application while it initialises: `read` returns whether the shell is suspended. */
export function provideSuspension(read: () => boolean): void {
  setContext(KEY, read);
}

/**
 * Called by a component while it initialises. The function it returns reads the flag; outside an
 * application that provides one (a component mounted alone in a test) it is always false.
 */
export function useSuspension(): () => boolean {
  return getContext<(() => boolean) | undefined>(KEY) ?? (() => false);
}
