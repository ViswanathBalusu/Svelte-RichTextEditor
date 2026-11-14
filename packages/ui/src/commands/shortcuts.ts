/**
 * Keyboard shortcuts from the registry (13 §4; UX-013; 02 §3 "Keyboard"). One listener on the
 * shadow root, attached with `on` from `svelte/events` so that Svelte's delegated handlers cannot
 * reorder it (FE-025):
 *
 * - a key pressed in the host page never reaches it: the event's composed path must pass through
 *   the root (UX-013 criterion 4);
 * - a key the editing core's own keymap handled is already cancelled and is skipped, so the core
 *   keeps its keys and nothing runs twice;
 * - the shell's own keys (landmarks, the context menu, the format painter's Enter and Escape) are
 *   offered to `shell` first;
 * - a form field of the shell handles its own keys;
 * - otherwise the key is looked up among the registry's bindings, which include the alternatives
 *   of the shortcut table (UX-013 criterion 2). A bound command that may not run is explained
 *   through `onUnavailable`, never silently ignored (UX-004 criterion 5).
 *
 * This replaces the element's table of phase 1a (`packages/element/src/shortcuts.ts`).
 */
import { on } from 'svelte/events';
import { eventKey } from './keys.ts';
import type { CommandRegistry } from './registry.ts';

export interface ShortcutOptions {
  /** The shell's own keys, by canonical key (see `canonicalKey`); true when it handled the key. */
  shell?: (key: string, event: KeyboardEvent) => boolean;
  /** A bound command could not run; `reasonKey` explains why (a string key). */
  onUnavailable?: (reasonKey: string) => void;
  /** A command ran from its keys (for tests and the reference host). */
  onRun?: (id: string) => void;
}

/** A field of the shell, which handles its own keys. The editing surface is not one. */
function isFormField(target: EventTarget | undefined): boolean {
  const el =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return el !== null && el.closest('input, textarea, select') !== null;
}

/** Listens for shortcuts on `root`; returns the function that stops listening. */
export function bindShortcuts(
  root: ShadowRoot | HTMLElement,
  registry: CommandRegistry,
  options: ShortcutOptions = {},
): () => void {
  return on(root, 'keydown', (event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.defaultPrevented) return;
    const path = event.composedPath();
    if (!path.includes(root)) return;
    const key = eventKey(event);
    if (key === null) return;
    if (options.shell?.(key, event)) {
      event.preventDefault();
      return;
    }
    if (isFormField(path[0])) return;
    const id = registry.commandForKey(key);
    if (!id) return;
    const state = registry.state(id);
    // A command the backend does not offer leaves the key to the browser.
    if (!state.offered) return;
    event.preventDefault();
    const result = registry.exec(id);
    if (result.ran) options.onRun?.(id);
    else if (!state.enabled && state.reasonKey) options.onUnavailable?.(state.reasonKey);
  });
}
