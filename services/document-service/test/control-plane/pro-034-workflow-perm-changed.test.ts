// PRO-034 criterion 3: a workflow transition that changes what is allowed sends `perm.changed`
// with a higher `rev` than the connection had, in addition to the `wf.changed` of 12 §10. The
// transition is the real send route (FRW-027) against the real data plane, on memory storage and,
// when the test environment is up, on PostgreSQL in Podman.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import { until } from '../data-plane/support.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9d',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [{ id: 'p1', roles: ['reviewer'], kind: 'approver', order: 1 }],
});

/** The regions fixture with one role that has a participant, and no field to fill. */
function content(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'reviewer', name: 'Reviewer', color: '#1F77B4' },
  });
  return d as unknown as Record<string, unknown>;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a workflow transition and perm.changed (${storage}; PRO-034)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const clients: DepClient[] = [];
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    it.skipIf(skip)(
      'sends perm.changed with a higher rev before wf.changed when send locks the document (criterion 3)',
      async () => {
        const doc = await h.createDocument({ content: content() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-034-${uuid7()}` });
        const editor = h.userToken({ [doc]: 'editor' }, { sub: `editor-034-${uuid7()}` });
        const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
          token: owner,
          body: BODY(doc),
          headers: { 'if-match': '"0"' },
        });
        expect(made.status, made.text).toBe(201);

        const opened = new Map<string, number>();
        const open = async (name: string, token: string): Promise<DepClient> => {
          const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
          clients.push(c);
          expect((await c.hello(token)).t).toBe('welcome');
          const ch = await c.open(1, doc);
          expect(ch.t).toBe('ch.opened');
          opened.set(name, (ch.d!['access'] as { rev: number }).rev);
          return c;
        };
        const connections = [
          ['owner', await open('owner', owner)],
          ['editor', await open('editor', editor)],
        ] as const;

        const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
        expect(sent.status, sent.text).toBe(200);

        for (const [name, c] of connections) {
          await until(() => c.all('wf.changed', 1).length > 0, 5000, `wf.changed for ${name}`);
          const changes = c.all('perm.changed', 1);
          expect(changes.length, name).toBeGreaterThan(0);
          const rev = (changes.at(-1)!.d as { rev: number }).rev;
          expect(rev, name).toBeGreaterThan(opened.get(name)!);
          // perm.changed comes first, so the access a wf.changed implies is already in force.
          const order = c.log
            .filter((m) => m.ch === 1 && (m.t === 'perm.changed' || m.t === 'wf.changed'))
            .map((m) => m.t);
          expect(order.indexOf('perm.changed'), name).toBeLessThan(order.indexOf('wf.changed'));
        }
      },
      60_000,
    );
  });
}
