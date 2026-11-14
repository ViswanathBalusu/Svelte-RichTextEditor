// Export requests over real HTTP for the history gate and for suggestion decisions (PRO-063
// criterion 2; PRO-065 criterion 2; 07 §8, PRM-041; 09 §10; EXP-081, EXP-082). The commits are
// appended straight to the log, as routes.commits.test.ts does, so the head is above 0.
import { NOTHING_HIDDEN, type StoredCommit, type Visibility } from '@docedit/authority';
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

const INTRO = 'pIntro0000000001';
const LEGAL = 'rLegal0000000001';

/** The legal region is hidden from everyone but owners and its grantees (as in routes.commits). */
const visibility: Visibility = (conn, _doc, perms) =>
  conn.role === 'owner' ||
  perms.grants.some((g) => g.region === LEGAL && g.principal === `user:${conn.sub}`)
    ? NOTHING_HIDDEN
    : { regions: new Set([LEGAL]), values: new Set(), titles: false };

function inside(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

/** Appends one text commit per entry of `texts`, as an editor's steps would. */
async function append(h: Harness, doc: string, user: string, texts: string[]): Promise<void> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const pos = inside(documentWithRegions()['doc'], INTRO);
  const commits = texts.map((t, i): StoredCommit => ({
    seq: head.seq + 1 + i,
    id: uuid7(),
    kind: 'steps',
    steps: [
      { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text: t }] } },
    ] as StoredCommit['steps'],
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
  }));
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits,
  });
  expect(r.status).toBe('ok');
}

function withSuggestion(): Record<string, unknown> {
  const c = documentWithRegions() as {
    doc: { content: Array<{ content: Array<{ content?: unknown[] }> }> };
  };
  c.doc.content[1]!.content[0]!.content = [
    { type: 'text', text: 'Hello' },
    {
      type: 'text',
      text: ' there',
      marks: [{ type: 'ins', attrs: { id: 'sSugg00000000002', user: 'alice' } }],
    },
  ];
  return c;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`export requests: history gate and suggestion options (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { views: { ...FULL_VIEWS, visibility } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'refuses a seq below the history gate for a viewer and allows the head and full history (PRO-063 criterion 2; PRM-041)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        await append(h, doc, 'u-test', ['a', 'b']);
        // Under the default `editors` setting a viewer sees the head only; seq 0 is below the gate.
        const viewer = h.userToken({ [doc]: 'viewer' });
        const below = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: viewer,
          body: { target: 'pdf', seq: 0 },
        });
        expect(below.status).toBe(403);
        expect(below.json.code).toBe('forbidden');
        // The head is always visible (ADR 0034).
        const atHead = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: viewer,
          body: { target: 'pdf', seq: 2 },
        });
        expect(atHead.status).toBe(202);
        expect(atHead.json).toMatchObject({ seq: 2, state: 'queued' });
        // An owner sees full history, so seq 0 is accepted for them.
        const owner = h.userToken({ [doc]: 'owner' });
        const full = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: owner,
          body: { target: 'pdf', seq: 0 },
        });
        expect(full.status).toBe(202);
        expect(full.json.seq).toBe(0);
      },
    );

    it.skipIf(skip)(
      'creates an export job for suggestion decisions reject and markup, as for accept (PRO-065 criterion 2; EXP-081, EXP-082)',
      async () => {
        const doc = await h.createDocument({ content: withSuggestion() });
        const viewer = h.userToken({ [doc]: 'viewer' });
        // Without a decision the request fails (PRO-065 criterion 1).
        const undecided = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: viewer,
          body: { target: 'pdf' },
        });
        expect(undecided.json.code).toBe('pending_suggestions');
        for (const suggestions of ['accept', 'reject', 'markup']) {
          const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
            token: viewer,
            body: { target: 'pdf', options: { suggestions } },
          });
          expect(r.status, suggestions).toBe(202);
          expect(r.json).toMatchObject({ doc, state: 'queued' });
          const job = await h.call('GET', `/v1/exports/${r.json.id}`, { token: viewer });
          expect(job.status, suggestions).toBe(200);
        }
      },
    );
  });
}
