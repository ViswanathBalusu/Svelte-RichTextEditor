// Pinned content reads over real HTTP against the history gate (PRO-049 criterion 4; 07 §8,
// PRM-041; ADR 0034). The commits are appended straight to the log, as routes.exports-gate.test.ts
// does, so the head is above 0 and a seq below the gate exists.
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

/** The legal region is hidden from everyone but owners and its grantees. */
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
async function append(h: Harness, doc: string, texts: string[]): Promise<void> {
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
    user: 'u-test',
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

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`pinned content and the history gate over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { views: { ...FULL_VIEWS, visibility } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'refuses a pinned read below the gate for a viewer and serves the head and full history to an owner (PRO-049 criterion 4; PRM-041)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        await append(h, doc, ['a', 'b']);
        // Under the default `editors` setting a viewer sees the head only; seq 0 is below the gate.
        const viewer = h.userToken({ [doc]: 'viewer' });
        const below = await h.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: viewer });
        expect(below.status).toBe(403);
        expect(below.json.code).toBe('forbidden');
        expect(below.text).not.toContain('Hello');
        // The head is always visible (ADR 0034) and is read without refusal.
        const atHead = await h.call('GET', `/v1/documents/${doc}/content?seq=2`, { token: viewer });
        expect(atHead.status).toBe(200);
        expect(atHead.json).toMatchObject({ seq: 2 });
        // An owner sees full history, so seq 0 is served to them.
        const owner = h.userToken({ [doc]: 'owner' });
        const full = await h.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: owner });
        expect(full.status).toBe(200);
        expect(full.json).toMatchObject({ seq: 0 });
      },
    );
  });
}
