/**
 * Keyboard shortcuts of the shell (02 §3 "Keyboard"; 10 §3.1; FE-021, FE-025).
 *
 * The editing views handle their own keys: the core's keymaps listen on each view, so a shortcut
 * pressed in the body or in a sub-editor is the core's. This module routes the same shortcuts when
 * focus is elsewhere inside the editor (the toolbar, a pane, later an overlay), and never when the
 * key was pressed in the host page. Whether a key belongs to the editor is decided from the event's
 * composed path, not from `document.activeElement`, which is the host element for every editor on
 * the page.
 *
 * Order (FE-025): the listener sits on the shadow root and is attached with `on` from
 * `svelte/events`, so Svelte's delegated handlers cannot reorder it. A key event reaches the core's
 * view first (it is deeper in the tree) and this listener afterwards; an event the core handled is
 * already cancelled and is skipped here. The table is the core's keymap until the command registry
 * (UX-003) replaces it.
 */
import { on } from 'svelte/events';

export type ShellCommand = 'bold' | 'italic' | 'undo' | 'redo';

/** Shortcut names in the notation of prosemirror-keymap; `Mod` is Cmd on Apple platforms, Ctrl elsewhere. */
export const SHELL_SHORTCUTS: Readonly<Record<string, ShellCommand>> = {
  'Mod-b': 'bold',
  'Mod-i': 'italic',
  'Mod-z': 'undo',
  'Shift-Mod-z': 'redo',
  'Mod-y': 'redo',
};

/** The events whose handlers are order-sensitive relative to the core (02 §4; FE-025). */
export const ORDER_SENSITIVE_EVENTS = [
  'keydown',
  'beforeinput',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'paste',
  'drop',
] as const;

function isApple(): boolean {
  const nav = globalThis.navigator as
    (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * The name of a key event in prosemirror-keymap's notation, for the letters the table uses. A
 * non-Latin layout reports another `key`; then the physical key (`code`) names the letter, as
 * prosemirror-keymap does with `keyCode`.
 */
export function shortcutName(event: KeyboardEvent, apple = isApple()): string | null {
  let key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (!/^[a-z]$/.test(key)) {
    const m = /^Key([A-Z])$/.exec(event.code);
    if (!m) return null;
    key = m[1]!.toLowerCase();
  }
  const mod = apple ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey || (apple ? event.ctrlKey : event.metaKey)) return null;
  return `${event.shiftKey ? 'Shift-' : ''}Mod-${key}`;
}

/** True when the event's composed path passes through `root`: it started inside this editor. */
export function startedInside(event: Event, root: ShadowRoot): boolean {
  return event.composedPath().includes(root);
}

/** An element that handles its own keys: an editing view (the core's), a form field. */
function handlesOwnKeys(target: EventTarget | undefined): boolean {
  const el =
    target instanceof HTMLElement ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return false;
  return el.isContentEditable || el.closest('input, textarea, select') !== null;
}

/**
 * Listens for the shell's shortcuts on the shadow root; `run` executes a command and reports
 * whether it applied. Returns the function that stops listening.
 */
export function attachShortcuts(
  root: ShadowRoot,
  run: (command: ShellCommand) => boolean,
): () => void {
  return on(root, 'keydown', (event: Event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.defaultPrevented || !startedInside(event, root)) return;
    if (handlesOwnKeys(event.composedPath()[0])) return;
    const name = shortcutName(event);
    const command = name === null ? undefined : SHELL_SHORTCUTS[name];
    if (command && run(command)) event.preventDefault();
  });
}
