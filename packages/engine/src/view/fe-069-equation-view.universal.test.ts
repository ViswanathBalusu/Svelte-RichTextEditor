/**
 * FE-069 in a real browser: the web view draws `equation` and `equation_block` nodes through the
 * drawer it is given, once the node is in the page; shows the LaTeX source as text without a drawer;
 * keeps hostile LaTeX as text; and shows the number the shared labels give a numbered block, which
 * moves when an earlier equation is added.
 *
 * Runs through `pnpm vitest run --project browser <this file>`. Skipped in Node.js (no DOM).
 */
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import type { EquationDrawer } from '../equation-draw.ts';
import { spikeDocument } from '../spike-document.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

const HOSTILE = '<img src=x onerror="window.__fe069=1"><svg onload="window.__fe069=1">';

interface Harness {
  core: EditorCore;
  host: HTMLElement;
  view: NonNullable<ReturnType<typeof viewsOf>['view']>;
  cleanup(): void;
}

function mount(draw?: EquationDrawer): Harness {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: spikeDocument(),
    access: ownerAccess(),
    schedule: (run) => queueMicrotask(run),
    ...(draw ? { drawEquation: draw } : {}),
  });
  const unmount = core.mountBody(host);
  const view = viewsOf(core).view;
  if (!view) throw new Error('the body view is not mounted');
  return {
    core,
    host,
    view,
    cleanup() {
      unmount();
      core.destroy();
      host.remove();
    },
  };
}

/** Inserts a block equation at the start of the body, or an inline one at the start of "Alpha". */
function insertBlock(h: Harness, id: string, latex: string, numbered: boolean): void {
  const type = h.view.state.schema.nodes['equation_block'];
  if (!type) throw new Error('the schema has no equation_block node');
  let at = -1;
  h.view.state.doc.descendants((n, pos) => {
    if (at >= 0) return false;
    if (n.type.name === 'body') {
      at = pos + 1;
      return false;
    }
    return true;
  });
  h.view.dispatch(h.view.state.tr.insert(at, type.create({ id, latex, numbered })));
}

function insertInline(h: Harness, latex: string): void {
  const type = h.view.state.schema.nodes['equation'];
  if (!type) throw new Error('the schema has no equation node');
  let at = -1;
  h.view.state.doc.descendants((n, pos) => {
    if (at >= 0) return false;
    if (n.isText && n.text?.includes('Alpha')) {
      at = pos;
      return false;
    }
    return true;
  });
  h.view.dispatch(h.view.state.tr.insert(at, type.create({ latex })));
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe.skipIf(!isBrowser)('equations in the web view (FE-069)', () => {
  it('calls the drawer for a block and an inline equation once the container is in the page', async () => {
    const calls: Array<{ latex: string; display: boolean; connected: boolean }> = [];
    const h = mount((container, latex, display) => {
      calls.push({ latex, display, connected: container.isConnected });
      container.textContent = `drawn:${latex}`;
    });
    try {
      insertBlock(h, 'eqTestA000000001', 'a^2+b^2', false);
      insertInline(h, 'x_1');
      await settle();
      expect(calls).toContainEqual({ latex: 'a^2+b^2', display: true, connected: true });
      expect(calls).toContainEqual({ latex: 'x_1', display: false, connected: true });
      expect(h.view.dom.querySelector('.de-equation-body')?.textContent).toBe('drawn:a^2+b^2');
      expect(h.view.dom.querySelector('.de-equation')?.textContent).toBe('drawn:x_1');
      // The document keeps the LaTeX: the drawer only changed the view.
      expect(h.view.dom.querySelector('.de-equation-block')?.getAttribute('data-latex')).toBe(
        'a^2+b^2',
      );
    } finally {
      h.cleanup();
    }
  });

  it('shows the LaTeX source as text without a drawer, and when the drawer throws', async () => {
    const plain = mount();
    try {
      insertBlock(plain, 'eqTestA000000001', 'E=mc^2', false);
      await settle();
      expect(plain.view.dom.querySelector('.de-equation-body')?.textContent).toBe('E=mc^2');
    } finally {
      plain.cleanup();
    }
    const throwing = mount(() => {
      throw new Error('boom');
    });
    try {
      insertBlock(throwing, 'eqTestA000000001', 'E=mc^2', false);
      await settle();
      expect(throwing.view.dom.querySelector('.de-equation-body')?.textContent).toBe('E=mc^2');
    } finally {
      throwing.cleanup();
    }
  });

  it('keeps hostile LaTeX as text and as an attribute value, never as markup', async () => {
    const h = mount();
    try {
      insertBlock(h, 'eqTestA000000001', HOSTILE, false);
      insertInline(h, HOSTILE);
      await settle();
      const block = h.view.dom.querySelector('.de-equation-block');
      expect(block?.getAttribute('data-latex')).toBe(HOSTILE);
      expect(block?.querySelector('.de-equation-body')?.textContent).toBe(HOSTILE);
      expect(
        h.view.dom.querySelectorAll('.de-equation-block img, .de-equation img, svg').length,
      ).toBe(0);
      expect((window as unknown as { __fe069?: number }).__fe069).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it('numbers numbered blocks with the shared labels, and renumbers when an earlier one is added', async () => {
    const h = mount();
    try {
      insertBlock(h, 'eqTestB000000002', 'b', true);
      insertBlock(h, 'eqTestC000000003', 'c', false);
      await settle();
      const numbers = () =>
        Array.from(h.view.dom.querySelectorAll('.de-equation-block')).map(
          (b) => b.querySelector('.de-equation-number')?.textContent ?? '',
        );
      // c (unnumbered, first) shows no number; b is the first numbered equation.
      expect(numbers()).toEqual(['', '(1)']);
      insertBlock(h, 'eqTestA000000001', 'a', true);
      await settle();
      expect(numbers()).toEqual(['(1)', '', '(2)']);
      const shared = Array.from(h.view.dom.querySelectorAll('.de-equation-block')).map((b) =>
        b.getAttribute('data-equation-number'),
      );
      expect(shared).toEqual(['1', null, '2']);
    } finally {
      h.cleanup();
    }
  });
});
