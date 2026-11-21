/**
 * The parts of the page view that need no DOM (FE-101, FE-098): the edit a bridge change stands for,
 * the key names, the break rule, the text of the lines, and the choice of the view. The page itself is
 * `e2e/fe-101-page-view.spec.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike } from '../../layout/src/flow.ts';
import { layoutFlow } from '../../layout/src/engine.ts';
import { firstFitBreaker } from '../../layout/src/items.ts';
import { fixedWidthMeasurer } from '../../layout/src/measure.ts';
import { FlowText } from '../src/page-view/flow-text.ts';
import { diffText, keymapName, wordBoundary } from '../src/page-view/page-view.ts';
import { placeholderBreaks } from '../src/page-view/providers.ts';
import { fallbackFor } from '../src/kernel-fallback.ts';
import { selectView } from '../src/view-select.ts';

describe('diffText: an input event is one replaced range', () => {
  it('finds an insertion, a deletion and a replacement', () => {
    expect(diffText('abc', 'abXc')).toEqual({ at: 2, removed: 0, inserted: 'X' });
    expect(diffText('abXc', 'abc')).toEqual({ at: 2, removed: 1, inserted: '' });
    expect(diffText('abc', 'aZc')).toEqual({ at: 1, removed: 1, inserted: 'Z' });
    expect(diffText('abc', 'abc')).toEqual({ at: 3, removed: 0, inserted: '' });
  });

  it('does not count the same letters twice when text repeats', () => {
    // "aa" to "aaa": one letter inserted, wherever the browser put it.
    const d = diffText('aa', 'aaa');
    expect(d.removed).toBe(0);
    expect(d.inserted).toBe('a');
    expect('aa'.slice(0, d.at) + d.inserted + 'aa'.slice(d.at + d.removed)).toBe('aaa');
  });

  it('applies back to the new text for any pair', () => {
    const pairs: Array<[string, string]> = [
      ['', 'hello'],
      ['hello', ''],
      ['hello world', 'hello brave new world'],
      ['日本語', '日本の語'],
      ['ab', 'ba'],
    ];
    for (const [a, b] of pairs) {
      const d = diffText(a, b);
      expect(a.slice(0, d.at) + d.inserted + a.slice(d.at + d.removed)).toBe(b);
    }
  });
});

describe('keymapName: the keys the core binds', () => {
  const key = (k: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...extra,
    }) as KeyboardEvent;

  it('names the editing keys in prosemirror-keymap notation', () => {
    expect(keymapName(key('Enter'))).toBe('Enter');
    expect(keymapName(key('Enter', { shiftKey: true }))).toBe('Shift-Enter');
    expect(keymapName(key('Backspace'))).toBe('Backspace');
    expect(keymapName(key('b', { ctrlKey: true }))).toBe('Mod-b');
    expect(keymapName(key('Tab', { shiftKey: true }))).toBe('Shift-Tab');
    expect(keymapName(key('Home', { ctrlKey: true }))).toBe('Mod-Home');
  });

  it('leaves plain letters and movement to the bridge and the layout', () => {
    expect(keymapName(key('a'))).toBeNull();
    expect(keymapName(key('Home'))).toBeNull();
    expect(keymapName(key('ArrowLeft'))).toBeNull();
  });
});

describe('wordBoundary', () => {
  it('moves to the start of the word before and past the word after', () => {
    const text = 'one two  three';
    expect(wordBoundary(text, 7, 'left')).toBe(4);
    expect(wordBoundary(text, 4, 'left')).toBe(0);
    expect(wordBoundary(text, 0, 'right')).toBe(4);
    expect(wordBoundary(text, 4, 'right')).toBe(9);
    expect(wordBoundary(text, 14, 'right')).toBe(14);
  });
});

describe('the placeholder break rule', () => {
  it('breaks after blanks, after a hyphen between letters and between ideographs', () => {
    expect(placeholderBreaks.opportunities('ab cd  ef')).toEqual([3, 7]);
    expect(placeholderBreaks.opportunities('well-known')).toEqual([5]);
    expect(placeholderBreaks.opportunities('日本語')).toEqual([1, 2]);
    expect(placeholderBreaks.opportunities('-x')).toEqual([]);
  });

  it('offers offsets in order, each inside the text', () => {
    const text = 'a b-c 日本 d';
    const offsets = placeholderBreaks.opportunities(text);
    expect([...offsets].sort((a, b) => a - b)).toEqual([...offsets]);
    for (const o of offsets) expect(o).toBeGreaterThan(0);
    for (const o of offsets) expect(o).toBeLessThanOrEqual(text.length);
  });
});

describe('FlowText: the painted runs are the measured text', () => {
  const envelope: CdmEnvelopeLike = {
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
              attrs: {
                id: 'Normal',
                kind: 'paragraph',
                name: 'Normal',
                builtIn: true,
                fontFamily: 'Noto Serif',
                fontSize: 220,
              },
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
            {
              type: 'paragraph',
              attrs: { id: 'p1', style: 'Normal' },
              content: [
                { type: 'text', text: 'Plain ' },
                { type: 'text', text: 'bold', marks: [{ type: 'bold', attrs: { value: true } }] },
                { type: 'text', text: ' end' },
              ],
            },
          ],
        },
      ],
    },
  };

  it('gives one run for each mark change, joined into the line text', () => {
    const measurer = fixedWidthMeasurer();
    const flow = toFlow(envelope);
    const text = new FlowText(flow, measurer);
    const runs = text.runs('p1', 0, 14)!;
    expect(runs.map((r) => r.text).join('')).toBe('Plain bold end');
    expect(runs.some((r) => r.bold && r.text === 'bold')).toBe(true);
    // A range inside the paragraph gives only that part.
    expect(
      text
        .runs('p1', 6, 10)!
        .map((r) => r.text)
        .join(''),
    ).toBe('bold');
    expect(text.runs('missing', 0, 1)).toBeNull();
  });

  it('measures a range with the measurer the layout used, so the caret sits where the text is', () => {
    const measurer = fixedWidthMeasurer();
    const flow = toFlow(envelope);
    const text = new FlowText(flow, measurer);
    const result = layoutFlow(flow, {
      measurer,
      breaks: placeholderBreaks,
      lineBreaker: firstFitBreaker,
    });
    const line = result.tree.pages[0]!.fragments[0]!;
    expect(line.kind).toBe('paragraph');
    const whole = text.width('p1', 0, 14);
    expect(whole).toBeCloseTo(
      text.width('p1', 0, 6) + text.width('p1', 6, 10) + text.width('p1', 10, 14),
      6,
    );
  });
});

describe('which browsers are offered the page view (S5)', () => {
  it('offers it with canvas measurement and not in Firefox', () => {
    expect(fallbackFor('Mozilla/5.0 Chrome/150.0 Safari/537.36')).toBe('canvas-measurement');
    expect(fallbackFor('Mozilla/5.0 (X11; rv:150.0) Gecko/20100101 Firefox/150.0')).toBe(
      'web-view',
    );
  });

  it('gives the page view for print only when it is offered, and never on touch (FE-113)', () => {
    expect(selectView('print', { touch: false, pageViewAvailable: true })).toEqual({
      view: 'print',
      fallback: false,
    });
    expect(selectView('print', { touch: false, pageViewAvailable: false })).toEqual({
      view: 'web',
      fallback: true,
    });
    expect(selectView('print', { touch: true, pageViewAvailable: true })).toEqual({
      view: 'web',
      fallback: true,
    });
  });
});

describe('the page view keeps to ADR 0380', () => {
  const dir = join(import.meta.dirname, '../src/page-view');
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(dir, f), 'utf8'));

  it('does not use EditContext in the first release (FE-098 criterion 5)', () => {
    for (const source of sources)
      expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/EditContext/);
  });

  it('never imports ProseMirror: the core is reached through its own handle', () => {
    for (const source of sources) expect(source).not.toMatch(/from 'prosemirror-/);
  });
});
