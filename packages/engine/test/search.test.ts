/**
 * Find and replace in the body (02 §5.2; FE-059, FE-060), run on the headless core: no browser and
 * no view. The highlights themselves are drawn by the view and are not tested here; the core
 * supplies the matches, their count, the current one and the selection a navigation moves to.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { REMOTE } from '../src/meta.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';

/** A core on the styled document: the body has "Plain text", and a region the user may not change. */
function core(): DocumentCore {
  return new DocumentCore({ doc: styledDocument(), access: styledEditorAccess() });
}

/** The position just after the content of the paragraph `id`. */
function endOf(doc: PMNode, id: string): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.attrs['id'] === id) at = pos + 1 + node.content.size;
    return at < 0;
  });
  if (at < 0) throw new Error(`no node ${id}`);
  return at;
}

/** The text of the selection, read from the core's own state. */
function selectedText(c: DocumentCore): string {
  const { state } = internals(c);
  const { from, to } = state.selection;
  return state.doc.textBetween(from, to);
}

describe('find in the body (FE-059)', () => {
  it('finds every match in the body, in regions too, and changes no document', () => {
    const c = core();
    const before = c.getContent();
    const state = c.findText('text');
    expect(state).toEqual({ query: 'text', count: 2, current: null });
    expect(c.findState.get()).toEqual(state);
    expect(c.getContent()).toEqual(before);
    const results = c.findResults();
    expect(results.map((r) => r.index)).toEqual([0, 1]);
    expect(results.map((r) => r.blockId)).toEqual([STYLE_IDS.plain, STYLE_IDS.inRegion]);
    expect(results.map((r) => r.scope)).toEqual(['body', `region:${STYLE_IDS.region}`]);
    expect(results[0]!.before).toBe('Plain ');
    expect(results[0]!.after).toBe('');
    expect(results.every((r) => r.text === 'text')).toBe(true);
    c.destroy();
  });

  it('a match in a region the user may not change is found and listed (criterion 5, finding part)', () => {
    const c = core();
    c.findText('Protected');
    expect(c.findResults()).toHaveLength(1);
    expect(c.findResults()[0]!.scope).toBe(`region:${STYLE_IDS.region}`);
    c.destroy();
  });

  it('next and previous move the selection to each match, n of m counts from 1, and both wrap', () => {
    const c = core();
    c.findText('text');
    expect(c.findNext()).toBe(true);
    expect(c.findState.get().current).toBe(1);
    expect(selectedText(c)).toBe('text');
    const firstFrom = internals(c).state.selection.from;

    expect(c.findNext()).toBe(true);
    expect(c.findState.get().current).toBe(2);
    expect(internals(c).state.selection.from).toBeGreaterThan(firstFrom);

    // Next from the last match wraps to the first.
    expect(c.findNext()).toBe(true);
    expect(c.findState.get().current).toBe(1);
    expect(internals(c).state.selection.from).toBe(firstFrom);

    // Previous from the first match wraps to the last.
    expect(c.findPrevious()).toBe(true);
    expect(c.findState.get().current).toBe(2);
    expect(internals(c).state.selection.from).toBeGreaterThan(firstFrom);
    c.destroy();
  });

  it('a navigation changes the selection and no document', () => {
    const c = core();
    const before = c.getContent();
    c.findText('text');
    c.findNext();
    c.findNext();
    expect(c.getContent()).toEqual(before);
    c.destroy();
  });

  it('a match that spans text with different marks is found', () => {
    const env = styledDocument();
    const doc = structuredClone(env.doc) as {
      content: Array<{ type: string; content?: Array<{ type: string; content?: unknown[] }> }>;
    };
    const body = doc.content[1]!;
    const paragraph = body.content![0] as { content: unknown[] };
    // "Hel" plain, then "lo" in bold: one word across two text nodes with different marks.
    paragraph.content = [
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo', marks: [{ type: 'bold', attrs: { value: true } }] },
    ];
    const c = new DocumentCore({
      doc: { ...env, doc: doc as never },
      access: styledEditorAccess(),
    });
    expect(c.findText('Hello').count).toBe(1);
    expect(c.findResults()[0]!.text).toBe('Hello');
    expect(c.findResults()[0]!.blockId).toBe(STYLE_IDS.heading);
    c.destroy();
  });

  it('a remote change that adds or removes a match moves the count (criterion 4, count part)', () => {
    const c = core();
    const ic = internals(c);
    c.findText('text');
    expect(c.findState.get().count).toBe(2);
    // A remote commit adds "text" to the plain paragraph: one more match.
    ic.dispatch(
      ic.state.tr.insertText(' text', endOf(ic.state.doc, STYLE_IDS.plain)).setMeta(REMOTE, true),
    );
    expect(c.findState.get().count).toBe(3);
    // A remote commit removes the region's paragraph text: the region match goes.
    const at = endOf(ic.state.doc, STYLE_IDS.inRegion);
    const start = at - 'Protected text'.length;
    ic.dispatch(ic.state.tr.insertText('Protected', start, at).setMeta(REMOTE, true));
    expect(c.findState.get().count).toBe(2);
    expect(c.findResults().map((r) => r.scope)).toEqual(['body', 'body']);
    c.destroy();
  });

  it('an empty query, and a query with no match, leave nothing to navigate', () => {
    const c = core();
    expect(c.findText('zzz')).toEqual({ query: 'zzz', count: 0, current: null });
    expect(c.findNext()).toBe(false);
    expect(c.findPrevious()).toBe(false);
    expect(c.findText('')).toEqual({ query: '', count: 0, current: null });
    c.findText('text');
    c.clearFind();
    expect(c.findState.get()).toEqual({ query: '', count: 0, current: null });
    expect(c.findResults()).toEqual([]);
    c.destroy();
  });

  it('a match keeps its context of up to forty characters in the navigation list', () => {
    const c = core();
    c.findText('Plain');
    const [r] = c.findResults();
    expect(r!.before).toBe('');
    expect(r!.after).toBe(' text');
    c.destroy();
  });
});

describe('replace in the body (FE-060)', () => {
  it('replaces the current match in a scope the user may change, through the guard', () => {
    const c = core();
    c.findText('text');
    c.findNext();
    expect(c.replaceCurrent('words')).toEqual({ replaced: 1, skipped: 0 });
    const ic = internals(c);
    expect(ic.state.doc.textContent).toContain('Plain words');
    expect(c.findState.get().count).toBe(1);
    expect(c.refusal.get()).toBeNull();
    c.destroy();
  });

  it('refuses to replace the current match in a locked scope and leaves the document unchanged', () => {
    const c = core();
    c.findText('text');
    c.findNext();
    c.findNext();
    const before = c.getContent();
    expect(c.replaceCurrent('words')).toEqual({ replaced: 0, skipped: 1 });
    expect(c.getContent()).toEqual(before);
    expect(c.refusal.get()).toEqual({
      n: 1,
      reason: 'scope',
      scopes: [`region:${STYLE_IDS.region}`],
    });
    c.destroy();
  });

  it('replace all changes every editable match, skips the locked one, and counts both', () => {
    const c = core();
    c.findText('text');
    expect(c.replaceAll('words')).toEqual({ replaced: 1, skipped: 1 });
    const ic = internals(c);
    const texts = ic.state.doc.textContent;
    expect(texts).toContain('Plain words');
    expect(texts).toContain('Protected text');
    expect(c.refusal.get()).toEqual({
      n: 1,
      reason: 'scope',
      scopes: [`region:${STYLE_IDS.region}`],
    });
    c.destroy();
  });

  it('when every match is locked, replace all leaves the document unchanged and reports zero replaced', () => {
    const c = core();
    c.findText('Protected');
    const before = c.getContent();
    expect(c.replaceAll('x')).toEqual({ replaced: 0, skipped: 1 });
    expect(c.getContent()).toEqual(before);
    c.destroy();
  });

  it('replace all with no skipped match records no refusal', () => {
    const c = core();
    c.findText('Plain');
    expect(c.replaceAll('Plainer')).toEqual({ replaced: 1, skipped: 0 });
    expect(c.refusal.get()).toBeNull();
    c.destroy();
  });

  it('one undo takes back a whole replace all', () => {
    const c = core();
    const before = c.getContent();
    c.findText('text');
    c.replaceAll('words');
    expect(c.getContent()).not.toEqual(before);
    expect(c.run('undo')).toBe(true);
    expect(c.getContent()).toEqual(before);
    c.destroy();
  });
});
