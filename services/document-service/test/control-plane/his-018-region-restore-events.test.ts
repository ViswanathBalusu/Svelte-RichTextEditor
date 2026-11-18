// HIS-018 criteria 1 (versions) and 6 (events), over HTTP with a live channel (lane w7; 08 §8;
// 05 §5.6). A region restore records a `pre-restore` version at the old head, applies the commit
// with origin `restore`, records a `restore` version at the new head, raises the webhook
// `dep.version.restored` and sends the channel event `version.restored` with the region named.
// Memory and PostgreSQL. Test values only.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const OPEN = 'rOpen00000000001';

/** The fixture with text in the paragraph of the open region. */
function version(n: number): Record<string, unknown> {
  const doc = JSON.parse(JSON.stringify(documentWithRegions())) as Record<string, unknown>;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const x = node as { type?: string; attrs?: { id?: string }; content?: unknown[] };
    if (x.type === 'paragraph' && x.attrs?.id === 'pOpen00000000001')
      x.content = [{ type: 'text', text: `Open v${n}` }];
    for (const c of x.content ?? []) walk(c);
  };
  walk(doc['doc']);
  return doc;
}

const clients: DepClient[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const h of harnesses.splice(0)) await h.close();
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a region restore records its versions and tells everyone (${storage}, HIS-018)`, async () => {
    const skip = await skipReason(storage);

    it.skipIf(skip)(
      'records pre-restore and restore versions and raises the webhook and the channel event (criteria 1 and 6)',
      async () => {
        const h = await startHarness(storage, {
          realDataPlane: true,
          config: { testMode: true, environment: 'test' },
        });
        harnesses.push(h);
        const doc = await h.createDocument({ content: version(0), title: 'Restore region' });
        const ref = { tenant: h.tenant, doc };
        const head = async () =>
          await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        for (const n of [1, 2]) {
          const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
            token: h.apiKey,
            body: version(n),
            headers: { 'If-Match': (await head()).headers.get('etag')! },
          });
          expect(put.status, put.text).toBe(204);
        }
        const editorToken = h.userToken({ [doc]: 'editor' }, { sub: 'erin' });
        const watcher = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(watcher);
        expect((await watcher.hello(editorToken)).t).toBe('welcome');
        expect((await watcher.open(1, doc)).t).toBe('ch.opened');

        const before = (await head()).json.seq as number;
        const r = await h.call('POST', `/v1/documents/${doc}/restore`, {
          token: editorToken,
          headers: { 'Idempotency-Key': randomUUID() },
          body: { toSeq: 0, region: OPEN },
        });
        expect(r.status, r.text).toBe(200);
        const seq = r.json.seq as number;
        expect(seq).toBeGreaterThan(before);
        expect(r.json).toMatchObject({ toSeq: 0, preRestoreSeq: before, region: OPEN });

        // Criterion 1: the versions are written in order, one at the old head, one at the new.
        expect(
          (await h.parts.versions!.list(ref, { kind: 'pre-restore' })).map((v) => v.seq),
        ).toEqual([before]);
        expect((await h.parts.versions!.list(ref, { kind: 'restore' })).map((v) => v.seq)).toEqual([
          seq,
        ]);
        const [commit] = await h.parts.logs.read(ref, seq, seq);
        expect(commit).toMatchObject({ seq, origin: 'restore' });

        // Criterion 6: the webhook event, and the event on the open channel with the region named.
        const hooks = h.events.events.filter(
          (e) => e.subject === doc && e.type === 'dep.version.restored.v1',
        );
        expect(hooks.length).toBe(1);
        expect(hooks[0]!.data).toMatchObject({ seq });
        const event = (
          await watcher.take(
            (m) => m.t === 'event' && m.d?.type === 'version.restored',
            3000,
            'version.restored',
          )
        ).d as { resource: string; data: Record<string, unknown> };
        expect(event.resource).toBe(`/documents/${doc}/versions`);
        expect(event.data).toEqual({ seq, toSeq: 0, region: OPEN });
      },
    );
  });
}
