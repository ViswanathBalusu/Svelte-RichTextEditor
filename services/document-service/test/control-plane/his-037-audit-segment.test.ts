// HIS-037 criterion 3 and the service half of criteria 1, 2 and 4: `GET /documents/{id}/audit-segment`
// cuts a segment of the hash chain at the caller's gate (07 §8; ADR 0034), over HTTP, for each
// setting and role of HIS-026's matrix. What the caller could not see is checked in the JSON text:
// no record below the gate, no id of such a record, and one link hash only (owner decision 142). The
// segment verifies offline from its JSON alone, with the verifier of `@docedit/history`. A reader
// whose view hides content is refused (the names of hidden scopes are an open question; see the
// route). PostgreSQL: pwsh -NoProfile -File infra/test-env.ps1 up (FND-010); those cases skip without it.
import { type StoredCommit } from '@docedit/authority';
import { verifySegment, type AuditSegment } from '@docedit/history';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOTHING_HIDDEN, type Visibility } from '@docedit/authority';
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
const HEAD = 4;
const LEGAL = 'rLegal0000000001';
/** The legal region is hidden from everyone but owners (as be-098-read-sweep.test.ts does). */
const visibility: Visibility = (conn) =>
  conn.role === 'owner'
    ? NOTHING_HIDDEN
    : { regions: new Set([LEGAL]), values: new Set(), titles: false };
const STEP_MS = 10_000;

type Setting = 'editors' | 'all' | 'since_access';
type Role = 'owner' | 'editor' | 'commenter' | 'viewer';

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

async function appendOne(h: Harness, doc: string, text: string): Promise<number> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'his-037-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const pos = inside(documentWithRegions()['doc'], INTRO);
  const time = h.now();
  const commit: StoredCommit = {
    seq: head.seq + 1,
    id: uuid7(),
    kind: 'steps',
    steps: [
      { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } },
    ] as StoredCommit['steps'],
    user: 'u-test',
    session: 'session-test',
    time,
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
  expect(r.status).toBe('ok');
  return time;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the audit segment at the caller's gate (HIS-037, ${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const times = new Map<number, number>();
    const settings = new Map<string, Setting>();

    async function setSetting(doc: string, setting: Setting): Promise<void> {
      if (h.db) {
        await h.db.admin.query(`UPDATE documents SET history_visibility = $2 WHERE id = $1`, [
          doc,
          setting,
        ]);
        return;
      }
      settings.set(doc, setting);
    }

    async function makeDoc(setting: Setting): Promise<string> {
      const doc = await h.createDocument({ content: documentWithRegions(), title: 'Segment' });
      await setSetting(doc, setting);
      for (let i = 1; i <= HEAD; i++) {
        h.advance(STEP_MS);
        times.set(i, await appendOne(h, doc, `c${i}`));
      }
      return doc;
    }

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
      if (!h.db) {
        const store = h.parts.documents;
        const original = store.get.bind(store);
        store.get = async (ref) => {
          const r = await original(ref);
          const setting = settings.get(ref.doc);
          return r && setting ? { ...r, historyVisibility: setting } : r;
        };
      }
    });
    afterAll(async () => {
      await h?.close();
    });

    const idsOf = async (doc: string): Promise<Map<number, string>> => {
      const rows = await h.parts.logs.read({ tenant: h.tenant, doc }, 1, HEAD);
      return new Map(rows.map((c) => [c.seq, c.id]));
    };
    const segmentOf = async (doc: string, token: string, query = '') => {
      const r = await h.call('GET', `/v1/documents/${doc}/audit-segment${query}`, { token });
      return r;
    };

    const CASES: Array<{ setting: Setting; role: Role; claim: boolean; gate: number }> = [
      { setting: 'editors', role: 'owner', claim: false, gate: 0 },
      { setting: 'editors', role: 'editor', claim: false, gate: 0 },
      { setting: 'editors', role: 'commenter', claim: false, gate: HEAD },
      { setting: 'editors', role: 'viewer', claim: false, gate: HEAD },
      { setting: 'all', role: 'viewer', claim: false, gate: 0 },
      { setting: 'since_access', role: 'viewer', claim: true, gate: 3 },
      { setting: 'since_access', role: 'viewer', claim: false, gate: HEAD },
    ];

    for (const c of CASES) {
      it.skipIf(skip !== null)(
        `${c.setting}, ${c.role}${c.setting === 'since_access' ? (c.claim ? ', with access_since' : ', without it') : ''}: nothing below the gate ${c.gate}, one link hash, verifies offline`,
        async () => {
          const doc = await makeDoc(c.setting);
          const claims = c.claim
            ? { access_since: new Date(times.get(3)! + 500).toISOString() }
            : {};
          const token = h.userToken({ [doc]: c.role }, { sub: `u-${c.role}`, ...claims });
          const ids = await idsOf(doc);

          const r = await segmentOf(doc, token);
          expect(r.status, r.text).toBe(200);
          const seg = r.json as unknown as AuditSegment;
          const first = Math.max(1, c.gate);
          expect(seg.from).toBe(first);
          expect(seg.to).toBe(HEAD);
          expect(seg.commits.map((x) => x.meta.seq)).toEqual(
            Array.from({ length: HEAD - first + 1 }, (_, i) => first + i),
          );
          // Nothing the caller could not see: no id of a record below the gate is in the text.
          for (let s = 1; s < first; s++) expect(r.text).not.toContain(ids.get(s)!);
          // The first held record names the hash of the record below it, once (decision 142).
          if (first > 1) expect(seg.commits[0]!.prevHash).toMatch(/^[0-9a-f]{64}$/);
          else expect(seg.commits[0]!.prevHash).toBeNull();
          // No payload and no host sub travel.
          expect(r.text).not.toContain('"slice"');
          expect(r.text).not.toContain('"payload"');
          // The segment verifies offline from its JSON alone.
          const report = await verifySegment(JSON.parse(r.text) as AuditSegment);
          expect(report.problems, JSON.stringify(report.problems)).toEqual([]);

          // A range that ends below the gate is refused; one that reaches it is served.
          if (c.gate > 1) {
            const below = await segmentOf(doc, token, `?toSeq=${c.gate - 1}`);
            expect(below.status, below.text).toBe(403);
            expect(below.json.code).toBe('forbidden');
            const at = await segmentOf(doc, token, `?fromSeq=1&toSeq=${c.gate}`);
            expect(at.status, at.text).toBe(200);
            expect((at.json as unknown as AuditSegment).commits).toHaveLength(1);
          }
        },
      );
    }

    it.skipIf(skip !== null)(
      'refuses a range above the head, a reversed range and a bad seq',
      async () => {
        const doc = await makeDoc('all');
        const token = h.userToken({ [doc]: 'viewer' }, { sub: 'u-viewer' });
        expect((await segmentOf(doc, token, `?toSeq=${HEAD + 1}`)).status).toBe(404);
        expect((await segmentOf(doc, token, '?fromSeq=3&toSeq=2')).status).toBe(400);
        expect((await segmentOf(doc, token, '?fromSeq=0')).status).toBe(400);
        expect((await segmentOf(doc, token, '?fromSeq=x')).status).toBe(400);
      },
    );

    it.skipIf(skip !== null)('gives a service credential the whole chain', async () => {
      const doc = await makeDoc('editors');
      const r = await segmentOf(doc, h.apiKey);
      expect(r.status, r.text).toBe(200);
      const seg = r.json as unknown as AuditSegment;
      expect(seg.from).toBe(1);
      expect(seg.commits).toHaveLength(HEAD);
      expect((await verifySegment(seg)).problems).toEqual([]);
    });

    it.skipIf(skip !== null)('refuses a caller with no role in the document', async () => {
      const doc = await makeDoc('all');
      const other = await makeDoc('all');
      const token = h.userToken({ [other]: 'owner' }, { sub: 'u-other' });
      expect((await segmentOf(doc, token)).status).toBe(403);
    });
  });
}

describe('the audit segment for a reader whose view hides content (HIS-037)', async () => {
  const skip = await skipReason('memory');
  let h: Harness;
  beforeAll(async () => {
    if (!skip)
      h = await startHarness('memory', {
        realDataPlane: true,
        views: { ...FULL_VIEWS, visibility },
      });
  });
  afterAll(async () => {
    await h?.close();
  });

  it.skipIf(skip !== null)(
    'is refused with forbidden for a viewer who cannot read a restricted region, and served to the service credential',
    async () => {
      const doc = await h.createDocument({ content: documentWithRegions(), title: 'Restricted' });
      await appendOne(h, doc, 'x');
      const token = h.userToken({ [doc]: 'viewer' }, { sub: 'u-viewer' });
      const refused = await h.call('GET', `/v1/documents/${doc}/audit-segment`, { token });
      expect(refused.status, refused.text).toBe(403);
      expect(refused.json.code).toBe('forbidden');
      const served = await h.call('GET', `/v1/documents/${doc}/audit-segment`, {
        token: h.apiKey,
      });
      expect(served.status, served.text).toBe(200);
      // An owner is in the full class, so the owner is served as well.
      const owner = h.userToken({ [doc]: 'owner' }, { sub: 'u-owner' });
      expect(
        (await h.call('GET', `/v1/documents/${doc}/audit-segment`, { token: owner })).status,
      ).toBe(200);
    },
  );
});
