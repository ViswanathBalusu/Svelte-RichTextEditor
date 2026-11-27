/**
 * FE-129 criterion 2: tab stops set with the paragraph format command are stored in `tabs`, and a
 * tab in the text advances to the stop 03 §7.4 picks.
 *
 * The first suite is pure and runs everywhere (the choice of stop and the width of the tab). The
 * second mounts the body view and measures where the text after a tab starts; it runs in real
 * browser engines through `pnpm vitest run --project browser <this file>` and is skipped in
 * Node.js, where there is no DOM.
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it, vi } from 'vitest';
import { styledEditorAccess } from '../../test/fixtures.ts';
import { bodyRange } from '../body.ts';
import { spikeDocument } from '../spike-document.ts';
import { internals } from '../testing.ts';
import { leaderCss, nextTabStop, tabWidth, TAB_DRAWN, type TabLayout } from './tab-stops-view.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';
// 2.5 inches, 240 CSS pixels. The first body paragraph is a heading at 32 px, and AB with CDEF in a wide
// serif (DejaVu Serif on Linux) take 152 px, so a right stop at 1.5 inches (144 px) had no room there.
const STOP_PX = 240;
const nearStop = (x: number): boolean => Math.abs(x - STOP_PX) <= 1.5;

const layout = (over: Partial<TabLayout> = {}): TabLayout => ({
  stops: [],
  indentLeft: 0,
  indentFirstLine: 0,
  defaultTabStop: 720,
  ...over,
});

describe('the stop a tab moves to (03 §7.4)', () => {
  it('is the first explicit stop to the right of the tab', () => {
    const l = layout({
      stops: [
        { position: 1000, align: 'left', leader: 'none' },
        { position: 3000, align: 'right', leader: 'dot' },
      ],
    });
    expect(nextTabStop(l, 0)).toMatchObject({ position: 1000, kind: 'explicit' });
    expect(nextTabStop(l, 1000)).toMatchObject({ position: 3000, align: 'right', leader: 'dot' });
  });

  it('falls to the next multiple of the default interval past the last stop', () => {
    const l = layout({ stops: [{ position: 1000, align: 'left', leader: 'none' }] });
    // Past the only stop: 3000 is a multiple of 720 (4 x 720 = 2880, so the next is 3600).
    expect(nextTabStop(l, 3000)).toMatchObject({ position: 3600, kind: 'default' });
    // Before the stop, the explicit stop is the nearest candidate: the default stops to its left
    // are cleared (the default candidate lies past the last explicit stop).
    expect(nextTabStop(l, 100)).toMatchObject({ position: 1000, kind: 'explicit' });
    expect(nextTabStop(l, 1000)).toMatchObject({ position: 1440, kind: 'default' });
  });

  it('takes the left indent of a hanging indent when it is the nearest', () => {
    const l = layout({
      stops: [{ position: 5000, align: 'left', leader: 'none' }],
      indentLeft: 500,
      indentFirstLine: -500,
    });
    expect(nextTabStop(l, 0)).toMatchObject({ position: 500, kind: 'hanging' });
    // Once past the hanging stop the explicit stop is next, not a default stop to its left.
    expect(nextTabStop(l, 500)).toMatchObject({ position: 5000, kind: 'explicit' });
  });

  it('lets an explicit stop win over the hanging stop and that over a default stop at one place', () => {
    const l = layout({
      stops: [{ position: 720, align: 'right', leader: 'none' }],
      indentLeft: 720,
      indentFirstLine: -720,
    });
    expect(nextTabStop(l, 0)).toMatchObject({ position: 720, kind: 'explicit', align: 'right' });
    const h = layout({ indentLeft: 720, indentFirstLine: -720 });
    expect(nextTabStop(h, 0)).toMatchObject({ position: 720, kind: 'hanging' });
  });

  it('has no stop when the interval is 0 and no explicit stop lies ahead', () => {
    expect(nextTabStop(layout({ defaultTabStop: 0 }), 10)).toBeNull();
  });
});

describe('the width of a tab', () => {
  const stop = (align: 'left' | 'center' | 'right' | 'decimal') =>
    ({ position: 3000, align, leader: 'none', kind: 'explicit' }) as const;
  const seg = { width: 600, beforeDecimal: 250 };

  it('starts the segment at a left stop, ends it at a right stop, centres it on a centre stop', () => {
    expect(tabWidth(stop('left'), 1000, seg)).toBe(2000);
    expect(tabWidth(stop('right'), 1000, seg)).toBe(1400);
    expect(tabWidth(stop('center'), 1000, seg)).toBe(1700);
    expect(tabWidth(stop('center'), 1000, { width: 601, beforeDecimal: 0 })).toBe(1700);
  });

  it('puts the decimal separator at a decimal stop, or the end of a segment that has none', () => {
    expect(tabWidth(stop('decimal'), 1000, seg)).toBe(1750);
    expect(tabWidth(stop('decimal'), 1000, { width: 600, beforeDecimal: 600 })).toBe(1400);
  });

  it('starts a segment that does not fit at the current position', () => {
    expect(tabWidth(stop('right'), 1000, { width: null, beforeDecimal: null })).toBe(0);
    expect(tabWidth(stop('right'), 1000, { width: 5000, beforeDecimal: 5000 })).toBe(0);
  });

  it('draws a leader for every kind but none', () => {
    expect(leaderCss('none')).toBeNull();
    for (const kind of ['dot', 'hyphen', 'underscore', 'middleDot', 'heavy'] as const)
      expect(leaderCss(kind)).toContain('currentColor');
  });
});

function newCore(): EditorCore {
  return new EditorCore({
    doc: spikeDocument() as never,
    access: styledEditorAccess(),
    schedule: (run) => queueMicrotask(run),
  });
}

/** Puts `before`, a tab and `after` at the start of the first body paragraph, caret inside. */
function insertTabbed(core: EditorCore, before: string, after: string): void {
  const i = internals(core);
  const pos = bodyRange(i.state.doc).start + 1;
  const { schema } = i.state;
  // The whole content of the paragraph is replaced, so that the segment after the tab is `after`.
  const paragraph = i.state.doc.resolve(pos).parent;
  i.dispatch(
    i.state.tr.replaceWith(pos, pos + paragraph.content.size, [
      schema.text(before),
      schema.nodes['tab']!.create(),
      schema.text(after),
    ]),
  );
  const next = internals(core);
  next.dispatch(next.state.tr.setSelection(TextSelection.create(next.state.doc, pos)));
}

describe.skipIf(!isBrowser)('the body view draws tabs at the stops (FE-129 criterion 2)', () => {
  /** The paragraph that holds the tab, its tab and the left of the margin it is measured from. */
  function find(host: HTMLElement): { p: HTMLElement; tab: HTMLElement; origin: number } {
    const tab = host.querySelector<HTMLElement>('.de-doc-tab')!;
    const p = tab.closest<HTMLElement>('p, h1, h2, h3')!;
    const margin = Number.parseFloat(getComputedStyle(p).marginLeft) || 0;
    return { p, tab, origin: p.getBoundingClientRect().left - margin };
  }

  /** The left and right edge of the text of `needle` inside `p`. */
  function edges(p: HTMLElement, needle: string): { left: number; right: number } {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n as Text).data.indexOf(needle);
      if (at < 0) continue;
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + needle.length);
      const box = r.getBoundingClientRect();
      return { left: box.left, right: box.right };
    }
    throw new Error(`no text ${needle}`);
  }

  async function withTab<T>(
    before: string,
    after: string,
    tabs: unknown,
    run: (host: HTMLElement) => Promise<T> | T,
  ): Promise<T> {
    const host = document.createElement('div');
    host.style.width = '380px';
    document.body.append(host);
    const core = newCore();
    const unmount = core.mountBody(host);
    try {
      insertTabbed(core, before, after);
      expect(core.exec('setParagraphFormat', { paragraphFormat: { tabs } })).toBe(true);
      return await run(host);
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  }

  const STOP = STOP_PX * 15; // twips

  it('starts the text after a tab at a left stop and draws its leader', async () => {
    await withTab('AB', 'CD', [{ position: STOP, align: 'left', leader: 'dot' }], async (host) => {
      await vi.waitFor(() => expect(find(host).tab.getAttribute(TAB_DRAWN)).toBe('explicit'));
      const { p, tab, origin } = find(host);
      expect(edges(p, 'CD').left - origin).toSatisfy(nearStop);
      expect(tab.style.display).toBe('inline-block');
      expect(getComputedStyle(tab).backgroundImage).toContain('radial-gradient');
    });
  });

  it('ends the text at a right stop and centres it on a centre stop', async () => {
    await withTab(
      'AB',
      'CDEF',
      [{ position: STOP, align: 'right', leader: 'none' }],
      async (host) => {
        await vi.waitFor(() => expect(find(host).tab.hasAttribute(TAB_DRAWN)).toBe(true));
        // The tab is drawn again when the fonts have loaded or the width settles, so the edge is waited for.
        await vi.waitFor(() => {
          const { p, origin } = find(host);
          expect(edges(p, 'CDEF').right - origin).toSatisfy(nearStop);
        });
        expect(getComputedStyle(find(host).tab).backgroundImage).toBe('none');
      },
    );
    await withTab(
      'AB',
      'CDEF',
      [{ position: STOP, align: 'center', leader: 'none' }],
      async (host) => {
        await vi.waitFor(() => expect(find(host).tab.hasAttribute(TAB_DRAWN)).toBe(true));
        await vi.waitFor(() => {
          const { p, origin } = find(host);
          const { left, right } = edges(p, 'CDEF');
          expect((left + right) / 2 - origin).toSatisfy(nearStop);
        });
      },
    );
  });

  it('puts the decimal separator at a decimal stop', async () => {
    await withTab(
      'AB',
      '12.50',
      [{ position: STOP, align: 'decimal', leader: 'none' }],
      async (host) => {
        await vi.waitFor(() => expect(find(host).tab.hasAttribute(TAB_DRAWN)).toBe(true));
        await vi.waitFor(() => {
          const { p, origin } = find(host);
          expect(edges(p, '12').right - origin).toSatisfy(nearStop);
        });
      },
    );
  });

  it('keeps the browser tab of a paragraph with no stops, and gives it back when they are cleared', async () => {
    await withTab('AB', 'CD', [{ position: STOP, align: 'left', leader: 'none' }], async (host) => {
      await vi.waitFor(() => expect(find(host).tab.hasAttribute(TAB_DRAWN)).toBe(true));
    });
    const host = document.createElement('div');
    document.body.append(host);
    const core = newCore();
    const unmount = core.mountBody(host);
    try {
      insertTabbed(core, 'AB', 'CD');
      await vi.waitFor(() => expect(host.querySelector('.de-doc-tab')).not.toBeNull());
      expect(host.querySelector('.de-doc-tab')!.hasAttribute(TAB_DRAWN)).toBe(false);
      expect(
        core.exec('setParagraphFormat', {
          paragraphFormat: { tabs: [{ position: STOP, align: 'left', leader: 'none' }] },
        }),
      ).toBe(true);
      await vi.waitFor(() =>
        expect(host.querySelector('.de-doc-tab')!.hasAttribute(TAB_DRAWN)).toBe(true),
      );
      expect(core.exec('setParagraphFormat', { paragraphFormat: { tabs: null } })).toBe(true);
      await vi.waitFor(() =>
        expect(host.querySelector('.de-doc-tab')!.hasAttribute(TAB_DRAWN)).toBe(false),
      );
      expect((host.querySelector('.de-doc-tab') as HTMLElement).style.width).toBe('');
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
