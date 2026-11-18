// PRO-054 criteria 1 and 5, over real HTTP, with in-memory storage and with PostgreSQL (lane w5).
//
// Criterion 1: `GET /documents/{id}/history` takes the filters `region`, `field`, `user`, `fromSeq`,
// `toSeq` and `namedOnly`, returns grouped commits as a cursor list, and returns only what the
// caller's visibility gate allows. Criterion 5: a version at a `seq` above the head or below the
// gate is refused. The grouping rules themselves are tested in packages/history (HIS-008); this
// file tests that the route applies them to what the store holds. Test values only.
//
// The commits are appended through the log store as a room would, with the scopes a room records
// (`region:<id>`, `field:<id>`). The history setting `since_access` has no route yet (08 §9), so it
// is set in storage, as in his-026-gate-negative.test.ts: by SQL on PostgreSQL, and on the memory
// store by answering the document with the setting.
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
const OPEN_REGION = 'rOpen00000000001';
const FIELD = 'ffName0000000001';
const GAP_MS = 10 * 60 * 1000;

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

interface Spec {
  user: string;
  scopes: string[];
  /** Milliseconds the clock moves before the commit. */
  after?: number;
}

type Item = {
  type: 'group' | 'version';
  fromSeq?: number;
  toSeq?: number;
  changes?: number;
  authors?: Array<{ user: string }>;
  version?: { seq: number; kind: string; name?: string };
};

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the grouped history list and versions at the gate over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const settings = new Map<string, string>();

    async function setSetting(doc: string, setting: string): Promise<void> {
      if (h.db) {
        await h.db.admin.query(`UPDATE documents SET history_visibility = $2 WHERE id = $1`, [
          doc,
          setting,
        ]);
        return;
      }
      settings.set(doc, setting);
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
          return r && setting ? { ...r, historyVisibility: setting as never } : r;
        };
      }
    });
    afterAll(async () => {
      await h?.close();
    });

    /** Appends the commits one at a time, moving the clock before each; returns each commit's time. */
    async function appendAll(doc: string, specs: Spec[]): Promise<number[]> {
      const ref: DocRef = { tenant: h.tenant, doc };
      const epoch = await h.parts.ownership.claim(ref, 'pro-054-node');
      const pos = inside(documentWithRegions()['doc'], INTRO);
      const times: number[] = [];
      for (const [i, s] of specs.entries()) {
        h.advance(s.after ?? 1000);
        const head = await h.parts.logs.head(ref);
        const perms = await h.parts.grants.current(ref);
        const time = h.now();
        times.push(time);
        const commit: StoredCommit = {
          seq: head.seq + 1,
          id: uuid7(),
          kind: 'steps',
          steps: [
            {
              stepType: 'replace',
              from: pos,
              to: pos,
              slice: { content: [{ type: 'text', text: `c${i}` }] },
            },
          ] as StoredCommit['steps'],
          user: s.user,
          session: `session-${s.user}`,
          time,
          origin: 'input',
          scopes: s.scopes,
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
      return times;
    }

    /**
     * Five commits. Three close together (alice, alice in the open region, bob on a field), then a
     * gap past the idle time, then two more (alice in the open region, bob), so that the list has
     * more than one group.
     */
    async function fiveCommits(): Promise<string> {
      const doc = await h.createDocument({ content: documentWithRegions() });
      await appendAll(doc, [
        { user: 'u-alice', scopes: ['body'] },
        { user: 'u-alice', scopes: [`region:${OPEN_REGION}`] },
        { user: 'u-alice', scopes: [`field:${FIELD}`] },
        { user: 'u-alice', scopes: [`region:${OPEN_REGION}`], after: GAP_MS },
        { user: 'u-bob', scopes: ['body'], after: GAP_MS },
      ]);
      return doc;
    }

    const history = (doc: string, query = '') => `/v1/documents/${doc}/history${query}`;
    const itemsOf = (r: { json: { items: Item[] } }) => r.json.items;
    const changes = (items: Item[]) =>
      items.filter((i) => i.type === 'group').reduce((n, i) => n + (i.changes ?? 0), 0);

    it.skipIf(skip)(
      'groups the commits, newest first, and every filter narrows them (PRO-054 criterion 1)',
      async () => {
        const doc = await fiveCommits();
        const owner = h.userToken({ [doc]: 'owner' });
        const get = (query = '') => h.call('GET', history(doc, query), { token: owner });

        const all = await get();
        expect(all.status, all.text).toBe(200);
        const groups = itemsOf(all).filter((i) => i.type === 'group');
        // The idle gaps split the five commits into three groups, newest first.
        expect(groups.length).toBe(3);
        expect(groups.map((g) => [g.fromSeq, g.toSeq])).toEqual([
          [5, 5],
          [4, 4],
          [1, 3],
        ]);
        expect(changes(itemsOf(all))).toBe(5);
        expect(all.json.nextCursor).toBeNull();

        // region: the commits that touched the region.
        const byRegion = await get(`?region=${OPEN_REGION}`);
        expect(byRegion.status, byRegion.text).toBe(200);
        expect(changes(itemsOf(byRegion))).toBe(2);
        // field: the commits that touched the field.
        const byField = await get(`?field=${FIELD}`);
        expect(byField.status, byField.text).toBe(200);
        expect(changes(itemsOf(byField))).toBe(1);
        // user: the commits of one person.
        const byBob = await get('?user=u-bob');
        expect(byBob.status, byBob.text).toBe(200);
        expect(changes(itemsOf(byBob))).toBe(1);
        expect(itemsOf(byBob)[0]?.authors?.map((a) => a.user)).toEqual(['u-bob']);
        const byAlice = await get('?user=u-alice');
        expect(changes(itemsOf(byAlice))).toBe(4);
        // fromSeq and toSeq: a run of commits.
        const range = await get('?fromSeq=2&toSeq=4');
        expect(range.status, range.text).toBe(200);
        expect(changes(itemsOf(range))).toBe(3);
        const fromOnly = await get('?fromSeq=4');
        expect(changes(itemsOf(fromOnly))).toBe(2);
        const toOnly = await get('?toSeq=2');
        expect(changes(itemsOf(toOnly))).toBe(2);
        // The filters combine.
        const both = await get(`?user=u-alice&region=${OPEN_REGION}`);
        expect(changes(itemsOf(both))).toBe(2);

        // namedOnly: only the named versions, as items of their own.
        for (const seq of [2, 4]) {
          const made = await h.call('POST', `/v1/documents/${doc}/versions`, {
            token: owner,
            body: { seq, name: `Version ${seq}` },
          });
          expect(made.status, made.text).toBe(201);
        }
        const named = await get('?namedOnly=true');
        expect(named.status, named.text).toBe(200);
        const namedItems = itemsOf(named);
        expect(namedItems.every((i) => i.type === 'version')).toBe(true);
        expect(namedItems.map((i) => i.version?.seq).sort()).toEqual([2, 4]);
        // Without it, the same versions end the groups they close, and the commits are listed.
        const withVersions = await get();
        expect(changes(itemsOf(withVersions))).toBe(5);
        const notNamed = await get('?namedOnly=false');
        expect(changes(itemsOf(notNamed))).toBe(5);
      },
    );

    it.skipIf(skip)('pages the list with a cursor and reaches every item once', async () => {
      const doc = await fiveCommits();
      const owner = h.userToken({ [doc]: 'owner' });
      const whole = await h.call('GET', history(doc), { token: owner });
      const seen: Item[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string =
          cursor === null ? '?limit=1' : `?limit=1&cursor=${encodeURIComponent(cursor)}`;
        const page = await h.call('GET', history(doc, query), { token: owner });
        expect(page.status, page.text).toBe(200);
        expect(itemsOf(page).length).toBeLessThanOrEqual(1);
        seen.push(...itemsOf(page));
        cursor = page.json.nextCursor as string | null;
        pages++;
      } while (cursor !== null && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual(itemsOf(whole));
    });

    it.skipIf(skip)(
      'refuses a bad filter, an unknown scope and a caller without view',
      async () => {
        const doc = await fiveCommits();
        const owner = h.userToken({ [doc]: 'owner' });
        const get = (query: string, token = owner) => h.call('GET', history(doc, query), { token });
        for (const bad of ['?region=short', '?field=x', '?namedOnly=maybe', '?fromSeq=abc']) {
          const r = await get(bad);
          expect(r.status, bad).toBe(400);
          expect(r.json.code, bad).toBe('validation_failed');
        }
        // A scope that never existed answers as one the caller may not see does (08 §4).
        const none = await get('?region=rNone00000000001');
        expect(none.status).toBe(404);
        expect(none.json.code).toBe('not_found');
        // No grant on the document: refused.
        const other = await h.createDocument({ content: documentWithRegions() });
        const stranger = h.userToken({ [other]: 'owner' }, { sub: 'u-stranger' });
        const refused = await get('', stranger);
        expect(refused.status).toBe(403);
        expect(refused.json.code).toBe('forbidden');
      },
    );

    it.skipIf(skip)(
      'lists only what the visibility gate allows: a viewer sees the named versions, not the commits',
      async () => {
        const doc = await fiveCommits();
        const owner = h.userToken({ [doc]: 'owner' });
        const made = await h.call('POST', `/v1/documents/${doc}/versions`, {
          token: owner,
          body: { seq: 3, name: 'Reviewed' },
        });
        expect(made.status, made.text).toBe(201);
        // Under the default `editors` setting a viewer's gate is the head (ADR 0034): the commits
        // below it are not theirs, and a named version is shown as a state of its own.
        const viewer = await h.call('GET', history(doc), {
          token: h.userToken({ [doc]: 'viewer' }, { sub: 'u-viewer' }),
        });
        expect(viewer.status, viewer.text).toBe(200);
        expect(itemsOf(viewer).filter((i) => i.type === 'group')).toEqual([]);
        // Named versions are single states the gate shows (his-026-gate-negative.test.ts).
        expect(itemsOf(viewer).map((i) => i.version?.seq)).toEqual([3]);
        // A `fromSeq` below the gate is refused outright, and the owner's view is unchanged.
        const below = await h.call('GET', history(doc, '?fromSeq=2'), {
          token: h.userToken({ [doc]: 'viewer' }, { sub: 'u-viewer' }),
        });
        expect(below.status).toBe(403);
        expect(below.json.code).toBe('forbidden');
        const ownerList = await h.call('GET', history(doc), { token: owner });
        expect(changes(itemsOf(ownerList))).toBe(5);
      },
    );

    it.skipIf(skip)(
      'refuses a version above the head and below the gate, and accepts one at the gate (PRO-054 criterion 5)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        await setSetting(doc, 'since_access');
        const times = await appendAll(doc, [
          { user: 'u-alice', scopes: ['body'], after: 10_000 },
          { user: 'u-alice', scopes: ['body'], after: 10_000 },
          { user: 'u-alice', scopes: ['body'], after: 10_000 },
          { user: 'u-alice', scopes: ['body'], after: 10_000 },
        ]);
        // An editor whose access began just after commit 3 has the gate 3 (`since_access`).
        const editor = h.userToken(
          { [doc]: 'editor' },
          { sub: 'u-editor', access_since: new Date(times[2]! + 500).toISOString() },
        );
        const post = (body: Record<string, unknown>) =>
          h.call('POST', `/v1/documents/${doc}/versions`, { token: editor, body });
        // Below the gate: refused, and nothing is stored.
        const below = await post({ seq: 2, name: 'Too early' });
        expect(below.status, below.text).toBe(403);
        expect(below.json.code).toBe('forbidden');
        // Above the head: refused as a validation failure.
        const above = await post({ seq: 5, name: 'Too far' });
        expect(above.status, above.text).toBe(400);
        expect(above.json.code).toBe('validation_failed');
        // At the gate and at the head: accepted.
        const atGate = await post({ seq: 3, name: 'At the gate' });
        expect(atGate.status, atGate.text).toBe(201);
        const atHead = await post({ name: 'At the head' });
        expect(atHead.status, atHead.text).toBe(201);
        expect(atHead.json.seq).toBe(4);
        // Listed with the same editor's token: under `since_access` the gate follows the claim.
        const listed = await h.call('GET', `/v1/documents/${doc}/versions`, { token: editor });
        expect(listed.json.items.map((v: { seq: number }) => v.seq)).toEqual([3, 4]);
      },
    );
  });
}
