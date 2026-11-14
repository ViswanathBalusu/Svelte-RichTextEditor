// The example host toolbar (UX-093 criterion 4) against a stand-in element and a stand-in DOM.
// The test runs in Node, so `document` and the element are fakes. The fakes offer only the members
// the example is allowed to use (`queryCommand`, `exec`, `focus`, the event listeners), so a call to
// any other element member throws and fails the test. The page itself is not run in a browser.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_TOOLBAR_COMMANDS,
  attachHostToolbar,
  supportsHostToolbar,
  type CommandHost,
  type CommandState,
} from '../src/lib/glue/host-toolbar.ts';

/** A stand-in for a button: the members the toolbar sets, reads and removes. */
class FakeButton extends EventTarget {
  type = '';
  textContent = '';
  readonly dataset: Record<string, string> = {};
  readonly #attributes = new Map<string, string>();
  removed = false;

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }
  remove(): void {
    this.removed = true;
  }
}

/** A stand-in for the container: records the buttons appended to it. */
class FakeContainer {
  readonly children: FakeButton[] = [];
  append(...nodes: FakeButton[]): void {
    this.children.push(...nodes);
  }
}

/** A stand-in for `<doc-editor>` with only the members the example uses. */
class FakeElement extends EventTarget {
  readonly queried: string[] = [];
  readonly executed: Array<{ id: string; args?: unknown }> = [];
  focusCalls = 0;
  states = new Map<string, CommandState>();

  queryCommand(id: string): CommandState {
    this.queried.push(id);
    return this.states.get(id) ?? { enabled: false };
  }
  exec(id: string, args?: unknown): boolean {
    this.executed.push({ id, ...(args === undefined ? {} : { args }) });
    return true;
  }
  focus(): void {
    this.focusCalls += 1;
  }
  fire(type: string, detail?: unknown): void {
    this.dispatchEvent(detail === undefined ? new Event(type) : new CustomEvent(type, { detail }));
  }
  asHost(): CommandHost {
    return this as unknown as CommandHost;
  }
}

const ids = HOST_TOOLBAR_COMMANDS.map((c) => c.id);

function buttonFor(container: FakeContainer, id: string): FakeButton {
  const b = container.children.find((c) => c.dataset['command'] === id);
  if (!b) throw new Error(`no button for ${id}`);
  return b;
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new FakeButton() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the example host toolbar (UX-093 criterion 4)', () => {
  it('builds nothing when the element does not offer queryCommand and exec', () => {
    // An element of the current build: an event target with no command members.
    const el = new EventTarget() as unknown as CommandHost;
    const container = new FakeContainer();
    expect(supportsHostToolbar(el)).toBe(false);
    expect(attachHostToolbar(el, container as unknown as HTMLElement)).toBeNull();
    expect(container.children).toHaveLength(0);
  });

  it('builds one button per registry command, in order, and sets each state from queryCommand', async () => {
    const el = new FakeElement();
    el.states.set('format.bold', { enabled: true, active: true });
    el.states.set('format.italic', { enabled: true, active: false });
    el.states.set('edit.undo', { enabled: false });
    el.states.set('edit.redo', { enabled: true });
    const container = new FakeContainer();
    const detach = attachHostToolbar(el.asHost(), container as unknown as HTMLElement);
    expect(detach).toBeTypeOf('function');
    await vi.waitFor(() => expect(el.queried).toHaveLength(ids.length));

    expect(container.children.map((c) => c.dataset['command'])).toEqual(ids);
    expect(container.children.map((c) => c.textContent)).toEqual(
      HOST_TOOLBAR_COMMANDS.map((c) => c.label),
    );
    expect(container.children.every((c) => c.type === 'button')).toBe(true);
    expect(buttonFor(container, 'format.bold').getAttribute('aria-disabled')).toBe('false');
    expect(buttonFor(container, 'format.bold').getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor(container, 'format.italic').getAttribute('aria-pressed')).toBe('false');
    expect(buttonFor(container, 'edit.undo').getAttribute('aria-disabled')).toBe('true');
    expect(buttonFor(container, 'edit.undo').getAttribute('aria-pressed')).toBeNull();
    expect(buttonFor(container, 'edit.redo').getAttribute('aria-disabled')).toBe('false');
  });

  it('runs exec with the command identifier on click, and not when the button is disabled', async () => {
    const el = new FakeElement();
    el.states.set('format.bold', { enabled: true });
    el.states.set('edit.undo', { enabled: false });
    const container = new FakeContainer();
    attachHostToolbar(el.asHost(), container as unknown as HTMLElement);
    await vi.waitFor(() => expect(el.queried).toHaveLength(ids.length));

    buttonFor(container, 'format.bold').dispatchEvent(new Event('click'));
    expect(el.executed).toEqual([{ id: 'format.bold' }]);
    expect(el.focusCalls).toBe(1);

    buttonFor(container, 'edit.undo').dispatchEvent(new Event('click'));
    expect(el.executed).toHaveLength(1);
    expect(el.focusCalls).toBe(1);
  });

  it('refreshes only the commands named in de-command-state, from either detail shape', async () => {
    const el = new FakeElement();
    const container = new FakeContainer();
    attachHostToolbar(el.asHost(), container as unknown as HTMLElement);
    await vi.waitFor(() => expect(el.queried).toHaveLength(ids.length));
    el.queried.length = 0;

    el.states.set('format.bold', { enabled: true });
    el.fire('de-command-state', ['format.bold']);
    await vi.waitFor(() =>
      expect(buttonFor(container, 'format.bold').getAttribute('aria-disabled')).toBe('false'),
    );
    expect(el.queried).toEqual(['format.bold']);

    el.queried.length = 0;
    el.states.set('edit.redo', { enabled: true, active: false });
    el.fire('de-command-state', { commands: ['edit.redo'] });
    await vi.waitFor(() =>
      expect(buttonFor(container, 'edit.redo').getAttribute('aria-disabled')).toBe('false'),
    );
    expect(el.queried).toEqual(['edit.redo']);
  });

  it('refreshes every button when de-command-state carries no list', async () => {
    const el = new FakeElement();
    const container = new FakeContainer();
    attachHostToolbar(el.asHost(), container as unknown as HTMLElement);
    await vi.waitFor(() => expect(el.queried).toHaveLength(ids.length));
    el.queried.length = 0;
    el.fire('de-command-state');
    await vi.waitFor(() => expect(el.queried).toHaveLength(ids.length));
    expect(el.queried).toEqual(ids);
  });

  it('removes its buttons and its listener when detached', async () => {
    const el = new FakeElement();
    const container = new FakeContainer();
    const detach = attachHostToolbar(el.asHost(), container as unknown as HTMLElement);
    await vi.waitFor(() => expect(el.queried).toHaveLength(ids.length));
    const buttons = [...container.children];
    detach?.();
    expect(buttons.every((b) => b.removed)).toBe(true);
    el.queried.length = 0;
    el.fire('de-command-state');
    await Promise.resolve();
    expect(el.queried).toHaveLength(0);
  });

  it('touches only queryCommand, exec, focus and the listeners of the element (source check)', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../src/lib/glue/host-toolbar.ts', import.meta.url)),
      'utf8',
    );
    const members = new Set([...source.matchAll(/\bel\.([A-Za-z]+)/g)].map((m) => m[1]));
    expect([...members].sort()).toEqual(
      ['addEventListener', 'exec', 'focus', 'queryCommand', 'removeEventListener'].sort(),
    );
    expect(source).toContain("'de-command-state'");
  });
});
