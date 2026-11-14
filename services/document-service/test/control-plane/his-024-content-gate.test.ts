// Content at a `seq` over HTTP under the history gate, on memory and on PostgreSQL (HIS-024
// criterion 2, content part; 07 §8; 08 §9). The commits resource and the exports at a `seq` are in
// routes.commits.test.ts and routes.exports-gate.test.ts. The commits are appended straight to the
// log, as those files do. PostgreSQL: pwsh -NoProfile -File infra/test-env.ps1 up (FND-010).
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
  const epoch = await h.parts.ownership.claim(ref, 'his-024-content-node');
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

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = await skipReason(storage);
  describe(`GET /documents/{id}/content?seq under the history gate (HIS-024, ${storage})`, () => {
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { views: { ...FULL_VIEWS, visibility } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip !== null)(
      'refuses content below the gate as forbidden, and serves the head to a viewer (criterion 2)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        await append(h, doc, 'u-test', ['a', 'b']);
        // Owners see full history; under the default `editors` a viewer sees the head only.
        const owner = h.userToken({ [doc]: 'owner' });
        const old = await h.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: owner });
        expect(old.status).toBe(200);
        expect(old.json).toMatchObject({ seq: 0 });

        const viewer = h.userToken({ [doc]: 'viewer' });
        const below = await h.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: viewer });
        expect(below.status).toBe(403);
        expect(below.json.code).toBe('forbidden');
        expect(below.text).not.toContain('"doc"');

        const head = await h.call('GET', `/v1/documents/${doc}/content?seq=2`, { token: viewer });
        expect(head.status).toBe(200);
        expect(head.json).toMatchObject({ seq: 2 });
      },
    );
  });
}
