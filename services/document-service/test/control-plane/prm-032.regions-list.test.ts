// PRM-032 criteria 1, 2, 4 and 5: the region list over HTTP, read by a viewer, with memory storage
// (07 §7; 05 §6.2 `GET /documents/{id}/regions`; PRO-051). Criterion 3 (the ETag changes when the
// list changes) is not tested here: the list response carries no ETag. The PostgreSQL run is not
// made here (it needs a running PostgreSQL; the storage is the same interface).
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
const OPEN = 'rOpen00000000001';

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

describe('the region list for a viewer (PRM-032 criteria 1, 2, 4, 5, memory storage)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness('memory', {});
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists every region with its identifier, title, policy, order, state and editors to a viewer (criterion 1)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions(), title: 'List viewer' });
    const viewer = h.userToken({ [doc]: 'viewer' });
    const r = await h.call('GET', `/v1/documents/${doc}/regions`, { token: viewer });
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(2);
    for (const item of r.json.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(
        ['editors', 'id', 'order', 'policy', 'state', 'title'].sort(),
      );
      expect(typeof item['title']).toBe('string');
    }
    expect(r.json.items.map((x: { id: string }) => x.id)).toEqual([LEGAL, OPEN]);
    expect(r.json.items.map((x: { order: number }) => x.order)).toEqual([0, 1]);
  });

  it('states a region with no stored state as draft (criterion 2)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions(), title: 'Draft state' });
    const r = await h.call('GET', `/v1/documents/${doc}/regions`, {
      token: h.userToken({ [doc]: 'viewer' }),
    });
    expect(r.json.items.map((x: { state: string }) => x.state)).toEqual(['draft', 'draft']);
  });

  it('names only principals whose grant conveys edit, and states that editors and owners edit an inherit region (criterion 5)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions(), title: 'Who can edit' });
    const ref = { tenant: h.tenant, doc };
    const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
    const carol = (await h.parts.users.resolve(h.tenant, 'carol')).surrogate;
    await h.parts.grants.change(
      ref,
      {
        putGrants: [
          { region: LEGAL, principal: `user:${bob}`, role: 'editor', expiresAt: null },
          // A viewer grant conveys no edit, so carol is not named as someone who can edit.
          { region: OPEN, principal: `user:${carol}`, role: 'viewer', expiresAt: null },
        ],
      },
      { actor: 'system' },
    );
    const r = await h.call('GET', `/v1/documents/${doc}/regions`, {
      token: h.userToken({ [doc]: 'viewer' }),
    });
    const [legal, open] = r.json.items as Array<{ editors: Record<string, unknown> }>;
    expect(legal!.editors).toEqual({ roles: ['owner'], principals: ['user:bob'] });
    expect(open!.editors).toEqual({ roles: ['editor', 'owner'], principals: [] });
    expect(JSON.stringify(r.json)).not.toContain(`user:${carol}`);
  });

  it('no longer lists a region that a commit retires (criterion 4)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions(), title: 'Retired id' });
    const ref = { tenant: h.tenant, doc };
    const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const span = spanOf(content.json.doc, OPEN);
    const head = await h.parts.logs.head(ref);
    const epoch = await h.parts.ownership.claim(ref, 'node-prm-032');
    const { revision } = await h.parts.grants.current(ref);
    const commit: StoredCommit = {
      seq: head.seq + 1,
      id: uuid7(),
      kind: 'steps',
      steps: [{ stepType: 'replace', from: span.before, to: span.after }],
      user: 'owner',
      session: 's-owner',
      time: h.now(),
      origin: 'input',
      scopes: ['body', `region:${OPEN}`],
      revision,
      cdm: 1,
      engine: 'pm-steps/1',
      retired: [OPEN],
      claimed: [],
    };
    const write: WriteRequest = { epoch, revision, fromSeq: head.seq + 1, commits: [commit] };
    expect(await h.parts.logs.append(ref, write)).toEqual({ status: 'ok' });
    const r = await h.call('GET', `/v1/documents/${doc}/regions`, {
      token: h.userToken({ [doc]: 'viewer' }),
    });
    expect(r.status).toBe(200);
    expect(r.json.items.map((x: { id: string }) => x.id)).toEqual([LEGAL]);
  });
});
