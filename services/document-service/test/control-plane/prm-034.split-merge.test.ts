// PRM-034 criterion 4 and PRM-065 (ADR 0033 item 3; owner decision 220): what a split and a merge
// do to the identifiers, grants, state and lease of the regions, in the permission data. A split
// leaves everything with the part that keeps the identifier and gives the new region none of it; a
// merge retires the region that is deleted as a whole node (identifier, grants, state and lease)
// and leaves the survivor as it was. Memory storage, over the test harness; the commits are
// appended as the room would append them (as prm-034.remove-region.test.ts does). The authority's
// rules for who may split or merge are tested in packages/authority and in the conformance kit.
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
const LEGAL_SECOND = 'pLegal0000000002';
const FRESH = 'rSplit0000000001';

interface Json {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: Json[];
}

/** The document of the harness with a second paragraph in the Legal region. */
function content(): Record<string, unknown> {
  const env = documentWithRegions() as { doc: Json };
  const body = env.doc.content!.find((n) => n.type === 'body')!;
  const legal = body.content!.find((n) => n.attrs?.['id'] === LEGAL)!;
  legal.content!.push({
    type: 'paragraph',
    attrs: { id: LEGAL_SECOND, style: 'Normal' },
    content: [{ type: 'text', text: 'Indemnity' }],
  });
  return env as unknown as Record<string, unknown>;
}

function spanOf(doc: unknown, id: string): { before: number; after: number; node: Json } {
  const root = cdmSchema().nodeFromJSON(doc);
  let found: { before: number; after: number; node: Json } | null = null;
  root.descendants((n, pos) => {
    if (n.attrs['id'] === id)
      found = { before: pos, after: pos + n.nodeSize, node: n.toJSON() as Json };
    return !found;
  });
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

describe('split and merge in the permission data (PRM-034 criterion 4; PRM-065; memory storage)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness('memory', {});
  });
  afterAll(async () => {
    await h?.close();
  });

  async function setUp(title: string) {
    const doc = await h.createDocument({ content: content(), title });
    const ref = { tenant: h.tenant, doc };
    const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
    const expiresAt = h.now() + 60_000;
    await h.parts.grants.change(
      ref,
      {
        putGrants: [LEGAL, OPEN].map((region) => ({
          region,
          principal: `user:${bob}`,
          role: 'editor' as const,
          expiresAt: null,
        })),
        putLeases: [LEGAL, OPEN].map((region) => ({ region, holder: bob, expiresAt })),
        setRegionStates: [LEGAL, OPEN].map((region) => ({ region, state: 'approved' as const })),
      },
      { actor: 'system' },
    );
    return { doc, ref };
  }

  async function append(
    ref: { tenant: string; doc: string },
    doc: string,
    steps: unknown[],
    retired: string[],
  ) {
    const head = await h.parts.logs.head(ref);
    const epoch = await h.parts.ownership.claim(ref, 'node-prm-034-split-merge');
    const { revision } = await h.parts.grants.current(ref);
    const commit: StoredCommit = {
      seq: head.seq + 1,
      id: uuid7(),
      kind: 'steps',
      steps: steps as StoredCommit['steps'],
      user: 'owner',
      session: 's-owner',
      time: h.now(),
      origin: 'input',
      scopes: ['body', `region:${LEGAL}`, `region:${OPEN}`],
      revision,
      cdm: 1,
      engine: 'pm-steps/1',
      retired,
      claimed: [],
    };
    const write: WriteRequest = { epoch, revision, fromSeq: head.seq + 1, commits: [commit] };
    expect(await h.parts.logs.append(ref, write)).toEqual({ status: 'ok' });
    return h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
  }

  it('a split leaves the grant, state and lease with the part that keeps the identifier, and the new region has none', async () => {
    const { doc, ref } = await setUp('Split region');
    const read = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const second = spanOf(read.json.doc, LEGAL_SECOND);
    const attrs = spanOf(read.json.doc, LEGAL).node.attrs!;
    const after = await append(
      ref,
      doc,
      [
        {
          stepType: 'replace',
          from: second.before,
          to: second.before,
          structure: true,
          slice: {
            content: [
              { type: 'region', attrs: { ...attrs } },
              { type: 'region', attrs: { ...attrs } },
            ],
            openStart: 1,
            openEnd: 1,
          },
        },
        { stepType: 'attr', pos: second.before + 1, attr: 'id', value: FRESH },
      ],
      [],
    );
    // Nothing is retired: the first part is the region that was there.
    expect(await h.parts.grants.retired(ref)).toEqual([]);
    const perms = await h.parts.grants.current(ref);
    expect(perms.grants.filter((g) => g.region === LEGAL)).toHaveLength(1);
    expect(perms.leases.filter((l) => l.region === LEGAL)).toHaveLength(1);
    expect(perms.regionStates.get(LEGAL)).toBe('approved');
    // The new region has a new identifier: no grant, no lease and no state (draft).
    expect(perms.grants.filter((g) => g.region === FRESH)).toEqual([]);
    expect(perms.leases.filter((l) => l.region === FRESH)).toEqual([]);
    expect(perms.regionStates.has(FRESH)).toBe(false);
    expect(JSON.stringify(after.json.doc)).toContain(FRESH);
    expect(spanOf(after.json.doc, FRESH).node.attrs).toMatchObject({ policy: 'restricted' });
  });

  it('a merge retires the region deleted as a whole node and leaves the survivor as it was', async () => {
    const { doc, ref } = await setUp('Merge regions');
    const read = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const open = spanOf(read.json.doc, OPEN);
    const legal = spanOf(read.json.doc, LEGAL);
    // Open follows Legal: delete Open, then put its blocks at the end of Legal.
    const after = await append(
      ref,
      doc,
      [
        { stepType: 'replace', from: open.before, to: open.after },
        {
          stepType: 'replace',
          from: legal.after - 1,
          to: legal.after - 1,
          slice: { content: open.node.content ?? [] },
        },
      ],
      [OPEN],
    );
    const perms = await h.parts.grants.current(ref);
    expect(perms.grants.filter((g) => g.region === OPEN)).toEqual([]);
    expect(perms.leases.filter((l) => l.region === OPEN)).toEqual([]);
    expect(perms.regionStates.has(OPEN)).toBe(false);
    expect(await h.parts.grants.retired(ref)).toEqual([OPEN]);
    // The survivor keeps its identifier, grant, lease and state.
    expect(perms.grants.filter((g) => g.region === LEGAL)).toHaveLength(1);
    expect(perms.leases.filter((l) => l.region === LEGAL)).toHaveLength(1);
    expect(perms.regionStates.get(LEGAL)).toBe('approved');
    expect(JSON.stringify(after.json.doc)).not.toContain(OPEN);
    expect(spanOf(after.json.doc, 'pOpen00000000001').node.type).toBe('paragraph');
    expect(spanOf(after.json.doc, LEGAL).node.attrs).toMatchObject({ policy: 'restricted' });
  });
});
