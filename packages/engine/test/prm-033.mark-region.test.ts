/**
 * PRM-033 criterion 1 at the engine (lane V-PRM-018-034): with `structure` and `edit` in the body,
 * `markRegion` wraps the selected whole blocks in one new region with the given title and policy
 * `inherit`, and the change is queued as one commit. Without `structure`, or with the selection
 * inside an existing region (regions do not nest), nothing changes and nothing is queued.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
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

/** Selects from the start of paragraph `a` to the end of paragraph `b`. */
function selectAcross(c: DocumentCore, a: string, b: string): void {
  const i = internals(c);
  const from = posOf(i.state.doc, a) + 1;
  const toStart = posOf(i.state.doc, b) + 1;
  const to = toStart + i.state.doc.nodeAt(toStart - 1)!.textContent.length;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, to)));
}

describe('the command is disabled for a selection that touches a region (PRM-033 criterion 2)', () => {
  it('gives `nested` for a selection that starts in the body and ends inside a region', () => {
    const c = core();
    const i = internals(c);
    const from = posOf(i.state.doc, SPIKE_IDS.intro) + 2;
    const to = posOf(i.state.doc, SPIKE_IDS.legal) + 3;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, to)));
    expect(c.query('canMarkRegion')).toBe(false);
    expect(c.queryReason('canMarkRegion')).toBe('nested');
    const before = internals(c).state.doc;
    expect(c.run('markRegion', { title: 'Across' })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
  });

  it('gives `nested` for whole blocks that enclose a whole region, and changes nothing', () => {
    const c = core();
    selectAcross(c, SPIKE_IDS.intro, SPIKE_IDS.after);
    expect(c.query('canMarkRegion')).toBe(false);
    expect(c.queryReason('canMarkRegion')).toBe('nested');
    const before = internals(c).state.doc;
    const queued = unconfirmed(internals(c).sync).length;
    expect(c.run('markRegion', { title: 'Around' })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
    expect(unconfirmed(internals(c).sync).length).toBe(queued);
  });

  it('still allows whole blocks that hold no region', () => {
    const c = core();
    selectAcross(c, SPIKE_IDS.title, SPIKE_IDS.intro);
    expect(c.query('canMarkRegion')).toBe(true);
    expect(c.queryReason('canMarkRegion')).toBeNull();
  });
});

/** The spike document with `total` regions in its body (the spike has one). */
function documentWithRegions(total: number): CdmEnvelope {
  const envelope = spikeDocument();
  const body = (
    envelope.doc as { content: Array<{ type: string; content: unknown[] }> }
  ).content.find((n) => n.type === 'body')!;
  const extra = Array.from({ length: total - 1 }, (_, n) => {
    const pad = String(n + 1).padStart(12, '0');
    return {
      type: 'region',
      attrs: { id: `rGen${pad}`, title: `Generated ${n + 1}`, policy: 'inherit' },
      content: [
        { type: 'paragraph', attrs: { id: `pGen${pad}` }, content: [{ type: 'text', text: 'x' }] },
      ],
    };
  });
  body.content.push(...extra);
  return envelope;
}

describe('the region limit in the editor (PRM-033 criterion 3)', () => {
  it('at 499 regions the command is enabled and the 500th is made', () => {
    const c = new DocumentCore({
      doc: documentWithRegions(499),
      access: ownerAccess(),
      schedule: microtask,
    });
    selectParagraph(c, SPIKE_IDS.intro);
    expect(c.query('canMarkRegion')).toBe(true);
    expect(c.run('markRegion', { title: 'Number 500' })).toBe(true);
    expect(regions(internals(c).state.doc).length).toBe(500);
  });

  it('at 500 regions the command is disabled with the reason `limit`, and nothing changes', () => {
    const c = new DocumentCore({
      doc: documentWithRegions(500),
      access: ownerAccess(),
      schedule: microtask,
    });
    expect(regions(internals(c).state.doc).length).toBe(500);
    selectParagraph(c, SPIKE_IDS.intro);
    expect(c.query('canMarkRegion')).toBe(false);
    expect(c.queryReason('canMarkRegion')).toBe('limit');
    const before = internals(c).state.doc;
    const queued = unconfirmed(internals(c).sync).length;
    expect(c.run('markRegion', { title: 'Number 501' })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
    expect(unconfirmed(internals(c).sync).length).toBe(queued);
  });
});
