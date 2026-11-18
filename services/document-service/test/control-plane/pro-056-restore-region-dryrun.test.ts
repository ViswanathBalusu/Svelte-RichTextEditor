// Restore a document or a region, with a dry run first (PRO-056; 05 §6.2; 08 §8; HIS-018, HIS-019,
// HIS-021), over HTTP with the real data plane behind the route, in memory and PostgreSQL storage.
//   seq 0 the fixture with text in two regions; seq 1 and seq 2 are replacements made with PUT
//   /content (origin import) that change the text of both regions.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const OPEN = 'rOpen00000000001';
const LEGAL = 'rLegal0000000001';

/** The fixture with text in the paragraph of the open region and in the legal paragraph. */
function version(n: number): Record<string, unknown> {
  const doc = JSON.parse(JSON.stringify(documentWithRegions())) as Record<string, unknown>;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const x = node as { type?: string; attrs?: { id?: string }; content?: unknown[] };
    if (x.type === 'paragraph' && x.attrs?.id === 'pOpen00000000001')
      x.content = [{ type: 'text', text: `Open v${n}` }];
    if (x.type === 'paragraph' && x.attrs?.id === 'pLegal0000000001')
      x.content = [{ type: 'text', text: `Liability v${n}` }];
    for (const c of x.content ?? []) walk(c);
  };
  walk(doc['doc']);
  return doc;
}

/** The text of the paragraph `id` in a content JSON. */
function textOf(doc: unknown, id: string): string | null {
  let found: string | null = null;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const x = node as {
      type?: string;
      attrs?: { id?: string };
      text?: string;
      content?: unknown[];
    };
    if (x.type === 'paragraph' && x.attrs?.id === id)
      found = (x.content ?? []).map((c) => (c as { text?: string }).text ?? '').join('');
    for (const c of x.content ?? []) walk(c);
  };
  walk(doc);
  return found;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`restore a region and dry runs over HTTP (${storage}, PRO-056)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let doc: string;
    let ref: DocRef;
    let owner: string;
    let editor: string;
    let restoredAt = 0;

    const etag = async () =>
      (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).headers.get(
        'etag',
      );
    const head = async () =>
      (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).json;
    const restore = (body: Record<string, unknown>, token = owner) =>
      h.call('POST', `/v1/documents/${doc}/restore`, {
        token,
        headers: { 'Idempotency-Key': randomUUID() },
        body,
      });
    const restoredEvents = () =>
      h.events.events.filter((e) => e.subject === doc && e.type === 'dep.version.restored.v1');

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
      doc = await h.createDocument({ content: version(0), title: 'Restore region' });
      ref = { tenant: h.tenant, doc };
      for (const n of [1, 2]) {
        const r = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: version(n),
          headers: { 'If-Match': (await etag())! },
        });
        expect(r.status).toBe(204);
      }
      owner = h.userToken({ [doc]: 'owner' });
      editor = h.userToken({ [doc]: 'editor' }, { sub: 'erin' });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'a dry run returns what would change and stores nothing (criterion 1)',
      async () => {
        const grantsBefore = (await h.parts.grants.current(ref)).revision;
        const r = await restore({ toSeq: 0, dryRun: true });
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({ dryRun: true, toSeq: 0, headSeq: 2, kind: 'snapshot' });
        expect(r.json.comparison.changes.length).toBeGreaterThan(0);
        // Nothing stored: the head, the versions, the events and the grants are as they were.
        expect((await head()).seq).toBe(2);
        expect(await h.parts.versions!.list(ref, { kind: 'pre-restore' })).toEqual([]);
        expect(await h.parts.versions!.list(ref, { kind: 'restore' })).toEqual([]);
        expect(restoredEvents()).toEqual([]);
        expect((await h.parts.grants.current(ref)).revision).toBe(grantsBefore);
      },
    );

    it.skipIf(skip)('a dry run of one region compares only that region (criterion 1)', async () => {
      const r = await restore({ toSeq: 0, region: OPEN, dryRun: true }, editor);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ dryRun: true, region: OPEN, kind: 'steps', unchanged: false });
      const regions = new Set(r.json.comparison.changes.map((c: { region?: string }) => c.region));
      expect(regions).toEqual(new Set([OPEN]));
      expect((await head()).seq).toBe(2);
      // HIS-021 criterion 2: no version and no event either.
      expect(await h.parts.versions!.list(ref, { kind: 'pre-restore' })).toEqual([]);
      expect(await h.parts.versions!.list(ref, { kind: 'restore' })).toEqual([]);
      expect(restoredEvents()).toEqual([]);
      expect(textOf((await head()).doc, 'pOpen00000000001')).toBe('Open v2');
    });

    it.skipIf(skip)('refuses a whole-document restore without manage (criterion 2)', async () => {
      const r = await restore({ toSeq: 0 }, editor);
      expect(r.status).toBe(403);
      const dry = await restore({ toSeq: 0, dryRun: true }, editor);
      expect(dry.status).toBe(403);
      expect((await head()).seq).toBe(2);
    });

    it.skipIf(skip)(
      'refuses a region restore without edit in that region (criterion 3)',
      async () => {
        // The legal region is restricted: an editor without a grant on it has no edit there.
        const noGrant = await restore({ toSeq: 0, region: LEGAL }, editor);
        expect(noGrant.status).toBe(403);
        const viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'vera' });
        expect((await restore({ toSeq: 0, region: OPEN }, viewer)).status).toBe(403);
        expect((await head()).seq).toBe(2);
      },
    );

    it.skipIf(skip)(
      'refuses a region that is approved or leased to someone else (criterion 3)',
      async () => {
        const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
        const actor = (await h.parts.users.resolve(h.tenant, 'erin')).surrogate;
        await h.parts.grants.change(
          ref,
          {
            setRegionStates: [
              { region: OPEN, state: 'approved', approval: { seq: 2, hash: 'a'.repeat(64) } },
            ],
          },
          { actor },
        );
        const approved = await restore({ toSeq: 0, region: OPEN }, editor);
        expect(approved.status).toBe(409);
        expect(approved.json.code).toBe('conflict');
        await h.parts.grants.change(
          ref,
          {
            clearRegionStates: [OPEN],
            putLeases: [{ region: OPEN, holder: bob, expiresAt: h.now() + 3_600_000 }],
          },
          { actor },
        );
        const leased = await restore({ toSeq: 0, region: OPEN }, editor);
        expect(leased.status).toBe(409);
        await h.parts.grants.change(ref, { removeLeases: [OPEN] }, { actor });
        expect((await head()).seq).toBe(2);
      },
    );

    it.skipIf(skip)(
      'restores one region as a steps commit, keeps the rest and the grants, and sends the events (criteria 3, 4, 5)',
      async () => {
        const grantsBefore = (await h.parts.grants.current(ref)).revision;
        // The grant changes made above may have left a control commit; the head is read, not assumed.
        const before = (await head()).seq;
        const r = await restore({ toSeq: 0, region: OPEN }, editor);
        expect(r.status).toBe(200);
        // The room may record the control commit of the earlier grant changes just before it.
        const seq = r.json.seq as number;
        expect(seq).toBeGreaterThan(before);
        expect(r.json).toEqual({ seq, toSeq: 0, preRestoreSeq: before, region: OPEN });
        const now = await head();
        expect(now.seq).toBe(seq);
        // The region has its text of seq 0; the other region keeps the text of seq 2.
        expect(textOf(now.doc, 'pOpen00000000001')).toBe('Open v0');
        expect(textOf(now.doc, 'pLegal0000000001')).toBe('Liability v2');
        // A steps commit of origin restore (HIS-018, ADR 0408), not a snapshot; the earlier commits
        // are untouched.
        const [commit] = await h.parts.logs.read(ref, seq, seq);
        expect(commit).toMatchObject({ seq, kind: 'steps', origin: 'restore' });
        expect(commit).not.toHaveProperty('snapshot');
        expect((await h.parts.logs.read(ref, 1, 2)).map((c) => c.seq)).toEqual([1, 2]);
        expect(
          (await h.parts.versions!.list(ref, { kind: 'pre-restore' })).map((v) => v.seq),
        ).toEqual([before]);
        expect((await h.parts.versions!.list(ref, { kind: 'restore' })).map((v) => v.seq)).toEqual([
          seq,
        ]);
        restoredAt = seq;
        // Grants are not restored: the revision is the one before.
        expect((await h.parts.grants.current(ref)).revision).toBe(grantsBefore);
        // Criterion 5: the event is raised for the restore.
        const events = restoredEvents();
        expect(events.length).toBe(1);
        expect(events[0]!.data).toMatchObject({ seq });
      },
    );

    it.skipIf(skip)('a restore that changes nothing stores nothing (criterion 3)', async () => {
      // The region is as it was at the restore's own seq, so restoring it there changes nothing.
      const r = await restore({ toSeq: restoredAt, region: OPEN }, editor);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ unchanged: true, seq: restoredAt });
      expect((await head()).seq).toBe(restoredAt);
      expect(restoredEvents().length).toBe(1);
    });

    it.skipIf(skip)('refuses an unknown region and a seq above the head', async () => {
      expect((await restore({ toSeq: 0, region: 'rNoSuch000000001' }, editor)).status).toBe(404);
      expect((await restore({ toSeq: 9, region: OPEN }, editor)).status).toBe(404);
      expect((await restore({ toSeq: 9, dryRun: true })).status).toBe(404);
    });
  });
}
