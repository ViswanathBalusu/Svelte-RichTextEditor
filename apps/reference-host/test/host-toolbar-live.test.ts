// The example host toolbar (UX-093 criterion 4) fed with the event the element really raises.
// `de-command-state` carries `{ commands: [{ name, enabled, active }] }` (packages/element/src/
// events.ts, CommandStateChange). The toolbar must read `name` from each entry, or the buttons never
// follow the person's permissions after the first paint. Node.js only: `document` and the element
// are stand-ins, and the page is not run in a browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachHostToolbar,
  type CommandHost,
  type CommandState,
} from '../src/lib/glue/host-toolbar.ts';

class FakeButton extends EventTarget {
  type = '';
  textContent = '';
  readonly dataset: Record<string, string> = {};
  readonly #attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }
  remove(): void {}
}

class FakeContainer {
  readonly children: FakeButton[] = [];
  append(...nodes: FakeButton[]): void {
    this.children.push(...nodes);
  }
}

class FakeElement extends EventTarget {
  readonly queried: string[] = [];
  states = new Map<string, CommandState>();
  queryCommand(id: string): CommandState {
    this.queried.push(id);
    return this.states.get(id) ?? { enabled: false };
  }
  exec(): boolean {
    return true;
  }
  focus(): void {}
  fire(detail: unknown): void {
    this.dispatchEvent(new CustomEvent('de-command-state', { detail }));
  }
  asHost(): CommandHost {
    return this as unknown as CommandHost;
  }
}

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

describe('the example host toolbar follows the element event (UX-093 criterion 4)', () => {
  it('updates a button from a de-command-state entry carrying name, enabled and active', async () => {
    const el = new FakeElement();
    const container = new FakeContainer();
    attachHostToolbar(el.asHost(), container as unknown as HTMLElement);
    await vi.waitFor(() => expect(el.queried).toHaveLength(4));
    expect(buttonFor(container, 'format.bold').getAttribute('aria-disabled')).toBe('true');

    el.states.set('format.bold', { enabled: true, active: true });
    el.fire({ commands: [{ name: 'format.bold', enabled: true, active: true }] });
    await vi.waitFor(() =>
      expect(buttonFor(container, 'format.bold').getAttribute('aria-disabled')).toBe('false'),
    );
    expect(buttonFor(container, 'format.bold').getAttribute('aria-pressed')).toBe('true');
  });

  it('asks queryCommand only for toolbar commands named in the event, and ignores the others', async () => {
    const el = new FakeElement();
    const container = new FakeContainer();
    attachHostToolbar(el.asHost(), container as unknown as HTMLElement);
    await vi.waitFor(() => expect(el.queried).toHaveLength(4));
    el.queried.length = 0;

    el.states.set('edit.undo', { enabled: true });
    el.fire({
      commands: [
        { name: 'format.underline', enabled: true, active: false },
        { name: 'edit.undo', enabled: true, active: false },
      ],
    });
    await vi.waitFor(() =>
      expect(buttonFor(container, 'edit.undo').getAttribute('aria-disabled')).toBe('false'),
    );
    expect(el.queried).toEqual(['edit.undo']);
  });
});
