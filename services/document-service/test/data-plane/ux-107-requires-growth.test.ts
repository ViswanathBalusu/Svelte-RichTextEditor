// UX-107 criterion 3 in the document service: the room lets `requires` grow (`requiresGrowth`), a
// commit that brings in the first form field is accepted when every attached client announced
// `fields`, the grown list is stored with the commit and in the document's record (the payload of the
// commit and `documents.requires`), and a client that connects later without `fields` is refused
// with `unsupported_feature`. Real WebSocket clients over MemoryStore; the PostgreSQL write
// (`PgLogStore.append`) is run by `ux-107-requires-growth.pg.test.ts` when PostgreSQL is up.
import { uuid7, type JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_JSON, posInside, schema } from '../../../../packages/authority/test/fixtures.ts';
import { decodePayload, encodeCommit } from '../../src/storage/codec.ts';
import { requiresAfter } from '../../src/storage/requires.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

type Json = Record<string, unknown>;

/** The base document without anything that needs `fields`: no role, no form field. */
function plainJson(): Json {
  const clone = JSON.parse(JSON.stringify(BASE_JSON)) as { content: Json[] };
  const walk = (n: Json): Json => {
    const content = n['content'];
    if (!Array.isArray(content)) return n;
    return {
      ...n,
      content: (content as Json[])
        .filter((c) => c['type'] !== 'role_def' && c['type'] !== 'form_field')
        .map(walk),
    };
  };
  return walk(clone as unknown as Json);
}

const PLAIN = plainJson();
const intro = () => posInside(schema.nodeFromJSON(PLAIN), 'pIntro0000000001');

const field = (id: string): Record<string, unknown> => ({
  stepType: 'replace',
  from: intro(),
  to: intro(),
  slice: {
    content: [
      {
        type: 'form_field',
        attrs: { id, key: `text_${id.slice(-2)}`, kind: 'text', label: 'Name' },
      },
    ],
  },
});

async function plainPlane(): Promise<{ p: Plane; doc: string }> {
  const p = await startPlane();
  planes.push(p);
  const doc = await p.createDocument({ requires: [] });
  // The default checkpoint holds the document with a role and a field, which `requires: []` forbids.
  await p.checkpoints.put(p.ref(doc), 0, {
    cdm: 1,
    requires: [],
    doc: PLAIN as unknown as JsonEnvelope['doc'],
  });
  return { p, doc };
}

describe('the room lets `requires` grow (UX-107 criterion 3)', () => {
  it('refuses the first field while a client lacks `fields`, with `requires` unchanged, and accepts it once that client left', async () => {
    const { p, doc } = await plainPlane();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    expect((await bob.open(1, doc, { features: ['presence', 'regions'] })).t).toBe('ch.opened');

    const refused = await alice.submit(1, { base: 0, steps: [field('ffFieldAA0000001')] });
    expect(refused.t).toBe('sync.reject');
    expect(refused.d).toMatchObject({ code: 'conflict' });
    expect(String(refused.d!['message'])).toContain('fields');
    expect((await p.stores.documents.get(p.ref(doc)))!.requires).toEqual([]);
    expect(await p.stores.logs.read(p.ref(doc))).toEqual([]);

    bob.close();
    // The room notices the closed channel on its own turn.
    let acked: Awaited<ReturnType<typeof alice.submit>> | null = null;
    for (let i = 0; i < 40 && acked === null; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const r = await alice.submit(1, { base: 0, steps: [field('ffFieldAA0000002')] });
      if (r.t === 'sync.ack') acked = r;
    }
    expect(acked?.t).toBe('sync.ack');
    // Stored with the commit and in the document's record, sorted.
    const [commit] = await p.stores.logs.read(p.ref(doc));
    expect(commit?.requires).toEqual(['fields']);
    expect((await p.stores.documents.get(p.ref(doc)))!.requires).toEqual(['fields']);
  });

  it('refuses a client that connects later without `fields` with unsupported_feature', async () => {
    const { p, doc } = await plainPlane();
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    const grown = await alice.submit(1, { base: 0, steps: [field('ffFieldAA0000003')] });
    expect(grown.t).toBe('sync.ack');
    const carol = await p.client('carol', { [doc]: 'editor' });
    const late = await carol.open(1, doc, { features: ['presence', 'regions'] });
    expect(late.t).toBe('ch.rejected');
    expect(late.d).toMatchObject({ code: 'unsupported_feature' });
    const dave = await p.client('dave', { [doc]: 'editor' });
    expect((await dave.open(1, doc)).t).toBe('ch.opened');
  });

  it('leaves `requires` alone when the commit adds no feature', async () => {
    const { p, doc } = await plainPlane();
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'x')] })).t).toBe(
      'sync.ack',
    );
    const [commit] = await p.stores.logs.read(p.ref(doc));
    expect(commit?.requires).toBeUndefined();
    expect((await p.stores.documents.get(p.ref(doc)))!.requires).toEqual([]);
  });
});

describe('the grown list is part of the stored commit (UX-107 criterion 3)', () => {
  const base = {
    seq: 1,
    id: uuid7(),
    kind: 'steps' as const,
    steps: [],
    user: 'alice',
    session: 's1',
    time: 1_800_000_000_000,
    origin: 'typing',
    scopes: ['body'],
    revision: 1,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  };

  it('is in the payload of a commit that added a feature, and in no other', () => {
    const grown = encodeCommit('d', { ...base, requires: ['fields'] });
    const plain = encodeCommit('d', base);
    expect(decodePayload(grown.payload).requires).toEqual(['fields']);
    expect(decodePayload(plain.payload).requires).toBeUndefined();
    // A commit without the member hashes as it did before the member existed.
    expect(JSON.stringify(decodePayload(plain.payload))).not.toContain('requires');
    expect(Buffer.compare(grown.payloadHash, plain.payloadHash)).not.toBe(0);
  });

  it('gives the list a replay ends with: the last commit that carried one, else the start', () => {
    expect(requiresAfter([], [])).toEqual([]);
    expect(requiresAfter(['a'], [{}, {}])).toEqual(['a']);
    expect(requiresAfter([], [{ requires: ['fields'] }, {}])).toEqual(['fields']);
    expect(requiresAfter([], [{ requires: ['fields'] }, { requires: ['fields', 'sign'] }])).toEqual(
      ['fields', 'sign'],
    );
  });
});
