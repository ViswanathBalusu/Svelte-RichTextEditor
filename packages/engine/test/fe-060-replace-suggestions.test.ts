/**
 * FE-060 criterion 5: in suggestion mode every replacement is a suggestion (owner decision 46 of
 * docs/owner-decisions-2026-11-15.md), Replace and Replace all alike. The match stays, marked as a
 * deletion by the user, and the new text follows it, marked as an insertion. One undo takes back a
 * whole Replace all; accepting every suggestion leaves the replaced text, rejecting leaves the
 * original. A match in a scope the user may not change is skipped and counted, as outside suggestion
 * mode. Text inserts create no nodes, so the identifier plugin has nothing to generate for them.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { REMOTE } from '../src/meta.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';
import { microtask } from './support.ts';

function endOf(doc: PMNode, id: string): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.attrs['id'] === id) at = pos + 1 + node.content.size;
    return at < 0;
  });
  if (at < 0) throw new Error(`no node ${id}`);
  return at;
}

/** A reviewer (suggestion mode on) in the styled document, with one more "text" in the body. */
function reviewer(): DocumentCore {
  let n = 0;
  const c = new DocumentCore({
    doc: styledDocument(),
    access: styledEditorAccess(),
    schedule: microtask,
    mode: 'review',
    user: 'alice',
    generateId: () => `s${String(++n).padStart(15, '0')}`,
  });
  const ic = internals(c);
  ic.dispatch(
    ic.state.tr.insertText(' text', endOf(ic.state.doc, STYLE_IDS.plain)).setMeta(REMOTE, true),
  );
  return c;
}

/** The runs of a paragraph: text and the suggestion kinds with their users and identifiers. */
function runsOf(c: DocumentCore, id: string) {
  const doc = internals(c).state.doc;
  let paragraph: PMNode | null = null;
  doc.descendants((node) => {
    if (paragraph === null && node.attrs['id'] === id) paragraph = node;
    return paragraph === null;
  });
  const runs: { text: string; kinds: string[]; users: string[]; ids: string[] }[] = [];
  (paragraph as PMNode | null)?.forEach((child) => {
    const s = child.marks.filter((m) => ['ins', 'del', 'fmt'].includes(m.type.name));
    runs.push({
      text: child.text ?? '',
      kinds: s.map((m) => m.type.name),
      users: s.map((m) => String(m.attrs['user'])),
      ids: s.map((m) => String(m.attrs['id'])),
    });
  });
  return runs;
}

const textOf = (c: DocumentCore, id: string) =>
  runsOf(c, id)
    .map((r) => r.text)
    .join('');

describe('Replace all in suggestion mode (FE-060 criterion 5, decision 46)', () => {
  it('makes each replacement a suggestion and skips what the user may not change', () => {
    const c = reviewer();
    c.findText('text');
    expect(c.findState.get().count).toBe(3); // two in the body, one in the locked region
    const report = c.replaceAll('words');
    expect(report).toEqual({ replaced: 2, skipped: 1 });
    expect(c.replaced.get()).toEqual({ n: 1, all: true, replaced: 2, skipped: 1 });
    const runs = runsOf(c, STYLE_IDS.plain);
    // Each match stays as a deletion, and the new text follows it as an insertion.
    expect(runs.map((r) => [r.text, r.kinds.join('+')])).toEqual([
      ['Plain ', ''],
      ['text', 'del'],
      ['words', 'ins'],
      [' ', ''],
      ['text', 'del'],
      ['words', 'ins'],
    ]);
    for (const r of runs.filter((x) => x.kinds.length > 0)) expect(r.users).toEqual(['alice']);
    // Two replacements are two insertions, with their own identifiers.
    const insIds = runs.filter((r) => r.kinds.includes('ins')).map((r) => r.ids[0]);
    expect(new Set(insIds).size).toBe(2);
    // The locked region is untouched, and its match is the one left.
    expect(textOf(c, STYLE_IDS.inRegion)).toBe('Protected text');
    c.destroy();
  });

  it('takes the whole of Replace all back with one undo', () => {
    const c = reviewer();
    c.findText('text');
    const before = internals(c).state.doc;
    c.replaceAll('words');
    expect(internals(c).state.doc).not.toBe(before);
    expect(c.run('undo')).toBe(true);
    expect(internals(c).state.doc.eq(before)).toBe(true);
    c.destroy();
  });

  it('is settled by accepting or rejecting the suggestions', () => {
    const accepted = reviewer();
    accepted.findText('text');
    accepted.replaceAll('words');
    expect(accepted.resolveSuggestions('accept', 'document').handled).toBeGreaterThan(0);
    expect(textOf(accepted, STYLE_IDS.plain)).toBe('Plain words words');
    const rejected = reviewer();
    rejected.findText('text');
    rejected.replaceAll('words');
    rejected.resolveSuggestions('reject', 'document');
    expect(textOf(rejected, STYLE_IDS.plain)).toBe('Plain text text');
    accepted.destroy();
    rejected.destroy();
  });

  it('deletes the matches as suggestions when the replacement is empty', () => {
    const c = reviewer();
    c.findText('text');
    expect(c.replaceAll('')).toEqual({ replaced: 2, skipped: 1 });
    expect(runsOf(c, STYLE_IDS.plain).map((r) => [r.text, r.kinds.join('+')])).toEqual([
      ['Plain ', ''],
      ['text', 'del'],
      [' ', ''],
      ['text', 'del'],
    ]);
    c.destroy();
  });

  it('records a single Replace as a suggestion too', () => {
    const c = reviewer();
    c.findText('text');
    c.findNext();
    expect(c.replaceCurrent('words')).toEqual({ replaced: 1, skipped: 0 });
    const runs = runsOf(c, STYLE_IDS.plain);
    expect(runs.filter((r) => r.kinds.includes('del')).map((r) => r.text)).toEqual(['text']);
    expect(runs.filter((r) => r.kinds.includes('ins')).map((r) => r.text)).toEqual(['words']);
    c.destroy();
  });

  it('changes the text directly outside suggestion mode', () => {
    const c = new DocumentCore({
      doc: styledDocument(),
      access: styledEditorAccess(),
      schedule: microtask,
      user: 'alice',
    });
    c.findText('Plain');
    expect(c.replaceAll('Simple')).toEqual({ replaced: 1, skipped: 0 });
    expect(runsOf(c, STYLE_IDS.plain)).toEqual([
      { text: 'Simple text', kinds: [], users: [], ids: [] },
    ]);
    c.destroy();
  });
});
