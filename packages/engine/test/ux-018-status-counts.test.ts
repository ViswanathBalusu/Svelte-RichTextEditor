/**
 * The status bar's counts and language in the editing core (UX-018 criteria 1 and 3). The word count
 * follows the body, leaves out footnotes, headers and definitions, and is made by a timer, never by
 * a keystroke. The language at the selection is the `lang` mark, the document's default is its own
 * view, and setting it is a formatting command that passes the guard. Node.js.
 */
import { TextSelection } from 'prosemirror-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { countBodyWords, WordCounter, wordsIn } from '../src/word-count.ts';
import { SPIKE_IDS, editorAccess, spikeDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

function select(core: DocumentCore, id: string, from: number, to: number): void {
  const i = internals(core);
  const at = posOf(i.state.doc, id) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + from, at + to)));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('counting words (UX-018 criterion 1)', () => {
  it('counts words as the language sees them, not the spaces', () => {
    expect(wordsIn('')).toBe(0);
    expect(wordsIn('   ')).toBe(0);
    expect(wordsIn('one two  three')).toBe(3);
    expect(wordsIn('Hello, world. — 42 times!')).toBe(4);
    expect(wordsIn("don't stop")).toBe(2);
  });

  it('counts the body of the document, with its regions, and not the footnote, header or definitions', () => {
    const doc = internals(new DocumentCore({ doc: spikeDocument(), schedule: microtask })).state
      .doc;
    const words = countBodyWords(doc);
    const text = (id: string) => doc.nodeAt(posOf(doc, id))!.textContent;
    // The footnote's words are in `textContent` of the intro, and so are the header's in its own
    // story, but neither is in the count.
    expect(text(SPIKE_IDS.intro)).toContain('Footnote text');
    expect(text(SPIKE_IDS.headerParagraph).length).toBeGreaterThan(0);
    // "Scope" (1), "Alpha bravo charlie delta echo, page" with a footnote mark and a page-number
    // field, which are not words (6), the legal region's paragraph (6), "Remote target paragraph."
    // (3) and "Last paragraph." (2).
    expect(words).toBe(18);
  });
});

describe('the count is made off the typing path (UX-018 criterion 1)', () => {
  it('a burst of changes makes one timer and no counting until it fires', () => {
    const count = vi.fn(() => 7);
    const published: number[] = [];
    const counter = new WordCounter(count, (n) => published.push(n), 400);
    for (let i = 0; i < 1000; i++) counter.changed();
    expect(count).not.toHaveBeenCalled();
    vi.advanceTimersByTime(399);
    expect(count).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(count).toHaveBeenCalledTimes(1);
    expect(published).toEqual([7]);
    // Nothing is waiting after it; the next change makes the next timer.
    vi.advanceTimersByTime(10_000);
    expect(count).toHaveBeenCalledTimes(1);
    counter.changed();
    vi.advanceTimersByTime(400);
    expect(count).toHaveBeenCalledTimes(2);
  });

  it('on the core, typing leaves the count as it was until the timer fires, then it follows', async () => {
    const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    expect(c.words.get()).toBe(null);
    vi.advanceTimersByTime(400);
    const start = c.words.get();
    expect(start).toBeGreaterThan(0);

    select(c, SPIKE_IDS.last, 0, 0);
    const i = internals(c);
    for (const word of ['new', 'words', 'here']) i.dispatch(i.state.tr.insertText(`${word} `));
    // Typed, and not counted yet.
    expect(c.words.get()).toBe(start);
    vi.advanceTimersByTime(400);
    expect(c.words.get()).toBe(start! + 3);
    c.destroy();
  });

  it('deleting words lowers the count', () => {
    const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    vi.advanceTimersByTime(400);
    const start = c.words.get()!;
    const i = internals(c);
    const node = i.state.doc.nodeAt(posOf(i.state.doc, SPIKE_IDS.last))!;
    const at = posOf(i.state.doc, SPIKE_IDS.last);
    i.dispatch(i.state.tr.delete(at + 1, at + node.nodeSize - 1));
    vi.advanceTimersByTime(400);
    expect(c.words.get()!).toBeLessThan(start);
    c.destroy();
  });
});

describe('the language (UX-018 criterion 3)', () => {
  function editor(): DocumentCore {
    return new DocumentCore({ doc: spikeDocument(), access: editorAccess(), schedule: microtask });
  }

  it('is the lang mark at the selection, and null where there is none', () => {
    const c = editor();
    select(c, SPIKE_IDS.last, 0, 4);
    expect(c.run('lang', { lang: 'fr-FR' })).toBe(true);
    expect(c.selection.get().lang).toBe('fr-FR');
    select(c, SPIKE_IDS.intro, 0, 3);
    expect(c.selection.get().lang).toBe(null);
    select(c, SPIKE_IDS.last, 1, 2);
    expect(c.selection.get().lang).toBe('fr-FR');
    // Null removes the mark: the document's default applies again.
    select(c, SPIKE_IDS.last, 0, 4);
    expect(c.run('lang', { lang: null })).toBe(true);
    expect(c.selection.get().lang).toBe(null);
  });

  it("has the document's default language as a view", () => {
    const c = editor();
    expect(c.language.get()).toEqual(expect.any(String));
  });

  it('is refused where the user may not change the text', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess({
        docRole: 'commenter',
        caps: ['view', 'comment'],
        scopes: { doc: ['view'], body: ['view', 'comment'], defs: ['view'] },
      }),
      schedule: microtask,
    });
    select(c, SPIKE_IDS.last, 0, 4);
    expect(c.queryCommand('lang', { lang: 'fr-FR' }).enabled).toBe(false);
    expect(c.run('lang', { lang: 'fr-FR' })).toBe(false);
    expect(c.selection.get().lang).toBe(null);
  });

  it('rejects a tag that is not a BCP 47 tag', () => {
    const c = editor();
    select(c, SPIKE_IDS.last, 0, 4);
    expect(c.run('lang', { lang: 'not a tag' })).toBe(false);
  });
});
