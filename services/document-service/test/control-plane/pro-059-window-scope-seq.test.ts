// Comment threads over HTTP, memory and PostgreSQL (PRO-059 criteria 2, 3 and 4; 05 section 6.2;
// 07 section 6; SYN-032; lane w5). Test values only. Commits that move the text are appended
// through the log store, as a room would append them; the harness runs no room.
//
// - criterion 2: a `baseSeq` further back than the rebase window is refused (the window is set
//   small with `maxRebaseSteps`), one inside it is mapped;
// - criterion 3: a range that, after mapping, covers a restricted region the caller may not
//   comment in is refused with `forbidden`, the REST code of a refused permission (see the story's
//   Notes about `permission_denied`);
// - criterion 4: `GET /documents/{id}/threads?seq=` reports each range mapped to that seq.
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { checkProblem } from '@docedit/protocol';
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

/** The start of the text of the block `id`. */
function textStartOf(doc: unknown, id: string): number {
  const root = cdmSchema().nodeFromJSON(doc);
  let found = -1;
  root.descendants((n, pos) => {
    if (n.attrs['id'] === id) found = pos + 1;
    return found < 0;
  });
  return found;
}

/** Appends one commit that types `text` at `pos` in the body, as a room would. */
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
  describe(`comment threads: window, scope and ?seq over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { config: { maxRebaseSteps: 2 } });
    });
    afterAll(async () => {
      await h?.close();
    });

    const as = (doc: string, role: string, sub: string) => h.userToken({ [doc]: role }, { sub });
    const threads = (doc: string) => `/v1/documents/${doc}/threads`;
    const content = async (doc: string) =>
      (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).json.doc;
    const headOf = async (doc: string) => (await h.parts.logs.head({ tenant: h.tenant, doc })).seq;

    it.skipIf(skip)(
      'refuses a baseSeq further back than the rebase window and maps one inside it (criterion 2)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const p = firstTextPosition(await content(doc));
        for (let i = 0; i < 3; i += 1) await typeAt(h, doc, p, 'x');
        const head = await headOf(doc);
        expect(head).toBe(3);
        const token = as(doc, 'editor', 'ed-w');

        const outside = await h.call('POST', threads(doc), {
          token,
          body: { target: { range: { from: p, to: p + 5, baseSeq: 0 } }, comment },
        });
        expect(outside.status, outside.text).toBe(400);
        expect(outside.json.code).toBe('validation_failed');
        expect(JSON.stringify(outside.json)).toContain('rebase window');

        // Two steps back is the edge of a window of two: mapped through the last two typings.
        const inside = await h.call('POST', threads(doc), {
          token,
          body: { target: { range: { from: p + 1, to: p + 6, baseSeq: 1 } }, comment },
        });
        expect(inside.status, inside.text).toBe(201);
        expect(inside.json.target).toEqual({ range: { from: p + 3, to: p + 8, baseSeq: head } });
      },
    );

    it.skipIf(skip)(
      'refuses a range that after mapping covers a restricted region the caller may not comment in, and accepts the same range for an owner (criterion 3)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const full = await content(doc);
        const intro = firstTextPosition(full);
        const legal = textStartOf(full, 'pLegal0000000001');
        // A viewer grant on the restricted region conveys `view` only there: the commenter can
        // comment in the body but not in the legal region (07 section 4, regionCaps).
        const surrogate = (await h.parts.users.resolve(h.tenant, 'cm-1')).surrogate;
        await h.parts.grants.change(
          { tenant: h.tenant, doc },
          {
            putGrants: [
              {
                region: 'rLegal0000000001',
                principal: `user:${surrogate}`,
                role: 'viewer',
                expiresAt: null,
              },
            ],
          },
          { actor: 'system' },
        );
        // Typed text moves the legal text right by 2 after the base the range names.
        await typeAt(h, doc, intro, 'ab');
        const body = {
          target: { range: { from: legal, to: legal + 9, baseSeq: 0 } },
          comment,
        };

        const refused = await h.call('POST', threads(doc), {
          token: as(doc, 'commenter', 'cm-1'),
          body,
        });
        expect(refused.status, refused.text).toBe(403);
        expect(refused.json.code).toBe('forbidden');
        expect(checkProblem({ surface: 'rest', code: refused.json.code })).toEqual([]);

        const allowed = await h.call('POST', threads(doc), {
          token: as(doc, 'owner', 'ow-1'),
          body,
        });
        expect(allowed.status, allowed.text).toBe(201);
        expect(allowed.json.target.range.from).toBe(legal + 2);

        // The same range in the body outside any region is allowed to the commenter.
        const inBody = await h.call('POST', threads(doc), {
          token: as(doc, 'commenter', 'cm-1'),
          body: {
            target: { range: { from: intro, to: intro + 5, baseSeq: await headOf(doc) } },
            comment,
          },
        });
        expect(inBody.status, inBody.text).toBe(201);
      },
    );

    it.skipIf(skip)(
      'reports each range mapped to the seq asked for, leaves out threads made later, and refuses a seq beyond the head (criterion 4)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const p = firstTextPosition(await content(doc));
        const token = as(doc, 'editor', 'ed-l');

        const first = await h.call('POST', threads(doc), {
          token,
          body: { target: { range: { from: p, to: p + 5, baseSeq: 0 } }, comment },
        });
        expect(first.status, first.text).toBe(201);
        await typeAt(h, doc, p, 'ab'); // seq 1
        await typeAt(h, doc, p, 'cd'); // seq 2
        const second = await h.call('POST', threads(doc), {
          token,
          body: { target: { range: { from: p + 4, to: p + 9, baseSeq: 2 } }, comment },
        });
        expect(second.status, second.text).toBe(201);

        const at = async (seq?: number) => {
          const r = await h.call(
            'GET',
            `${threads(doc)}${seq === undefined ? '' : `?seq=${seq}`}`,
            { token },
          );
          expect(r.status, r.text).toBe(200);
          return r.json as {
            items: Array<{
              id: string;
              target: { range: { from: number; to: number; baseSeq: number } };
            }>;
            seq: number;
          };
        };
        const rangeOf = (l: Awaited<ReturnType<typeof at>>, id: string) =>
          l.items.find((t) => t.id === id)?.target.range;

        const atZero = await at(0);
        expect(rangeOf(atZero, first.json.id)).toEqual({ from: p, to: p + 5, baseSeq: 0 });
        // The second thread was made at seq 2: it did not exist at seq 0.
        expect(rangeOf(atZero, second.json.id)).toBeUndefined();

        const atOne = await at(1);
        expect(rangeOf(atOne, first.json.id)).toEqual({ from: p + 2, to: p + 7, baseSeq: 1 });
        expect(rangeOf(atOne, second.json.id)).toBeUndefined();

        const atHead = await at();
        expect(atHead.seq).toBe(2);
        expect(rangeOf(atHead, first.json.id)).toEqual({ from: p + 4, to: p + 9, baseSeq: 2 });
        expect(rangeOf(atHead, second.json.id)).toEqual({ from: p + 4, to: p + 9, baseSeq: 2 });
        expect((await at(2)).items.map((t) => t.id)).toEqual(atHead.items.map((t) => t.id));

        const beyond = await h.call('GET', `${threads(doc)}?seq=99`, { token });
        expect(beyond.status).toBe(400);
        expect(beyond.json.code).toBe('validation_failed');
      },
    );

    it.skipIf(skip)('pages the list and leaves threads of another document out', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const other = await h.createDocument({ content: documentWithRegions() });
      const p = firstTextPosition(await content(doc));
      const made: string[] = [];
      for (const d of [doc, doc, doc, other]) {
        const r = await h.call('POST', threads(d), {
          token: as(d, 'editor', 'ed-p'),
          body: { target: { range: { from: p, to: p + 5, baseSeq: 0 } }, comment },
        });
        expect(r.status, r.text).toBe(201);
        if (d === doc) made.push(r.json.id as string);
      }
      const token = as(doc, 'editor', 'ed-p');
      const one = await h.call('GET', `${threads(doc)}?limit=2`, { token });
      expect(one.json.items).toHaveLength(2);
      expect(one.json.nextCursor).not.toBeNull();
      const two = await h.call(
        'GET',
        `${threads(doc)}?limit=2&cursor=${encodeURIComponent(one.json.nextCursor)}`,
        { token },
      );
      const ids = [...one.json.items, ...two.json.items].map((t: { id: string }) => t.id);
      expect(ids).toEqual(made);

      // A token that does not cover the document does not learn that it has threads.
      const stranger = await h.call('GET', threads(doc), { token: as(other, 'owner', 'ow-p') });
      expect(stranger.status).toBeGreaterThanOrEqual(403);
      expect(stranger.status).toBeLessThan(500);
    });
  });
}
