/**
 * The navigation pane's core side (UX-020). Criterion 2: the outline follows local and remote
 * changes, reuses what did not change and tells its subscribers nothing when a keystroke leaves the
 * headings as they were. Criterion 3: the find the pane's search runs on, with the option "match
 * case", the context of each match, and choosing a result as a selection. Node.js, headless core.
 */
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { findDecorations } from '../src/search-highlight.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';
import { caret, microtask, posOf, type as typeText } from './support.ts';

const core = () =>
  new DocumentCore({
    doc: styledDocument(),
    access: styledEditorAccess(),
    schedule: microtask,
  });

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** The styled document with `n` more plain paragraphs and a heading every 50th, after the others. */
function bigCore(n: number): DocumentCore {
  const env = styledDocument();
  const body = env.doc.content!.find((c) => c.type === 'body')!;
  const extra = [];
  for (let i = 0; i < n; i++) {
    const heading = i % 50 === 0;
    extra.push({
      type: 'paragraph',
      attrs: { id: `pBulk${String(i).padStart(11, '0')}`, style: heading ? 'Heading2' : null },
      content: [
        { type: 'text', text: heading ? `Section ${i / 50}` : `Body text of paragraph ${i}.` },
      ],
    });
  }
  body.content = [...body.content!, ...extra];
  return new DocumentCore({ doc: env, access: styledEditorAccess(), schedule: microtask });
}

describe('UX-020 criterion 2: the outline follows changes without work on the typing path', () => {
  it('tells nobody and keeps the same list when typing leaves the headings as they were', async () => {
    const c = bigCore(600);
    await flush();
    const before = c.outline.get();
    let told = 0;
    c.outline.subscribe(() => told++);
    caret(c, 'pBulk00000000007', 'end');
    for (const ch of 'abc') typeText(c, ch);
    await flush();
    expect(told).toBe(0);
    expect(c.outline.get()).toBe(before);
    expect(before.length).toBe(1 + 12);
  });

  it('updates once, in the next notification pass, when a heading is typed in, and reuses the other items', async () => {
    const c = bigCore(600);
    await flush();
    const before = c.outline.get();
    let told = 0;
    c.outline.subscribe(() => told++);
    caret(c, 'pBulk00000000050', 'end');
    for (const ch of ' (new)') typeText(c, ch);
    // Six keystrokes in one frame are one notification; nothing was told inside the keystrokes.
    expect(told).toBe(0);
    await flush();
    expect(told).toBe(1);
    const after = c.outline.get();
    const changed = after.find((i) => i.id === 'pBulk00000000050')!;
    expect(changed.text).toBe('Section 1 (new)');
    for (const item of before) {
      if (item.id === changed.id) continue;
      expect(after.find((i) => i.id === item.id)).toBe(item);
    }
  });

  it('follows a style change that adds and removes a heading, keeping the order', async () => {
    const c = core();
    caret(c, STYLE_IDS.plain, 0);
    c.run('paragraphStyle', { style: 'Heading2' });
    await flush();
    expect(c.outline.get().map((i) => i.id)).toEqual([STYLE_IDS.heading, STYLE_IDS.plain]);
    caret(c, STYLE_IDS.plain, 0);
    c.run('paragraphStyle', { style: 'Normal' });
    await flush();
    expect(c.outline.get().map((i) => i.id)).toEqual([STYLE_IDS.heading]);
  });
});

describe('UX-020 criterion 3: the search the pane runs', () => {
  it('lists each match with its block and the text before and after, and counts them', () => {
    const c = core();
    const state = c.findText('text');
    const results = c.findResults();
    expect(state.count).toBe(results.length);
    expect(results.length).toBeGreaterThan(1);
    const plain = results.find((r) => r.blockId === STYLE_IDS.plain)!;
    expect(plain.before).toBe('Plain ');
    expect(plain.text).toBe('text');
    expect(plain.after).toBe('');
  });

  it('keeps case significant by default and ignores it when the pane asks', () => {
    const c = core();
    expect(c.findText('PLAIN').count).toBe(0);
    expect(c.findState.get().matchCase).toBeUndefined();
    const state = c.findText('PLAIN', { matchCase: false });
    expect(state.count).toBe(1);
    expect(state.matchCase).toBe(false);
    // The text and the context are the document's, not the query's.
    expect(c.findResults()[0]).toMatchObject({ text: 'Plain', before: '', after: ' text' });
    expect(c.findText('plain', { matchCase: true }).count).toBe(0);
  });

  it('draws the same matches as it counts when case is ignored, and recounts after a change', () => {
    const c = core();
    c.findText('plain', { matchCase: false });
    const f = c.findState.get();
    const doc = internals(c).state.doc;
    const ignoring = { query: f.query, current: f.current, matchCase: false };
    expect(findDecorations(doc, ignoring).find()).toHaveLength(1);
    expect(findDecorations(doc, { query: f.query, current: f.current }).find()).toHaveLength(0);
    caret(c, STYLE_IDS.plain, 'end');
    typeText(c, ' PLAIN');
    expect(c.findState.get().count).toBe(2);
  });

  it('selects the chosen match, makes it current and scrolls it into view', () => {
    const c = core();
    c.findText('text');
    const target = c.findResults().find((r) => r.blockId === STYLE_IDS.plain)!;
    const i = internals(c);
    let scrolled = false;
    i.onTransaction((tr) => {
      scrolled = scrolled || tr.scrolledIntoView;
    });
    const expected = { blockId: target.blockId, text: target.text };
    expect(c.selectFindMatch(target.index, expected)).toBe(true);
    const { from, to } = i.state.selection;
    expect(i.state.doc.textBetween(from, to)).toBe('text');
    expect(from).toBeGreaterThan(posOf(i.state.doc, STYLE_IDS.plain));
    expect(scrolled).toBe(true);
    expect(c.findState.get().current).toBe(target.index + 1);
  });

  it('refuses a result that is gone or that now names other text', () => {
    const c = core();
    c.findText('text');
    const plain = c.findResults().find((r) => r.blockId === STYLE_IDS.plain)!;
    expect(c.selectFindMatch(99)).toBe(false);
    expect(c.selectFindMatch(plain.index, { blockId: STYLE_IDS.quote, text: 'text' })).toBe(false);
    // The list went stale: the text the result named is no longer there.
    c.findText('Plain');
    const stale = c.findResults()[0]!;
    const i = internals(c);
    const at = posOf(i.state.doc, STYLE_IDS.plain) + 1;
    i.dispatch(i.state.tr.insertText('Other', at, at + 5));
    const expected = { blockId: stale.blockId, text: stale.text };
    expect(c.selectFindMatch(stale.index, expected)).toBe(false);
  });
});
