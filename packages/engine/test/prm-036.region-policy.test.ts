/**
 * PRM-036 criterion 1 at the engine (lane V-PRM-035-051): the named command `setRegionPolicy`
 * with `manage` sets the region's policy in one transaction and queues it as a commit; without
 * `manage`, an unknown region, or the policy it already has, nothing changes and nothing is queued.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { unconfirmed } from '../src/sync/state.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, editorAccess, ownerAccess, spikeDocument } from './fixtures.ts';
import { microtask } from './support.ts';

function core(access = ownerAccess()): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access, schedule: microtask });
}

function regionNode(doc: PMNode, id: string): PMNode | null {
  let found: PMNode | null = null;
  doc.descendants((n) => {
    if (n.type.name === 'region' && n.attrs['id'] === id) found = n;
    return found === null;
  });
  return found;
}

describe('setRegionPolicy changes a region policy as one commit (PRM-036 criterion 1)', () => {
  it('with manage, sets the policy of the region and queues the change', () => {
    const c = core();
    const before = regionNode(internals(c).state.doc, SPIKE_IDS.region);
    expect(before?.attrs['policy']).toBe('restricted');
    const queued = unconfirmed(internals(c).sync).length;

    expect(
      c.queryCommand('setRegionPolicy', { region: SPIKE_IDS.region, policy: 'inherit' }),
    ).toMatchObject({ enabled: true });
    expect(c.run('setRegionPolicy', { region: SPIKE_IDS.region, policy: 'inherit' })).toBe(true);

    const after = regionNode(internals(c).state.doc, SPIKE_IDS.region);
    expect(after?.attrs['policy']).toBe('inherit');
    expect(after?.attrs['title']).toBe(before?.attrs['title']);
    expect(unconfirmed(internals(c).sync).length).toBeGreaterThan(queued);
  });

  it('sets the policy back to restricted, and a second identical request changes nothing', () => {
    const c = core();
    expect(c.run('setRegionPolicy', { region: SPIKE_IDS.region, policy: 'inherit' })).toBe(true);
    expect(c.run('setRegionPolicy', { region: SPIKE_IDS.region, policy: 'restricted' })).toBe(true);
    expect(regionNode(internals(c).state.doc, SPIKE_IDS.region)?.attrs['policy']).toBe(
      'restricted',
    );
    const before = internals(c).state.doc;
    expect(c.run('setRegionPolicy', { region: SPIKE_IDS.region, policy: 'restricted' })).toBe(
      false,
    );
    expect(internals(c).state.doc.eq(before)).toBe(true);
  });

  it('without manage, refuses and leaves the document and the queue unchanged', () => {
    const c = core(editorAccess());
    const before = internals(c).state.doc;
    const queued = unconfirmed(internals(c).sync).length;
    expect(c.run('setRegionPolicy', { region: SPIKE_IDS.region, policy: 'inherit' })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
    expect(unconfirmed(internals(c).sync).length).toBe(queued);
  });

  it('refuses an identifier that is no region of the document', () => {
    const c = core();
    const before = internals(c).state.doc;
    expect(c.run('setRegionPolicy', { region: 'no-such-region', policy: 'inherit' })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
  });

  it('is not offered without both arguments', () => {
    const c = core();
    expect(c.run('setRegionPolicy', { region: SPIKE_IDS.region })).toBe(false);
    expect(c.run('setRegionPolicy')).toBe(false);
  });
});
