/**
 * SEC-019 criterion 4 (lane V-SEC-017-032), over the wire: a thread or comment request that names
 * another author is stored with the caller as author (10 §3.2; 05 §5.4; 07 §12 row 5). The thread
 * routes of PRO-059 and PRO-060 are served now, so this drives `POST /v1/documents/{id}/threads` and
 * `POST /v1/threads/{tid}/comments` through the real service, memory and PostgreSQL, and reads the
 * stored rows from the service's thread store. Each request carries the claimed identities that the
 * wire could carry: `author`, `createdBy`, `user`, `session` and `agent` in the thread body, and an
 * `author` field inside the comment body. The stored author must be the token's subject.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';

const OWNER_SUB = 'olivia-v-sec-019';
const EDITOR_SUB = 'edna-v-sec-019';
const CLAIMED = 'mallory-v-sec-019';

interface ThreadStoreLike {
  get(
    tenant: string,
    id: string,
  ): Promise<{
    id: string;
    createdBy: string;
    comments: { id: string; author: string; body: unknown }[];
  } | null>;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-019 thread and comment authors come from the caller (${storage})`, () => {
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);
    const store = () => (h.parts as unknown as { threads: ThreadStoreLike }).threads;

    t()(
      'a thread request that names another author is stored with the caller as author',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const token = await h.mintToken(h.a, OWNER_SUB, { [doc]: 'owner' });
        const res = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token,
          body: {
            target: { block: 'pIntro0000000001' },
            comment: { body: 'Check this clause.' },
            author: CLAIMED,
            createdBy: CLAIMED,
            user: CLAIMED,
            session: `s-${CLAIMED}`,
            agent: CLAIMED,
          },
        });
        expect(res.status).toBe(201);
        const stored = await store().get(h.a.id, res.json.id);
        expect(stored, 'the thread is stored').not.toBeNull();
        // The stored author is the connection's surrogate (not the claimed name): the first comment
        // carries the same author as the thread, and neither carries the claimed identity.
        expect(stored!.createdBy).toBeTruthy();
        expect(stored!.createdBy).not.toBe(CLAIMED);
        expect(stored!.comments[0]!.author).toBe(stored!.createdBy);
        expect(JSON.stringify(stored)).not.toContain(CLAIMED);
      },
    );

    t()(
      'a comment request that names another author is stored with the caller as author',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const owner = await h.mintToken(h.a, OWNER_SUB, { [doc]: 'owner' });
        const editor = await h.mintToken(h.a, EDITOR_SUB, { [doc]: 'editor' });
        const created = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: owner,
          body: { target: { block: 'pIntro0000000001' }, comment: { body: 'Thread.' } },
        });
        expect(created.status).toBe(201);
        const tid = created.json.id as string;

        const reply = await h.call('POST', `/v1/threads/${tid}/comments`, {
          token: editor,
          body: { body: 'A reply.', author: CLAIMED, createdBy: CLAIMED, user: CLAIMED },
        });
        expect(reply.status).toBe(201);
        const stored = await store().get(h.a.id, tid);
        const mine = stored!.comments.find((c) => c.id === reply.json.id);
        expect(mine, 'the reply is stored').toBeDefined();
        // The reply's author is the editor's surrogate: not the claimed name, and not the owner's.
        expect(mine!.author).not.toBe(CLAIMED);
        expect(mine!.author).not.toBe(stored!.createdBy);
        expect(mine!.author).toBeTruthy();
      },
    );
  });
}
