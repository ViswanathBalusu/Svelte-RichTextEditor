/**
 * FE-044 criterion 5 through the core's named query (lane U-FE-033-048, fix round 8): the shell's
 * `insert.region` entry names the query `canMarkRegion`, so the core must list it, answer it, and say
 * why it is false (`queryReason`). In suggestion mode the reason is `suggestion`, which the shell
 * shows as `reason.query.suggestion`. The core is headless; the element forwards both members
 * (`packages/element/src/editor.ts`), checked in a browser by
 * `packages/element/e2e/fe-044-region-suggestion-reason.spec.ts`.
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { Access } from '@docedit/protocol';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, editorAccess, ownerAccess, spikeDocument } from './fixtures.ts';
import { caret, microtask, posOf } from './support.ts';

function core(mode: 'edit' | 'review', access: Access = ownerAccess()): DocumentCore {
  let n = 0;
  return new DocumentCore({
    doc: spikeDocument(),
    schedule: microtask,
    mode,
    user: 'alice',
    access,
    generateId: () => `r${String(++n).padStart(15, '0')}`,
  });
}

/** Selects the whole paragraph with identifier `id`. */
function selectParagraph(c: DocumentCore, id: string): void {
  const i = internals(c);
  const from = posOf(i.state.doc, id) + 1;
  const to = from + i.state.doc.nodeAt(from - 1)!.textContent.length;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, to)));
}

describe('canMarkRegion and its reason (FE-044 criterion 5; PRM-033)', () => {
  it('is listed in queryNames', () => {
    expect(core('edit').queryNames).toContain('canMarkRegion');
  });

  it('in edit mode with structure, a body paragraph may become a region and there is no reason', () => {
    const c = core('edit');
    selectParagraph(c, SPIKE_IDS.intro);
    expect(c.query('canMarkRegion')).toBe(true);
    expect(c.queryReason('canMarkRegion')).toBeNull();
  });

  it('in suggestion mode the query is false, the reason is `suggestion`, and run changes nothing', () => {
    const c = core('review');
    expect(c.suggestion.get().on).toBe(true);
    selectParagraph(c, SPIKE_IDS.intro);
    expect(c.query('canMarkRegion')).toBe(false);
    expect(c.queryReason('canMarkRegion')).toBe('suggestion');
    const before = JSON.stringify(c.getContent());
    expect(c.run('markRegion', { title: 'Terms' })).toBe(false);
    expect(JSON.stringify(c.getContent())).toBe(before);
  });

  it('the same user and selection in edit mode again: the reason goes away', () => {
    const c = core('review');
    selectParagraph(c, SPIKE_IDS.intro);
    expect(c.queryReason('canMarkRegion')).toBe('suggestion');
    c.setMode('edit');
    expect(c.query('canMarkRegion')).toBe(true);
    expect(c.queryReason('canMarkRegion')).toBeNull();
  });

  it('gives the other reasons outside suggestion mode: nested, structure', () => {
    const owner = core('edit');
    caret(owner, SPIKE_IDS.legal, 1);
    expect(owner.query('canMarkRegion')).toBe(false);
    expect(owner.queryReason('canMarkRegion')).toBe('nested');

    const editor = core('edit', editorAccess());
    selectParagraph(editor, SPIKE_IDS.intro);
    expect(editor.query('canMarkRegion')).toBe(false);
    expect(editor.queryReason('canMarkRegion')).toBe('structure');
  });

  it('has no reason for a query that is not canMarkRegion', () => {
    const c = core('review');
    expect(c.queryReason('canUndo')).toBeNull();
    expect(c.queryReason('no-such-query')).toBeNull();
  });
});
