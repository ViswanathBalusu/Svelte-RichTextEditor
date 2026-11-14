// FE-025 criterion 3 (lane V-FE-017-032): a keydown handler of the core and the shell's keydown
// handler run in the documented order, the core's first. The core's view and the shell's listener
// on the shadow root are recording stubs, and the key event is a stand-in for KeyboardEvent (Node.js
// has none). The browser run of the same order is `e2e/element.spec.ts` ('the command runs once').
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachShortcuts, shortcutName } from '../src/shortcuts.ts';

class FakeKeyboardEvent {
  defaultPrevented = false;
  readonly code = '';
  readonly metaKey = false;
  readonly altKey = false;
  readonly shiftKey: boolean;
  readonly ctrlKey = true;
  /** The composed path: the first entry is the element that had focus, then the shadow root. */
  readonly path: unknown[];
  readonly key: string;
  constructor(key: string, path: unknown[], shiftKey = false) {
    this.key = key;
    this.shiftKey = shiftKey;
    this.path = path;
  }
  composedPath(): unknown[] {
    return this.path;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

/** A stand-in for the DOM node classes: it has a member, so it is not an empty class. */
class FakeNodeBase {
  readonly isFake = true;
}

const g = globalThis as unknown as Record<string, unknown>;
const saved = { KeyboardEvent: g['KeyboardEvent'], HTMLElement: g['HTMLElement'], Node: g['Node'] };

beforeAll(() => {
  // The shell's checks use these globals; a plain object is neither an element nor a node.
  g['KeyboardEvent'] = FakeKeyboardEvent;
  g['HTMLElement'] = FakeNodeBase;
  g['Node'] = FakeNodeBase;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) Reflect.deleteProperty(g, k);
    else g[k] = v;
  }
});

/** A shadow root stand-in that keeps the keydown listeners `attachShortcuts` adds. */
function fakeRoot(): { root: ShadowRoot; listeners: Array<(event: unknown) => void> } {
  const listeners: Array<(event: unknown) => void> = [];
  const root = {
    addEventListener(type: string, fn: (event: unknown) => void) {
      if (type === 'keydown') listeners.push(fn);
    },
    removeEventListener() {},
  };
  return { root: root as unknown as ShadowRoot, listeners };
}

describe('FE-025: keydown order, core before shell', () => {
  it('runs the core handler first, and the shell skips a key the core already handled', () => {
    const { root, listeners } = fakeRoot();
    const order: string[] = [];
    const commands: string[] = [];
    attachShortcuts(root, (command) => {
      commands.push(command);
      return true;
    });
    const toolbarButton = { id: 'bold-button' };
    const event = new FakeKeyboardEvent('b', [toolbarButton, root]);
    // The core's keymap on its view: it runs first, and it handles Mod-B itself.
    order.push('core');
    if (shortcutName(event as unknown as KeyboardEvent) === 'Mod-b') event.preventDefault();
    for (const listener of listeners) {
      order.push('shell');
      listener(event);
    }
    expect(order).toEqual(['core', 'shell']);
    expect(commands).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('runs the shell command once for a key the core did not handle', () => {
    const { root, listeners } = fakeRoot();
    const order: string[] = [];
    const commands: string[] = [];
    attachShortcuts(root, (command) => {
      commands.push(command);
      return true;
    });
    const event = new FakeKeyboardEvent('z', [{ id: 'toolbar' }, root]);
    order.push('core');
    for (const listener of listeners) {
      order.push('shell');
      listener(event);
    }
    expect(order).toEqual(['core', 'shell']);
    expect(commands).toEqual(['undo']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does nothing for a key whose composed path does not pass through the root', () => {
    const { root, listeners } = fakeRoot();
    const commands: string[] = [];
    attachShortcuts(root, (command) => {
      commands.push(command);
      return true;
    });
    const event = new FakeKeyboardEvent('b', [{ id: 'host-input' }]);
    for (const listener of listeners) listener(event);
    expect(commands).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});
