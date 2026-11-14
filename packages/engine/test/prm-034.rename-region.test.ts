/**
 * PRM-034 criterion 1 at the engine (lane V-PRM-018-034): with `structure` and `edit` in the region,
 * `renameRegion` sets its title in one transaction and queues the change. Without `structure`, for a
 * region the user may not edit, for an empty title or for the title the region already has, nothing
 * changes and nothing is queued.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { unconfirmed } from '../src/sync/state.ts';
import { internals } from '../src/testing.ts';
import {
  SPIKE_IDS,
  editorAccess,
  ownerAccess,
  regionOnlyAccess,
  spikeDocument,
} from './fixtures.ts';
import { microtask } from './support.ts';

function core(access = ownerAccess()): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access, schedule: microtask });
}

function regionNode(doc: PMNode): PMNode | undefined {
  let out: PMNode | undefined;
  doc.descendants((n) => {
    if (n.type.name === 'region' && n.attrs['id'] === SPIKE_IDS.region) out = n;
    return out === undefined;
  });
  return out;
}

describe('renameRegion changes a region title (PRM-034 criterion 1)', () => {
  it('sets the new title on the region with structure and edit, and queues it as one change', () => {
    const c = core();
    const start = regionNode(internals(c).state.doc)!;
    const before = start.attrs['title'];
    const policy = start.attrs['policy'];
    const queued = unconfirmed(internals(c).sync).length;
    expect(
      c.queryCommand('renameRegion', { region: SPIKE_IDS.region, title: 'Renamed' }),
    ).toMatchObject({
      enabled: true,
    });
    expect(c.run('renameRegion', { region: SPIKE_IDS.region, title: 'Renamed' })).toBe(true);
    const after = regionNode(internals(c).state.doc)!;
    expect(after.attrs['title']).toBe('Renamed');
    expect(after.attrs['title']).not.toBe(before);
    expect(after.attrs['id']).toBe(SPIKE_IDS.region);
    expect(after.attrs['policy']).toBe(policy);
    expect(unconfirmed(internals(c).sync).length).toBeGreaterThan(queued);
  });

  it('refuses without structure: the title is unchanged and nothing is queued', () => {
    const c = core(regionOnlyAccess());
    const before = internals(c).state.doc;
    const queued = unconfirmed(internals(c).sync).length;
    expect(c.run('renameRegion', { region: SPIKE_IDS.region, title: 'Renamed' })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
    expect(unconfirmed(internals(c).sync).length).toBe(queued);
  });

  it('refuses for a region the user may not edit, even with structure', () => {
    const c = core(
      editorAccess({
        caps: ['view', 'comment', 'suggest', 'edit', 'structure'],
        scopes: {
          body: ['view', 'comment', 'suggest', 'edit'],
          [`region:${SPIKE_IDS.region}`]: ['view', 'comment'],
        },
      }),
    );
    const before = internals(c).state.doc;
    expect(c.run('renameRegion', { region: SPIKE_IDS.region, title: 'Renamed' })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
  });

  it('refuses an empty title, a title already set and an unknown region', () => {
    const c = core();
    const before = internals(c).state.doc;
    expect(c.run('renameRegion', { region: SPIKE_IDS.region, title: '   ' })).toBe(false);
    const same = regionNode(before)!.attrs['title'] as string;
    expect(c.run('renameRegion', { region: SPIKE_IDS.region, title: same })).toBe(false);
    expect(c.run('renameRegion', { region: 'no-such-region', title: 'X' })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
  });
});
