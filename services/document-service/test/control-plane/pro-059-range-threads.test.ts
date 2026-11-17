// Comment threads on a text range over HTTP, with in-memory storage and with PostgreSQL (PRO-059
// criteria 1 for a range target and 2 for its mapping; 05 section 6.2; 07 section 6; SYN-032).
// Test values only. The commit that moves the text is appended through the log store, as a room
// would append it; the harness runs no room. The rows are the `threads` table of migration 0050.
//
// The rebase window's refusal, a range in a scope without `comment` after mapping, and `?seq` are in
// pro-059-window-scope-seq.test.ts.
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

const comment = { text: 'Is this still right?' };

/** A position at the start of the first text block of the document (the text `Hello`). */
function firstTextPosition(doc: unknown): number {
  const root = cdmSchema().nodeFromJSON(doc);
  let found = -1;
  root.descendants((n, pos) => {
    if (found < 0 && n.isTextblock) found = pos + 1;
  });
  return found;
}

/** Appends one commit that types `text` at `pos` in the body, as a room would (memory or PostgreSQL). */
async function typeAt(h: Harness, doc: string, pos: number, text: string): Promise<number> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const commit = {
    seq: head.seq + 1,
    id: uuid7(),
    kind: 'steps' as const,
    steps: [
      { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } },
    ] as never,
    user: 'test-author',
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
  describe(`comment threads on a range over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    const as = (doc: string, role: string, sub: string) => h.userToken({ [doc]: role }, { sub });
    const threads = (doc: string) => `/v1/documents/${doc}/threads`;

    /** The start of the first text, read at the head. */
    const textAt = async (doc: string) => {
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      return firstTextPosition(content.json.doc);
    };

    it.skipIf(skip)(
      'starts a thread on a range at the head, and the range is stored as given (PRO-059 criterion 1, range branch)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const p = await textAt(doc);
        const head = (await h.parts.logs.head({ tenant: h.tenant, doc })).seq;
        const made = await h.call('POST', threads(doc), {
          token: as(doc, 'editor', 'ed-1'),
          body: { target: { range: { from: p, to: p + 5, baseSeq: head } }, comment },
        });
        expect(made.status, made.text).toBe(201);
        // The range carries the seq it refers to as `baseSeq` (`RangeTarget`).
        expect(made.json.target).toEqual({ range: { from: p, to: p + 5, baseSeq: head } });
        expect(made.headers.get('etag')).toBe(`"${made.json.id}:open:"`);
        const got = await h.call('GET', `/v1/threads/${made.json.id}`, {
          token: as(doc, 'viewer', 'vw-1'),
        });
        expect(got.status).toBe(200);
        expect(got.json.target).toEqual({ range: { from: p, to: p + 5, baseSeq: head } });
        expect(
          h.stub.notices.some(
            (n) =>
              n.kind === 'notify' &&
              n.notification?.type === 'thread.created' &&
              n.notification.resource === `/threads/${made.json.id}`,
          ),
        ).toBe(true);
      },
    );

    it.skipIf(skip)(
      'maps a range from its baseSeq to the head through the commits since (PRO-059 criterion 2, mapping)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const p = await textAt(doc);
        // Text is typed at the start of the paragraph after the base: the range moves right by it.
        const base = (await h.parts.logs.head({ tenant: h.tenant, doc })).seq;
        const head = await typeAt(h, doc, p, 'xy');
        const made = await h.call('POST', threads(doc), {
          token: as(doc, 'editor', 'ed-2'),
          body: { target: { range: { from: p, to: p + 5, baseSeq: base } }, comment },
        });
        expect(made.status, made.text).toBe(201);
        expect(made.json.target).toEqual({ range: { from: p + 2, to: p + 7, baseSeq: head } });
        expect(head).toBeGreaterThan(base);
      },
    );

    it.skipIf(skip)(
      'refuses a range whose baseSeq is above the head, a malformed range, and a viewer (PRO-059 criteria 2 and 3)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const p = await textAt(doc);
        const head = (await h.parts.logs.head({ tenant: h.tenant, doc })).seq;

        const above = await h.call('POST', threads(doc), {
          token: as(doc, 'editor', 'ed-3'),
          body: { target: { range: { from: p, to: p + 5, baseSeq: head + 1 } }, comment },
        });
        expect(above.status).toBeGreaterThanOrEqual(400);
        expect(above.status).toBeLessThan(500);

        const backwards = await h.call('POST', threads(doc), {
          token: as(doc, 'editor', 'ed-3'),
          body: { target: { range: { from: p + 5, to: p, baseSeq: head } }, comment },
        });
        expect(backwards.status).toBeGreaterThanOrEqual(400);
        expect(backwards.status).toBeLessThan(500);

        const viewer = await h.call('POST', threads(doc), {
          token: as(doc, 'viewer', 'vw-3'),
          body: { target: { range: { from: p, to: p + 5, baseSeq: head } }, comment },
        });
        expect(viewer.status).toBe(403);
      },
    );
  });
}
