// Read markers and the activity list over HTTP (PRO-058; HIS-027 criteria 1 to 4; 08 §10; 05 §6.2),
// with in-memory storage and with PostgreSQL (lane V-PRO-052-068). The commits are appended as a
// room would append them, through the log store; the harness runs no room.
import { NOTHING_HIDDEN, type Visibility } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
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

/** A position inside the first text block of the document, where a text step can go. */
function textPosition(doc: unknown): number {
  const root = cdmSchema().nodeFromJSON(doc);
  let found = -1;
  root.descendants((n, pos) => {
    if (found < 0 && n.isTextblock) found = pos + 1;
    return found < 0;
  });
  if (found < 0) throw new Error('no text block');
  return found;
}

/** Appends one commit per entry, as the room would, for the given user surrogate. */
async function appendBy(
  h: Harness,
  doc: string,
  user: string,
  pos: number,
  scopes: string[] = ['body'],
): Promise<number> {
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
    scopes,
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
  describe(`read markers and activity over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let doc: string;
    let bob: string;
    let alice: string;
    let pos: number;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {});
      doc = await h.createDocument({ content: documentWithRegions(), title: 'Activity' });
      alice = (await h.parts.users.resolve(h.tenant, 'alice')).surrogate;
      bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
      // seq 1 by bob, seq 2 by alice (the caller's own), seq 3 by bob.
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      pos = textPosition(content.json.doc);
      await appendBy(h, doc, bob, pos);
      await appendBy(h, doc, alice, pos);
      await appendBy(h, doc, bob, pos);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'lists the changes of others since no marker, and not the caller own (criterion 3)',
      async () => {
        const owner = h.userToken({ [doc]: 'owner' });
        const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token: owner });
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({ marker: 0, head: 3, nextCursor: null });
        expect(r.json.items.map((i: { seq: number }) => i.seq)).toEqual([1, 3]);
        expect(r.json.items[0]).toMatchObject({
          user: 'bob',
          origin: 'input',
          kind: 'steps',
          scopes: ['body'],
        });
      },
    );

    it.skipIf(skip)(
      'stores the marker per caller and document and only moves it forward (criteria 1, 2)',
      async () => {
        const owner = h.userToken({ [doc]: 'owner' });
        const set = (seq: number) =>
          h.call('PUT', `/v1/documents/${doc}/read-marker`, {
            token: owner,
            body: { seq },
            headers: { 'If-Match': '*' },
          });
        expect((await set(2)).json).toEqual({ seq: 2 });
        expect((await set(1)).json).toEqual({ seq: 2 });
        const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token: owner });
        expect(r.json).toMatchObject({ marker: 2 });
        expect(r.json.items.map((i: { seq: number }) => i.seq)).toEqual([3]);
        // Another caller has no marker of their own.
        const viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'carol' });
        const other = await h.call('GET', `/v1/documents/${doc}/activity`, { token: viewer });
        expect(other.json.marker).toBe(0);
      },
    );

    it.skipIf(skip)('lists only the changes the history gate allows (criterion 4)', async () => {
      // The document's history visibility is `editors`: a viewer sees nothing below the head.
      const viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'carol' });
      const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token: viewer });
      expect(r.status).toBe(200);
      expect(r.json.items.map((i: { seq: number }) => i.seq)).toEqual([3]);
    });

    it.skipIf(skip)(
      'later changes of others appear once, and the list is refused to a service credential (criteria 1, 3)',
      async () => {
        await appendBy(h, doc, bob, pos);
        const owner = h.userToken({ [doc]: 'owner' });
        const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token: owner });
        expect(r.json.items.map((i: { seq: number }) => i.seq)).toEqual([3, 4]);
        const service = await h.call('GET', `/v1/documents/${doc}/activity`, { token: h.apiKey });
        expect(service.status).toBe(403);
        expect(service.json.code).toBe('forbidden');
      },
    );

    it.skipIf(skip)('lists nothing once the caller marker is at the head', async () => {
      const owner = h.userToken({ [doc]: 'owner' });
      await h.call('PUT', `/v1/documents/${doc}/read-marker`, {
        token: owner,
        body: { seq: 4 },
        headers: { 'If-Match': '*' },
      });
      const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token: owner });
      expect(r.json.items).toEqual([]);
    });
  });

  describe(`activity for a reader restricted from one region (${storage})`, async () => {
    const skip = await skipReason(storage);
    const LEGAL = 'rLegal0000000001';
    // The legal region is hidden from everyone but owners (the policy of be-098-read-sweep).
    const visibility: Visibility = (conn) =>
      conn.role === 'owner'
        ? NOTHING_HIDDEN
        : { regions: new Set([LEGAL]), values: new Set(), titles: false };
    let h: Harness;
    let doc: string;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { views: { ...FULL_VIEWS, visibility } });
      doc = await h.createDocument({
        content: documentWithRegions(),
        title: 'Restricted activity',
      });
      const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      const pos = textPosition(content.json.doc);
      // seq 1 in the body, seq 2 in the hidden region, seq 3 in the body and the hidden region.
      await appendBy(h, doc, bob, pos);
      await appendBy(h, doc, bob, pos, [`region:${LEGAL}`]);
      await appendBy(h, doc, bob, pos, ['body', `region:${LEGAL}`]);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'projects the list: changes touching a hidden region are left out, and no item names it',
      async () => {
        const editor = h.userToken({ [doc]: 'editor' }, { sub: 'carol' });
        const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token: editor });
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({ head: 3, nextCursor: null });
        expect(r.json.items.map((i: { seq: number }) => i.seq)).toEqual([1]);
        expect(r.text).not.toContain(LEGAL);
      },
    );

    it.skipIf(skip)('lists every change to an owner, who sees the whole document', async () => {
      const owner = h.userToken({ [doc]: 'owner' }, { sub: 'carol' });
      const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token: owner });
      expect(r.status).toBe(200);
      expect(r.json.items.map((i: { seq: number }) => i.seq)).toEqual([1, 2, 3]);
      expect(r.json.items[1].scopes).toEqual([`region:${LEGAL}`]);
    });
  });
}
