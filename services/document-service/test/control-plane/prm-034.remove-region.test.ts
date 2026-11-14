// PRM-034 criterion 2: removing a region removes the region node as a whole and retires its grants,
// its state and its lease (07 §3; PRM-003; I3). Memory storage, over the test harness. The commit
// is appended to the log as the room would append it, as routes.content.test.ts does; the authority's
// rule for who may remove a region is tested in packages/authority. The PostgreSQL run is not made
// here (it needs a running PostgreSQL; the storage is the same interface).
import type { StoredCommit, WriteRequest } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  startHarness,
  type Harness,
} from '../../test/control-plane/support.ts';

const LEGAL = 'rLegal0000000001';

/** The start and end of the node `id` in `doc`, as positions (as routes.content.test.ts). */
function spanOf(doc: unknown, id: string): { before: number; after: number } {
  const root = cdmSchema().nodeFromJSON(doc);
  let found: { before: number; after: number } | null = null;
  root.descendants((n, pos) => {
    if (n.attrs['id'] === id) found = { before: pos, after: pos + n.nodeSize };
    return !found;
  });
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

describe('removing a region retires its grants, state and lease (PRM-034 criterion 2, memory storage)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness('memory', {});
  });
  afterAll(async () => {
    await h?.close();
  });

  it('removes the node as a whole and retires its grant, state and lease', async () => {
    const doc = await h.createDocument({ content: documentWithRegions(), title: 'Remove region' });
    const ref = { tenant: h.tenant, doc };
    const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
    const expiresAt = h.now() + 60_000;
    await h.parts.grants.change(
      ref,
      {
        putGrants: [{ region: LEGAL, principal: `user:${bob}`, role: 'editor', expiresAt: null }],
        putLeases: [{ region: LEGAL, holder: bob, expiresAt }],
        setRegionStates: [{ region: LEGAL, state: 'approved' }],
      },
      { actor: 'system' },
    );
    const before = await h.parts.grants.current(ref);
    expect(before.grants.some((g) => g.region === LEGAL)).toBe(true);
    expect(before.leases.some((l) => l.region === LEGAL)).toBe(true);
    expect(before.regionStates.get(LEGAL)).toBe('approved');

    // The commit that removes the region: the whole node goes, and the region is retired (I3).
    const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const span = spanOf(content.json.doc, LEGAL);
    const head = await h.parts.logs.head(ref);
    const epoch = await h.parts.ownership.claim(ref, 'node-prm-034');
    const { revision } = before;
    const commit: StoredCommit = {
      seq: head.seq + 1,
      id: uuid7(),
      kind: 'steps',
      steps: [{ stepType: 'replace', from: span.before, to: span.after }],
      user: 'owner',
      session: 's-owner',
      time: h.now(),
      origin: 'input',
      scopes: ['body', `region:${LEGAL}`],
      revision,
      cdm: 1,
      engine: 'pm-steps/1',
      retired: [LEGAL],
      claimed: [],
    };
    const write: WriteRequest = { epoch, revision, fromSeq: head.seq + 1, commits: [commit] };
    expect(await h.parts.logs.append(ref, write)).toEqual({ status: 'ok' });

    const after = await h.parts.grants.current(ref);
    expect(after.grants.filter((g) => g.region === LEGAL)).toEqual([]);
    expect(after.leases.filter((l) => l.region === LEGAL)).toEqual([]);
    expect(after.regionStates.has(LEGAL)).toBe(false);
    expect(await h.parts.grants.retired(ref)).toEqual([LEGAL]);

    const removed = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    expect(JSON.stringify(removed.json.doc)).not.toContain(LEGAL);
    expect(removed.json.seq).toBe(head.seq + 1);
  });
});
