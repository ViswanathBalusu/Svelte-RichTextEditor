/**
 * SEC-019 — every recorded identity comes from the authenticated connection, so history and
 * presence cannot name someone who did not act (10 §3.2; 04 G6; 05 §5.4). The adversarial client
 * injects identity fields into commits and presence and claims reserved origins.
 *
 * Threads and comments (criterion 4) are not served over the wire in phase 1a (no comments handlers).
 * The stored author is proved at the room, in thread-author.test.ts; the wire route stays open.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  insertText,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { inside, loadDoc } from './support/cdm.ts';
import { WireClient } from './support/wire.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-019 identity cannot be spoofed (${storage})`, () => {
    let h: Harness;
    let doc: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the CDM content envelope
    let content: any;
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        doc = await h.createDocument(h.a, documentWithRegions());
        content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json;
      }
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    const open = async (sub: string, role: string, features = ['regions', 'presence']) => {
      const token = await h.mintToken(h.a, sub, { [doc]: role });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      const welcome = await c.hello(token, { features });
      await c.open(1, doc, { features });
      return { c, session: welcome.d?.['session'] as string };
    };

    t()(
      'ignores extra user, session and agent fields on a commit; attribution comes from the connection',
      async () => {
        const { c } = await open('ann', 'editor');
        try {
          const introStart = inside(loadDoc(content.doc), 'pIntro0000000001');
          const id = uuid7();
          // Inject identity fields into both the payload and the envelope; the server ignores them.
          c.send({
            t: 'sync.submit',
            id: 'e1',
            ch: 1,
            user: 'intruder',
            session: 'forged-session',
            d: {
              id,
              base: 0,
              steps: [insertText(introStart, 'Z')],
              origin: 'input',
              user: 'intruder',
              session: 'forged',
              agent: 'bot',
            },
          });
          const ack = await c.take((m) => m.re === 'e1', 5000, 'the ack');
          expect(ack.t).toBe('sync.ack');

          const annSurrogate = (await h.parts.users.resolve(h.a.id, 'ann')).surrogate;
          const [stored] = await h.parts.logs.read({ tenant: h.a.id, doc }, 1, 1);
          expect(stored!.user).toBe(annSurrogate);
          expect(stored!.user).not.toBe('intruder');
          expect(stored!.session).not.toBe('forged');
          // A control commit has no agent; a client claim never becomes one.
          expect(stored!.agent ?? null).toBeNull();
        } finally {
          c.terminate();
        }
      },
    );

    t()('adds the sender identity to presence; a claimed identity is dropped', async () => {
      const a = await open('anna', 'editor');
      const b = await open('bob', 'editor');
      try {
        // A publishes a presence update that claims to be someone else.
        a.c.send({
          t: 'presence.update',
          ch: 1,
          user: 'victim',
          d: {
            seq: 0,
            state: {
              selection: { anchor: 1, head: 1 },
              scope: 'body',
              status: 'active',
              user: 'victim',
              session: 'forged',
            },
          },
        });
        const state = await b.c.take(
          (m) =>
            m.t === 'presence.state' &&
            Array.isArray(m.d?.['peers']) &&
            (m.d?.['peers'] as unknown[]).length > 0,
          5000,
          'presence',
        );
        const peer = (state.d?.['peers'] as Array<{ session: string; user: { id: string } }>)[0]!;
        expect(peer.user.id).toBe('anna'); // the wire shows the sender's host sub
        expect(peer.user.id).not.toBe('victim');
        expect(peer.session).toBe(a.session);
      } finally {
        a.c.terminate();
        b.c.terminate();
      }
    });

    t()('rejects a suggestion mark that names another user (P4)', async () => {
      const { c } = await open('sam', 'suggester');
      try {
        const introStart = inside(loadDoc(content.doc), 'pIntro0000000001');
        const r = await c.submit(1, {
          id: uuid7(),
          base: 0,
          origin: 'suggestion.accept',
          steps: [
            {
              stepType: 'replace',
              from: introStart,
              to: introStart,
              slice: {
                content: [
                  {
                    type: 'text',
                    text: 'x',
                    marks: [
                      {
                        type: 'ins',
                        attrs: {
                          id: 'sSpoof0000000001',
                          user: '00000000-0000-7000-8000-000000000000',
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        });
        expect(r.t).toBe('sync.reject');
        expect(r.d?.['code']).toBe('permission_denied');
      } finally {
        c.terminate();
      }
    });

    t()('refuses a client commit that claims a reserved server origin', async () => {
      const { c } = await open('ann', 'editor');
      try {
        const introStart = inside(loadDoc(content.doc), 'pIntro0000000001');
        for (const origin of ['restore', 'sign', 'migration', 'control']) {
          const r = await c.submit(1, {
            id: uuid7(),
            base: 0,
            origin,
            steps: [insertText(introStart, 'y')],
          });
          expect(r.t, origin).toBe('sync.reject');
          expect(r.d?.['code'], origin).toBe('invalid_op');
        }
      } finally {
        c.terminate();
      }
    });

    t()('ignores a DEP-Actor header on a user token: it confers nothing', async () => {
      const other = await h.createDocument(h.a);
      // A user token for `doc`, with DEP-Actor naming a user who may see `other`, still cannot reach
      // `other`: the header is ignored for user tokens (only service credentials act for a user).
      const token = await h.mintToken(h.a, 'ann', { [doc]: 'owner' });
      const reach = await h.call('GET', `/v1/documents/${other}`, {
        token,
        headers: { 'DEP-Actor': '00000000-0000-7000-8000-00000000aaaa' },
      });
      expect(reach.status).toBe(403);
      expect(reach.json?.code).toBe('forbidden');
      // On its own document the token works the same with or without the header.
      const withHeader = await h.call('GET', `/v1/documents/${doc}`, {
        token,
        headers: { 'DEP-Actor': 'x' },
      });
      const without = await h.call('GET', `/v1/documents/${doc}`, { token });
      expect(withHeader.status).toBe(200);
      expect(without.status).toBe(200);
    });
  });
}
