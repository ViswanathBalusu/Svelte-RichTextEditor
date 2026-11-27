/**
 * PRM-070 at the engine (ADR 0424; decision 279): a person who may edit only one region renames it
 * when the access object holds `structure` in that region's scope, and adds a style when the scope
 * `defs` holds `structure.add`. They still cannot change or delete a style, and the guard lets
 * through nothing else. Without the entries nothing is offered.
 *
 * Run with `pnpm exec vitest run --project node packages/engine/test/prm-070.region-structure.test.ts`.
 */
import type { Access } from '@docedit/protocol';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { checkChange } from '../src/guard.ts';
import { DocumentCore } from '../src/headless.ts';
import { unconfirmed } from '../src/sync/state.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, regionOnlyAccess, spikeDocument } from './fixtures.ts';
import { microtask } from './support.ts';

const REGION = `region:${SPIKE_IDS.region}`;

/** The region-only user of PRM-030, with the entries a grant that lists the two operations adds. */
function withGrant(structure: boolean, add: boolean): Access {
  const base = regionOnlyAccess();
  return {
    ...base,
    scopes: {
      ...base.scopes,
      ...(structure ? { [REGION]: [...base.scopes[REGION]!, 'structure'] } : {}),
      ...(add ? { defs: [...base.scopes['defs']!, 'structure.add'] } : {}),
    },
  } as Access;
}

const make = (access: Access): DocumentCore =>
  new DocumentCore({ doc: spikeDocument(), access, schedule: microtask });

function titleOf(doc: PMNode): unknown {
  let title: unknown;
  doc.descendants((n) => {
    if (n.type.name === 'region' && n.attrs['id'] === SPIKE_IDS.region) title = n.attrs['title'];
    return title === undefined;
  });
  return title;
}

const styleIds = (doc: PMNode): string[] => {
  const out: string[] = [];
  doc.firstChild!.forEach((n) => {
    if (n.type.name === 'style_def') out.push(String(n.attrs['id']));
  });
  return out;
};

describe('renaming a region through the `structure` of its scope (PRM-070, criterion 1)', () => {
  const args = { region: SPIKE_IDS.region, title: 'Renamed' };

  it('offers and runs the rename, and queues one change, without document-level structure', () => {
    const c = make(withGrant(true, false));
    expect(c.queryCommand('renameRegion', args)).toMatchObject({ enabled: true });
    const queued = unconfirmed(internals(c).sync).length;
    expect(c.run('renameRegion', args)).toBe(true);
    expect(titleOf(internals(c).state.doc)).toBe('Renamed');
    expect(unconfirmed(internals(c).sync).length).toBeGreaterThan(queued);
  });

  it('refuses it without the entry, with the reason, and changes nothing', () => {
    const c = make(withGrant(false, false));
    const before = internals(c).state.doc;
    expect(c.queryCommand('renameRegion', args)).toEqual({
      enabled: false,
      active: false,
      reason: 'no-access',
    });
    expect(c.run('renameRegion', args)).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
  });

  it('needs `edit` in the region as well, and holds for that region only', () => {
    const noEdit = make({
      ...withGrant(true, false),
      scopes: { ...withGrant(true, false).scopes, [REGION]: ['view', 'comment', 'structure'] },
    } as Access);
    expect(noEdit.run('renameRegion', args)).toBe(false);
    const other = make(withGrant(true, false));
    expect(other.run('renameRegion', { region: 'rNone000000000001', title: 'X' })).toBe(false);
  });

  it('passes the rename through the region guard', () => {
    const c = make(withGrant(true, false));
    expect(c.run('renameRegion', args)).toBe(true);
    const doc = internals(c).state.doc;
    expect(titleOf(doc)).toBe('Renamed');
  });
  it('still refuses a region removed or moved, and a rename together with one', () => {
    const access = withGrant(true, false);
    const c = make(access);
    const state = internals(c).state;
    let at = -1;
    state.doc.descendants((n, pos) => {
      if (n.type.name === 'region' && n.attrs['id'] === SPIKE_IDS.region) at = pos;
      return at < 0;
    });
    const node = state.doc.nodeAt(at)!;
    const removal = state.tr.delete(at, at + node.nodeSize);
    expect(
      checkChange(state.doc, removal.doc, removal.steps, removal.docs, access, false),
    ).toMatchObject({
      reason: 'structure',
    });
    // A rename together with a change to the body, which this person may only read.
    const bodyStart = state.doc.content.size - state.doc.lastChild!.nodeSize;
    const both = state.tr
      .setNodeMarkup(at, undefined, { ...node.attrs, title: 'Renamed' })
      .insertText('x', bodyStart + 2);
    expect(checkChange(state.doc, both.doc, both.steps, both.docs, access, false)).toMatchObject({
      reason: 'scope',
    });
    const rename = state.tr.setNodeMarkup(at, undefined, { ...node.attrs, title: 'Renamed' });
    expect(checkChange(state.doc, rename.doc, rename.steps, rename.docs, access, false)).toBeNull();
    // Without the entry the same rename is refused.
    expect(
      checkChange(state.doc, rename.doc, rename.steps, rename.docs, withGrant(false, false), false),
    ).toMatchObject({ reason: 'structure' });
  });
});

describe('adding a style through `structure.add` of the scope `defs` (PRM-070, criterion 2)', () => {
  it('offers "new style" and creates it, queueing one change', () => {
    const c = make(withGrant(false, true));
    expect(c.checkStyleEdit('create')).toEqual({ ok: true, regions: [] });
    const queued = unconfirmed(internals(c).sync).length;
    const before = styleIds(internals(c).state.doc);
    const result = c.createStyle({ name: 'Margin note', kind: 'paragraph' });
    expect(result.ok).toBe(true);
    const after = styleIds(internals(c).state.doc);
    expect(after).toHaveLength(before.length + 1);
    expect(unconfirmed(internals(c).sync).length).toBeGreaterThan(queued);
  });

  it('offers no change and no removal of an existing style', () => {
    const c = make(withGrant(false, true));
    const existing = styleIds(internals(c).state.doc)[0]!;
    for (const op of ['change', 'delete'] as const)
      expect(c.checkStyleEdit(op, existing), op).toMatchObject({ ok: false, reason: 'no-access' });
    const before = internals(c).state.doc;
    expect(c.deleteStyle(existing)).toMatchObject({ ok: false, reason: 'no-access' });
    expect(c.changeStyle(existing, { name: 'Other' })).toMatchObject({
      ok: false,
      reason: 'no-access',
    });
    expect(internals(c).state.doc.eq(before)).toBe(true);
    // The commands say the same.
    expect(c.queryCommand('createStyle')).toMatchObject({ enabled: true });
    expect(c.queryCommand('deleteStyle', { styleDef: { id: existing } })).toMatchObject({
      enabled: false,
      reason: 'no-access',
    });
  });

  it('offers nothing without the entry', () => {
    const c = make(withGrant(false, false));
    expect(c.checkStyleEdit('create')).toMatchObject({ ok: false, reason: 'no-access' });
    expect(c.createStyle({ name: 'Margin note', kind: 'paragraph' }).ok).toBe(false);
  });

  it('keeps the entry from widening anything else: no page setup and no header', () => {
    const c = make(withGrant(false, true));
    expect(c.queryCommand('setPageSetup')).toMatchObject({ enabled: false });
    expect(c.queryCommand('editHeader')).toMatchObject({ enabled: false });
  });
});
