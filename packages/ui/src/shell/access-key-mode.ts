/**
 * The access-key gesture (UX-012; 13 §4). Proposed, not decided: see docs/adr/0325-lane-U-UX-001-015.md.
 *
 * Alt pressed and released with no other key in between enters access-key mode. In the mode a
 * letter or digit names a command shown on the toolbars (its access key); Escape leaves the mode.
 * A key pressed while Alt is held (Alt+Q) is a shortcut, not the gesture, and is not consumed here.
 *
 * This module holds the state only. The shell reads the actions it returns and does the work, so
 * the gesture can be tested without a browser.
 */

export type AccessKeyAction =
  /** Nothing to do. */
  | { readonly kind: 'none' }
  /** Alt was released alone: the mode starts. */
  | { readonly kind: 'enter' }
  /** Escape: the mode ends. */
  | { readonly kind: 'leave' }
  /** A letter or digit in the mode: the shell resolves it against the shown keys. */
  | { readonly kind: 'press'; readonly key: string }
  /** Another key in the mode that names nothing: it is swallowed and the mode stays. */
  | { readonly kind: 'consume' };

/** Keys that change the state of the keyboard but do not end the gesture or name a command. */
const MODIFIERS = new Set(['Alt', 'Shift', 'Control', 'Meta', 'AltGraph', 'CapsLock']);

/** A key that can be an access key: one letter or digit. */
const ACCESS_KEY = /^[\p{L}\p{N}]$/u;

/** True for the keys that only change the modifier state. */
export function isModifierKey(key: string): boolean {
  return MODIFIERS.has(key);
}

export class AccessKeyGesture {
  #altAlone = false;
  #active = false;

  /** True while the mode is on. */
  get active(): boolean {
    return this.#active;
  }

  /** A key went down (KeyboardEvent.key). Returns what the shell should do with it. */
  keyDown(key: string): AccessKeyAction {
    if (key === 'Alt') {
      if (!this.#active) this.#altAlone = true;
      return { kind: 'none' };
    }
    // Any other key pressed while Alt is held makes Alt part of a shortcut, not the gesture.
    this.#altAlone = false;
    if (!this.#active) return { kind: 'none' };
    if (key === 'Escape') {
      this.#active = false;
      return { kind: 'leave' };
    }
    if (isModifierKey(key)) return { kind: 'none' };
    if (ACCESS_KEY.test(key)) return { kind: 'press', key: key.toLowerCase() };
    return { kind: 'consume' };
  }

  /** A key went up. Alt released alone enters the mode. */
  keyUp(key: string): AccessKeyAction {
    if (key !== 'Alt') return { kind: 'none' };
    const alone = this.#altAlone && !this.#active;
    this.#altAlone = false;
    if (!alone) return { kind: 'none' };
    this.#active = true;
    return { kind: 'enter' };
  }

  /** Ends the mode without a key (after a command ran, or when the shell closes it). */
  exit(): void {
    this.#active = false;
    this.#altAlone = false;
  }
}

/** One control on a toolbar that shows an access key: its command, its key and its group. */
export interface ShownAccessKey {
  readonly id: string;
  readonly key: string;
  readonly group: string;
}

export type ResolvedAccessKey =
  | { readonly kind: 'one'; readonly id: string; readonly group: string }
  | { readonly kind: 'none' }
  /** The same key is shown for commands in more than one group: the mode does not guess. */
  | { readonly kind: 'ambiguous' };

/**
 * Resolves a pressed key against the keys shown now. A key shown by one command (or by several in
 * one group, which the registry does not allow) resolves to it. A key shown in more than one group
 * is ambiguous and runs nothing, so the shown keys always name the command that runs.
 */
export function resolveShownKey(
  shown: readonly ShownAccessKey[],
  pressed: string,
): ResolvedAccessKey {
  const key = pressed.toLowerCase();
  const hits = shown.filter((s) => s.key === key);
  if (hits.length === 0) return { kind: 'none' };
  const groups = new Set(hits.map((h) => h.group));
  if (groups.size > 1) return { kind: 'ambiguous' };
  const first = hits[0]!;
  return { kind: 'one', id: first.id, group: first.group };
}

/** A control on a toolbar that shows an access key, for the tips the shell draws. */
export interface AccessKeyTip {
  readonly element: HTMLElement;
  readonly key: string;
}
