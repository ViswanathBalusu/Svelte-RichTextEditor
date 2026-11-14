/**
 * Deleting a source that is still cited is refused, and the citing positions are reported (UX-103
 * criterion 2). The pane, the commit through the log and the on-screen list are not tested here.
 * Lane V-UX-091-104, round 3.
 */
import { describe, expect, it } from 'vitest';
import { insertCitation } from '../src/citation-insert.ts';
import { citationsCiting, deleteSource } from '../src/source-delete.ts';
import { AUTH_IDS, authoringState, caretIn } from './authoring-doc.ts';

const always = () => true;

describe('deleting a source (UX-103 criterion 2)', () => {
  it('deletes an uncited source definition through the transaction', () => {
    const state = authoringState();
    let next: typeof state | null = null;
    const result = deleteSource(state, 'jones2024', (tr) => {
      next = state.apply(tr);
    });
    expect(result).toEqual({ ok: true });
    const ids: string[] = [];
    next!.doc.firstChild!.forEach((child) => {
      if (child.type.name === 'source_def') ids.push(String(child.attrs['id']));
    });
    expect(ids).not.toContain('jones2024');
    expect(ids).toContain('smith2026');
  });

  it('refuses to delete a source that a citation still names, and reports where it is cited', () => {
    const base = caretIn(authoringState(), AUTH_IDS.p1, 0);
    let cited = base;
    insertCitation(base, [{ source: 'smith2026' }], { writable: always }, (tr) => {
      cited = base.apply(tr);
    });
    const at = citationsCiting(cited.doc, 'smith2026');
    expect(at).toHaveLength(1);

    let dispatched = false;
    const result = deleteSource(cited, 'smith2026', () => {
      dispatched = true;
    });
    expect(result).toEqual({ ok: false, reason: 'cited', citedAt: at });
    expect(dispatched).toBe(false);

    // A source no citation names is still deleted.
    expect(deleteSource(cited, 'jones2024')).toEqual({ ok: true });
  });

  it('refuses a source the document does not define', () => {
    expect(deleteSource(authoringState(), 'nobody1999')).toEqual({
      ok: false,
      reason: 'not-defined',
    });
  });
});
