/**
 * PRM-033 criterion 1 at the engine (lane V-PRM-018-034): with `structure` and `edit` in the body,
 * `markRegion` wraps the selected whole blocks in one new region with the given title and policy
 * `inherit`, and the change is queued as one commit. Without `structure`, or with the selection
 * inside an existing region (regions do not nest), nothing changes and nothing is queued.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { unconfirmed } from '../src/sync/state.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, editorAccess, ownerAccess, spikeDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

function core(access = ownerAccess()): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access, schedule: microtask });
}

/** Selects the whole paragraph with identifier `id`. */
function selectParagraph(c: DocumentCore, id: string): void {
  const i = internals(c);
  const from = posOf(i.state.doc, id) + 1;
  const to = from + i.state.doc.nodeAt(from - 1)!.textContent.length;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, to)));
}

function regions(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'region') out.push(n);
    return true;
  });
  return out;
}

describe('markRegion wraps the selected blocks in a new region (PRM-033 criterion 1)', () => {
  it('wraps a body paragraph in one region with a new id, the title and policy inherit, and queues it', () => {
    const c = core();
    const before = regions(internals(c).state.doc).length;
    const queued = unconfirmed(internals(c).sync).length;
    selectParagraph(c, SPIKE_IDS.intro);
    expect(c.queryCommand('markRegion', { title: 'Terms' })).toMatchObject({ enabled: true });
    expect(c.run('markRegion', { title: 'Terms' })).toBe(true);

    const doc = internals(c).state.doc;
    const found = regions(doc);
    expect(found.length).toBe(before + 1);
    const created = found.find((r) => r.attrs['title'] === 'Terms');
    expect(created).toBeDefined();
    expect(created!.attrs['policy']).toBe('inherit');
    expect(typeof created!.attrs['id']).toBe('string');
    expect(created!.attrs['id']).not.toBe(SPIKE_IDS.region);
    expect(created!.textContent).toContain(
      doc.resolve(posOf(doc, SPIKE_IDS.intro) + 1).parent.textContent,
    );
    expect(unconfirmed(internals(c).sync).length).toBeGreaterThan(queued);
  });

  it('refuses without structure: the document is unchanged and nothing is queued', () => {
    const c = core(editorAccess());
    const before = internals(c).state.doc;
    const queued = unconfirmed(internals(c).sync).length;
    selectParagraph(c, SPIKE_IDS.intro);
    expect(c.run('markRegion', { title: 'Terms' })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
    expect(unconfirmed(internals(c).sync).length).toBe(queued);
  });

  it('refuses a selection inside an existing region, since regions do not nest', () => {
    const c = core();
    const before = internals(c).state.doc;
    selectParagraph(c, SPIKE_IDS.legal);
    expect(c.run('markRegion', { title: 'Nested' })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
  });

  it('refuses an empty title', () => {
    const c = core();
    selectParagraph(c, SPIKE_IDS.intro);
    expect(c.run('markRegion', { title: '   ' })).toBe(false);
  });
});
