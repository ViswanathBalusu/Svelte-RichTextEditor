// SEC-009 criterion 2 (Node.js only): a key that is an editor shortcut, pressed while focus is in the
// host page, fires nothing in the editor (10 §3.1 global side effects; FE-021, FE-025).
//
// The shell's listener decides from the event's composed path (shortcuts.ts `startedInside`), not
// from document.activeElement. This test builds keydown events whose composed path does not pass
// through the editor's shadow root, the path a host-page key takes, and dispatches them at the
// root. The browser supplies the real path; here the path is set by the test, so this proves the
// decision of the listener and not the browser's focus handling (a browser run is not part of this
// file). A key that starts inside the editor is the control: it must reach the command.
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachShortcuts, SHELL_SHORTCUTS, type ShellCommand } from '../src/shortcuts.ts';

/** A keydown with the fields the shortcut listener reads, and a composed path the test sets. */
class FakeKeyboardEvent extends Event {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey = false;
  readonly altKey = false;
  readonly shiftKey: boolean;
  readonly #path: readonly unknown[];

  constructor(key: string, shiftKey: boolean, path: readonly unknown[]) {
    super('keydown', { bubbles: true, cancelable: true, composed: true });
    this.key = key;
    this.code = `Key${key.toUpperCase()}`;
    this.ctrlKey = true;
    this.shiftKey = shiftKey;
    this.#path = path;
  }

  override composedPath(): EventTarget[] {
    return this.#path as EventTarget[];
  }
}

/** Plain objects stand for the host's elements: none of them is the editor's root. */
function hostPath(depth: number): unknown[] {
  return Array.from({ length: depth }, (_, i) => ({ hostElement: i }));
}

beforeEach(() => {
  // Non-Apple platform, so the modifier is Ctrl (shortcutName reads navigator).
  vi.stubGlobal('navigator', { platform: 'Win32' });
  vi.stubGlobal('KeyboardEvent', FakeKeyboardEvent);
  // The listener's own type tests; no DOM classes exist in Node.js.
  vi.stubGlobal('HTMLElement', function HTMLElement() {});
  vi.stubGlobal('Node', function Node() {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The shortcut letters and the shift state that the shell's table names. */
const TABLE_KEYS = Object.keys(SHELL_SHORTCUTS).map((name) => ({
  letter: name.at(-1)!.toLowerCase(),
  shift: name.startsWith('Shift-'),
}));

describe('a shortcut pressed in the host page fires nothing in the editor (SEC-009 criterion 2)', () => {
  it('never runs a command and never cancels the key, for any shortcut of the table', () => {
    fc.assert(
      fc.property(fc.constantFrom(...TABLE_KEYS), fc.integer({ min: 1, max: 5 }), (key, depth) => {
        const root = new EventTarget();
        const run = vi.fn((_command: ShellCommand) => true);
        const stop = attachShortcuts(root as unknown as ShadowRoot, run);
        const event = new FakeKeyboardEvent(key.letter, key.shift, hostPath(depth));
        root.dispatchEvent(event);
        stop();
        expect(run).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('does not run when the editor root is absent from the composed path, even if it is an ancestor', () => {
    const root = new EventTarget();
    const run = vi.fn((_command: ShellCommand) => true);
    const stop = attachShortcuts(root as unknown as ShadowRoot, run);
    // The root is in the path of an unrelated key: the path names a sibling root, not this one.
    const sibling = new EventTarget();
    const event = new FakeKeyboardEvent('b', false, [{ hostElement: 0 }, sibling]);
    root.dispatchEvent(event);
    stop();
    expect(run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('control: the same key started inside the editor reaches the command and is cancelled', () => {
    const root = new EventTarget();
    const run = vi.fn((_command: ShellCommand) => true);
    const stop = attachShortcuts(root as unknown as ShadowRoot, run);
    const event = new FakeKeyboardEvent('b', false, [
      { editorToolbarButton: 0 },
      root,
      { hostElement: 0 },
    ]);
    root.dispatchEvent(event);
    stop();
    expect(run).toHaveBeenCalledWith('bold');
    expect(event.defaultPrevented).toBe(true);
  });
});
