/**
 * `DataPlane.readCommits` (05 §6.2 `/commits`; BE-038; PRM-041; HIS-024), the path a user's
 * `GET /documents/{id}/commits` takes when the data plane offers a page. The tests drive the real
 * data plane over in-memory stores: commits are written by a WebSocket client, then read in pages,
 * once while the room holds the document (the room's gate) and once from storage alone (a second
 * data plane over the same stores, with no room: `gateOf`). Both paths must give the same pages and
 * the same refusals.
 */
import type { JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import {
  BASE_JSON,
  REQUIRES,
  memoryStores,
  startPlane,
  type Plane,
  type Stores,
} from '../../test/data-plane/support.ts';
import type { VerifiedIdentity } from '../seams.ts';
import type { DocumentStore } from '../storage/types.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
async function plane(...args: Parameters<typeof startPlane>): Promise<Plane> {
  const p = await startPlane(...args);
  planes.push(p);
  return p;
}
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** A clock the test moves, so that commit times are known (the `since_access` gate reads them). */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v) };
}

/** Stores whose documents report the given history setting (the memory store keeps `editors`). */
function withHistory(setting: string): Stores {
  const s = memoryStores();
  const inner = s.memory;
  const documents = new Proxy(inner, {
    get(target, key) {
      if (key === 'get')
        return async (...args: Parameters<DocumentStore['get']>) => {
          const r = await target.get(...args);
          return r && { ...r, historyVisibility: setting };
        };
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as DocumentStore;
  return { ...s, documents };
}

/** Alice writes `times.length` commits, the n-th at clock time `times[n]`; the room stays open. */
async function writeCommits(
  p: Plane,
  doc: string,
  times: readonly number[],
  set: (t: number) => void,
): Promise<void> {
  const a = await p.client('alice', { [doc]: 'owner' });
  await a.open(1, doc);
  for (const [i, t] of times.entries()) {
    set(t);
    const r = await a.submit(1, { base: i, steps: [insertText(intro(), `${i}`)] });
    expect(r.t).toBe('sync.ack');
  }
}

/** A second data plane over the same stores: no room holds the document, so storage is read. */
async function storedPlane(p: Plane, now: () => number): Promise<Plane> {
  return plane({ stores: p.stores, checkpoints: p.checkpoints, tenant: p.tenant, now });
}

function identity(
  p: Plane,
  user: 'carol' | 'frank',
  doc: string,
  extra: Partial<VerifiedIdentity> = {},
): VerifiedIdentity {
  const role = user === 'carol' ? 'editor' : 'viewer';
  return { ...p.tokens.identity(p.tokens.issue({ user, docs: { [doc]: role } })), ...extra };
}

/** Reads every page from `after` by cursor and returns the seqs of each page. */
async function pagesOf(p: Plane, id: VerifiedIdentity, doc: string, after: number, limit: number) {
  const pages: number[][] = [];
  let cursor: number | null = after;
  while (cursor !== null) {
    const page = await p.plane.readCommits(id, doc, cursor, limit);
    pages.push(page.items.map((c) => c.seq));
    cursor = page.next;
  }
  return pages;
}

describe('DataPlane.readCommits pages the log (BE-038 criterion 1)', () => {
  it('pages ascending after `after` by cursor, with limit at most 200, in the room and from storage', async () => {
    const c = clock();
    const p = await plane({ now: c.now });
    const doc = await p.createDocument();
    await writeCommits(p, doc, [1_000, 2_000, 3_000, 4_000, 5_000], c.set);
    const id = identity(p, 'carol', doc);

    // In the room: pages of two by cursor, ascending, each after the cursor.
    const first = await p.plane.readCommits(id, doc, 0, 2);
    expect(first.items.map((x) => x.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({ next: 2, head: 5 });
    expect(first.items[0]!.author.user).toBe('host-alice');
    expect(first.items[0]!.kind).toBe('steps');
    expect(await pagesOf(p, id, doc, 0, 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(await pagesOf(p, id, doc, 3, 200)).toEqual([[4, 5]]);
    const atHead = await p.plane.readCommits(id, doc, 5, 200);
    expect(atHead).toMatchObject({ items: [], next: null, head: 5 });

    // The bounds: limit 1 to 200, after a seq at or below the head.
    for (const limit of [0, 201, 1.5])
      await expect(p.plane.readCommits(id, doc, 0, limit)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    await expect(p.plane.readCommits(id, doc, -1, 2)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(p.plane.readCommits(id, doc, 6, 2)).rejects.toMatchObject({ code: 'not_found' });
    const stranger = p.tokens.identity(p.tokens.issue({ user: 'carol', docs: {} }));
    await expect(p.plane.readCommits(stranger, doc, 0, 2)).rejects.toMatchObject({
      code: 'forbidden',
    });

    // From storage alone: the same pages and the same bounds.
    const q = await storedPlane(p, c.now);
    expect(await pagesOf(q, id, doc, 0, 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(await q.plane.readCommits(id, doc, 0, 200)).toEqual(
      await p.plane.readCommits(id, doc, 0, 200),
    );
    await expect(q.plane.readCommits(id, doc, 0, 201)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('ends a page before a snapshot commit and refuses a page that would start with one', async () => {
    const c = clock();
    const p = await plane({ now: c.now });
    const doc = await p.createDocument();
    await writeCommits(p, doc, [1_000, 2_000], c.set);
    const content: JsonEnvelope = {
      cdm: 1,
      requires: REQUIRES,
      doc: BASE_JSON as JsonEnvelope['doc'],
    };
    expect(await p.plane.replaceContent(p.ref(doc), content, 'alice')).toEqual({ seq: 3 });
    const b = await p.client('carol', { [doc]: 'editor' });
    await b.open(1, doc);
    expect((await b.submit(1, { base: 3, steps: [insertText(intro(), 'z')] })).t).toBe('sync.ack');
    const id = identity(p, 'carol', doc);
    for (const reader of [p, await storedPlane(p, c.now)]) {
      const page = await reader.plane.readCommits(id, doc, 0, 200);
      expect(page.items.map((x) => x.seq)).toEqual([1, 2]);
      expect(page).toMatchObject({ next: 2, head: 4 });
      await expect(reader.plane.readCommits(id, doc, 2, 200)).rejects.toMatchObject({
        code: 'conflict',
      });
      expect((await reader.plane.readCommits(id, doc, 3, 200)).items.map((x) => x.seq)).toEqual([
        4,
      ]);
    }
  });
});

describe('DataPlane.readCommits returns nothing below the reader gate (BE-038 criterion 2; PRM-041)', () => {
  it('under `editors`, refuses a viewer any page below the head and names no seq', async () => {
    const c = clock();
    const p = await plane({ now: c.now });
    const doc = await p.createDocument();
    await writeCommits(p, doc, [1_000, 2_000, 3_000], c.set);
    const frank = identity(p, 'frank', doc);
    for (const reader of [p, await storedPlane(p, c.now)]) {
      for (const after of [0, 1, 2]) {
        const refused = await reader.plane.readCommits(frank, doc, after, 200).then(
          () => null,
          (e: unknown) => e as { code: string; message: string },
        );
        expect(refused).toMatchObject({ code: 'forbidden' });
        // The refusal carries no sequence number and no commit.
        expect(JSON.stringify({ ...refused, message: refused!.message })).not.toMatch(/\d/);
      }
      // At the head (the gate) the page is empty: nothing below it comes back.
      expect(await reader.plane.readCommits(frank, doc, 3, 200)).toMatchObject({
        items: [],
        next: null,
        head: 3,
      });
      // An editor reads the whole log on the same path.
      const carol = identity(p, 'carol', doc);
      expect((await reader.plane.readCommits(carol, doc, 0, 200)).items.map((x) => x.seq)).toEqual([
        1, 2, 3,
      ]);
    }
  });

  it('under `since_access`, returns only commits after the access time and refuses `after` below it', async () => {
    const c = clock();
    const p = await plane({ now: c.now, stores: withHistory('since_access') });
    const doc = await p.createDocument();
    await writeCommits(p, doc, [1_000, 2_000, 3_000, 4_000], c.set);
    // Access from 2,500: the gate is seq 2, the last commit at or before that time (08 §9).
    const frank = identity(p, 'frank', doc, { accessSince: 2_500 });
    const late = identity(p, 'frank', doc);
    for (const reader of [p, await storedPlane(p, c.now)]) {
      for (const after of [0, 1])
        await expect(reader.plane.readCommits(frank, doc, after, 200)).rejects.toMatchObject({
          code: 'forbidden',
        });
      expect(await pagesOf(reader, frank, doc, 2, 1)).toEqual([[3], [4]]);
      const all = await reader.plane.readCommits(frank, doc, 2, 200);
      expect(all.items.every((x) => x.seq > 2)).toBe(true);
      expect(all.items.map((x) => x.seq)).toEqual([3, 4]);
      // Without the claim the gate fails closed at the head.
      await expect(reader.plane.readCommits(late, doc, 2, 200)).rejects.toMatchObject({
        code: 'forbidden',
      });
      expect((await reader.plane.readCommits(late, doc, 4, 200)).items).toEqual([]);
    }
  });
});
