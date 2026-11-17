// Compare versions and read attribution over HTTP (PRO-055; 05 §6.2; 08 §6, §7; HIS-011, HIS-014,
// HIS-015, HIS-024), with in-memory storage and with PostgreSQL. The commits are appended as a room
// would append them, through the log store; the harness runs no room.
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const typing = (pos: number, text: string) => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] },
});

/** A position inside the first text block of the document, and the block's identifier. */
function firstText(doc: unknown): { pos: number; block: string } {
  const root = cdmSchema().nodeFromJSON(doc);
  let found: { pos: number; block: string } | null = null;
  root.descendants((n, pos) => {
    if (!found && n.isTextblock) found = { pos: pos + 1, block: String(n.attrs['id']) };
    return !found;
  });
  if (!found) throw new Error('no text block');
  return found;
}

/** Appends one steps commit by `user`, as the room would, and returns its seq. */
async function appendBy(h: Harness, doc: string, user: string, pos: number): Promise<number> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const commit = {
    seq: head.seq + 1,
    id: uuid7(),
    kind: 'steps' as const,
    steps: [typing(pos, 'x')] as never,
    user,
    session: 'session-test',
    time: h.now(),
    origin: 'input',
    scopes: ['body'],
    revision: perms.revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  };
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits: [commit],
  });
  if (r.status !== 'ok') throw new Error(`append refused: ${r.status}`);
  return head.seq + 1;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`compare versions and read attribution over HTTP (${storage}, PRO-055)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let doc: string;
    let block: string;
    let owner: string;
    let viewer: string;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {});
      doc = await h.createDocument({ content: documentWithRegions(), title: 'Compare' });
      const alice = (await h.parts.users.resolve(h.tenant, 'alice')).surrogate;
      const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      const at = firstText(content.json.doc);
      block = at.block;
      // seq 1 by bob, seq 2 by alice, seq 3 by bob: each inserts one character at the same place.
      await appendBy(h, doc, bob, at.pos);
      await appendBy(h, doc, alice, at.pos);
      await appendBy(h, doc, bob, at.pos);
      owner = h.userToken({ [doc]: 'owner' });
      viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'carol' });
    });
    afterAll(async () => {
      await h?.close();
    });

    const diff = (query: string, token?: string) =>
      h.call('GET', `/v1/documents/${doc}/diff?${query}`, { token: token ?? owner });
    const attribution = (query: string, token?: string) =>
      h.call('GET', `/v1/documents/${doc}/attribution${query ? `?${query}` : ''}`, {
        token: token ?? owner,
      });

    it.skipIf(skip)(
      'returns the comparison between two versions with who wrote each change (criterion 1)',
      async () => {
        const r = await diff('fromSeq=0&toSeq=3');
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({
          fromSeq: 0,
          toSeq: 3,
          method: 'steps',
          granularity: 'word',
        });
        const change = r.json.changes.find((c: { blockId?: string }) => c.blockId === block);
        expect(change).toMatchObject({ kind: 'modified' });
        const inserts = change.spans.filter((s: { op: string }) => s.op === 'insert');
        expect(inserts.map((s: { user: string; seq: number }) => [s.user, s.seq])).toEqual(
          expect.arrayContaining([
            ['bob', 1],
            ['alice', 2],
            ['bob', 3],
          ]),
        );
      },
    );

    it.skipIf(skip)('takes a granularity of char and a region (criterion 1)', async () => {
      const chars = await diff('fromSeq=1&toSeq=2&granularity=char');
      expect(chars.status).toBe(200);
      expect(chars.json.granularity).toBe('char');
      const region = await diff('fromSeq=0&toSeq=3&region=rLegal0000000001');
      expect(region.status).toBe(200);
      expect(region.json.region).toBe('rLegal0000000001');
      for (const c of region.json.changes) expect(c.region).toBe('rLegal0000000001');
    });

    it.skipIf(skip)('refuses a granularity other than word or char (criterion 4)', async () => {
      const r = await diff('fromSeq=0&toSeq=3&granularity=line');
      expect(r.status).toBe(400);
      expect(r.json.code).toBe('validation_failed');
    });

    it.skipIf(skip)('refuses a missing or malformed seq, and a reversed range', async () => {
      expect((await diff('toSeq=3')).json.code).toBe('validation_failed');
      expect((await diff('fromSeq=a&toSeq=3')).json.code).toBe('validation_failed');
      expect((await diff('fromSeq=3&toSeq=1')).json.code).toBe('validation_failed');
      expect((await diff('fromSeq=0&toSeq=9')).status).toBe(404);
    });

    it.skipIf(skip)(
      'refuses a version below the caller gate on both routes (criterion 3)',
      async () => {
        // The history visibility is `editors`: a viewer sees the head only.
        const low = await diff('fromSeq=1&toSeq=3', viewer);
        expect(low.status).toBe(403);
        expect(low.json.code).toBe('forbidden');
        const atHead = await diff('fromSeq=3&toSeq=3', viewer);
        expect(atHead.status).toBe(200);
        expect(atHead.json.changes).toEqual([]);
        const old = await attribution('seq=1', viewer);
        expect(old.status).toBe(403);
        expect((await attribution('', viewer)).status).toBe(200);
      },
    );

    it.skipIf(skip)('says who wrote which spans of a block at the head (criterion 2)', async () => {
      const r = await attribution('');
      expect(r.status).toBe(200);
      expect(r.json.seq).toBe(3);
      const spans = r.json.spans.filter((s: { blockId: string }) => s.blockId === block);
      expect(spans.slice(0, 3).map((s: { user: string; seq: number }) => [s.user, s.seq])).toEqual([
        ['bob', 3],
        ['alice', 2],
        ['bob', 1],
      ]);
      expect(spans[0]).toMatchObject({ from: 0, to: 1 });
      // The original text keeps the creator of the document at seq 0.
      expect(spans[3]).toMatchObject({ seq: 0, from: 3 });
    });

    it.skipIf(skip)(
      'reads attribution at an earlier seq, for a region and for blocks (criterion 2)',
      async () => {
        const r = await attribution('seq=2');
        expect(r.json.seq).toBe(2);
        const spans = r.json.spans.filter((s: { blockId: string }) => s.blockId === block);
        expect(spans.slice(0, 2).map((s: { user: string }) => s.user)).toEqual(['alice', 'bob']);
        const some = await attribution(`blocks=${block}`);
        expect(some.status).toBe(200);
        expect(new Set(some.json.spans.map((s: { blockId: string }) => s.blockId))).toEqual(
          new Set([block]),
        );
        expect((await attribution('region=rLegal0000000001')).status).toBe(200);
        expect((await attribution('region=rNoSuchRegion001')).status).toBe(404);
        expect((await attribution('blocks=nosuchblock00001')).status).toBe(404);
        expect((await attribution('seq=9')).status).toBe(404);
        expect((await attribution('seq=x')).status).toBe(400);
      },
    );

    it.skipIf(skip)('is refused to a token that does not cover the document', async () => {
      const stranger = h.userToken({ [uuid7()]: 'owner' });
      expect((await diff('fromSeq=0&toSeq=3', stranger)).status).toBe(403);
      expect((await attribution('', stranger)).status).toBe(403);
    });
  });
}
