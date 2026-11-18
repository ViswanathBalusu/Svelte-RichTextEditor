// HIS-042 criterion 1, the showing half: the history list shows an accepted or rejected suggestion
// with its origin label and the user who decided (08 §14). Commits with origin `suggestion.accept`
// and `suggestion.reject` by different users are stored an hour apart, so each is its own group, and
// `GET /documents/{id}/history` names the origin and the author of each. The storing half, through
// the real data plane, is src/data-plane/his-042-decision-commits.test.ts.
// PostgreSQL: pwsh -NoProfile -File infra/test-env.ps1 up (FND-010); the postgres case skips without it.
import { type StoredCommit } from '@docedit/authority';
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

const INTRO = 'pIntro0000000001';
const HOUR = 60 * 60 * 1000;

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

type Item = {
  type: string;
  fromSeq?: number;
  origins?: string[];
  authors?: Array<{ user: string }>;
};

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`decisions on suggestions in the history list (HIS-042, ${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    async function appendOne(doc: string, user: string, origin: string, text: string) {
      const ref: DocRef = { tenant: h.tenant, doc };
      const epoch = await h.parts.ownership.claim(ref, 'his-042-node');
      const head = await h.parts.logs.head(ref);
      const perms = await h.parts.grants.current(ref);
      const pos = inside(documentWithRegions()['doc'], INTRO);
      const commit: StoredCommit = {
        seq: head.seq + 1,
        id: uuid7(),
        kind: 'steps',
        steps: [
          { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } },
        ] as StoredCommit['steps'],
        user,
        session: 'session-test',
        time: h.now(),
        origin,
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
      expect(r.status).toBe('ok');
    }

    it.skipIf(skip !== null)(
      'lists each decision as its own group with the origin label and the deciding user',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions(), title: 'Decisions' });
        for (const [user, origin] of [
          ['u-alice', 'input'],
          ['u-bob', 'suggestion.accept'],
          ['u-carol', 'suggestion.reject'],
        ] as const) {
          h.advance(HOUR);
          await appendOne(doc, user, origin, user);
        }
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'u-owner' });
        const r = await h.call('GET', `/v1/documents/${doc}/history`, { token: owner });
        expect(r.status, r.text).toBe(200);
        const groups = (r.json.items as Item[]).filter((i) => i.type === 'group');
        expect(groups.map((g) => [g.fromSeq, g.origins, g.authors?.map((a) => a.user)])).toEqual([
          [3, ['suggestion.reject'], ['u-carol']],
          [2, ['suggestion.accept'], ['u-bob']],
          [1, ['input'], ['u-alice']],
        ]);
      },
    );
  });
}
