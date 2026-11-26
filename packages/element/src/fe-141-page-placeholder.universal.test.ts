/**
 * FE-141 criterion 1 in the page view (02 §9.6; ADR 0019), in a real browser (Chromium, Firefox,
 * WebKit through `pnpm test:browsers`; skipped in Node.js, which has no canvas). A projection with
 * three `hidden_region` placeholders is opened in the editable page view and in the read-only pages
 * of FE-095. A placeholder is painted as a note with its title, has one fixed size whatever the
 * title, is not editable or selectable and holds nothing, and a selection that runs across it
 * paints it whole.
 */
import { EditorCore } from '@docedit/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { mountPageView } from './page-view/page-view.ts';

const hasDom = typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';

const para = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content: [{ type: 'text', text }],
});

const region = (id: string, title: string | null) => ({
  type: 'hidden_region',
  attrs: { id, title },
});

const LONG =
  'A very long title that cannot fit on one line of a column of this width, however it is set';

function projection() {
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true, fontSize: 220 },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
              },
            },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            para('pa', 'Before the regions.'),
            region('r1', null),
            region('r2', 'Payroll'),
            region('r3', LONG),
            para('pz', 'After the regions.'),
          ],
        },
      ],
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function setup(readOnly: boolean) {
  const core = new EditorCore({ doc: projection() as never, schedule: (run) => queueMicrotask(run) });
  const parent = document.createElement('div');
  parent.style.cssText = 'width:900px;';
  document.body.append(parent);
  let failure: unknown = null;
  const view = mountPageView({
    host: core,
    parent,
    label: 'Document',
    frame: (run) => run(),
    readOnly,
    onError: (e) => (failure = e),
  });
  const scroller = parent.querySelector<HTMLElement>('.de-page-scroller')!;
  scroller.style.cssText = 'height:700px;overflow:auto;';
  scroller.dispatchEvent(new Event('scroll'));
  cleanups.push(() => {
    view.destroy();
    core.destroy();
    parent.remove();
  });
  return { core, view, parent, failure: () => failure };
}

describe.skipIf(!hasDom)('the placeholder of a hidden region in the page view (FE-141)', () => {
  for (const readOnly of [false, true]) {
    describe(readOnly ? 'in the read-only pages' : 'in the editable page view', () => {
      it('paints each region as a note named with its title', () => {
        const s = setup(readOnly);
        const notes = [...s.parent.querySelectorAll<HTMLElement>('.de-page .de-hidden-region')];
        expect(s.failure()).toBeNull();
        expect(notes.map((n) => n.getAttribute('role'))).toEqual(['note', 'note', 'note']);
        expect(notes.map((n) => n.getAttribute('aria-label'))).toEqual([
          'Hidden region',
          'Hidden region: Payroll',
          `Hidden region: ${LONG}`,
        ]);
        expect(notes.map((n) => n.textContent)).toEqual(['Hidden region', 'Payroll', LONG]);
      });

      it('gives every placeholder one size, whatever its title', () => {
        const s = setup(readOnly);
        const notes = [...s.parent.querySelectorAll<HTMLElement>('.de-page .de-hidden-region')];
        const sizes = notes.map((n) => {
          const r = n.getBoundingClientRect();
          return [Math.round(r.width * 100), Math.round(r.height * 100)];
        });
        expect(sizes).toHaveLength(3);
        expect(sizes[1]).toEqual(sizes[0]);
        expect(sizes[2]).toEqual(sizes[0]);
        expect(sizes[0]![1]).toBeGreaterThan(0);
        // 2.5 times the 11 pt font of Normal, in CSS pixels (96 per 72 points).
        expect(sizes[0]![1]! / 100).toBeCloseTo(2.5 * 11 * (96 / 72), 0);
      });

      it('holds nothing inside, and nothing in it is editable or selectable', () => {
        const s = setup(readOnly);
        for (const n of s.parent.querySelectorAll<HTMLElement>('.de-page .de-hidden-region')) {
          expect(n.childElementCount).toBe(0);
          expect(n.getAttribute('contenteditable')).toBe('false');
          expect(getComputedStyle(n).userSelect).toBe('none');
          expect(n.querySelector('input, textarea, [contenteditable="true"]')).toBeNull();
        }
      });
    });
  }

  it('paints a selection that runs across the regions as holding all of them', () => {
    const s = setup(false);
    const handle = s.core.attachPageView({ update() {}, focus() {} });
    cleanups.push(() => handle.detach());
    expect(handle.select({ blockId: 'pa', offset: 3 }, { blockId: 'pz', offset: 4 })).toBe(true);
    s.view.flush();
    const page = s.parent.querySelector<HTMLElement>('.de-page')!;
    const highlights = [...page.querySelectorAll<HTMLElement>('.de-selection')];
    const notes = [...page.querySelectorAll<HTMLElement>('.de-hidden-region')];
    // Two text lines and three placeholders.
    expect(highlights).toHaveLength(5);
    for (const note of notes) {
      const n = note.getBoundingClientRect();
      const covered = highlights.some((h) => {
        const r = h.getBoundingClientRect();
        return (
          Math.abs(r.left - n.left) < 1 &&
          Math.abs(r.top - n.top) < 1 &&
          Math.abs(r.width - n.width) < 1 &&
          Math.abs(r.height - n.height) < 1
        );
      });
      expect(covered).toBe(true);
    }
    // A selection inside one paragraph holds none of them.
    handle.select({ blockId: 'pa', offset: 1 }, { blockId: 'pa', offset: 6 });
    s.view.flush();
    expect(page.querySelectorAll('.de-selection')).toHaveLength(1);
  });
});
