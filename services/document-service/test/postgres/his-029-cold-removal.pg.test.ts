// HIS-029 with its neighbours, through the composed service on PostgreSQL and the S3-compatible
// store: what happens to a payload after it has moved to a cold segment.
//
// - Thinning (HIS-032): a tenant that keeps payloads for a period gets them removed from the segment
//   objects too, the payloads a named version needs stay, and a segment that was thinned is not
//   opened again by the next run.
// - A tombstone (HIS-040): the payload of one commit is taken out of its segment object, and reads
//   that need it say that the detail was removed.
// - A document with its own key (HIS-041): its sealed payload rows are opened for the move and its
//   segment object is sealed again; with the key destroyed nothing of it reads.
// - The purge of a deleted document (HIS-039): the index rows and the segment objects go with it.
//
// The scheduler of the service runs the tasks (`payloads.cold`, `payloads.thin`,
// `documents.purge`); the clock is moved with `advance` and no job is run by hand. Skipped, with
// the reason, when PostgreSQL or the object store is not up: pwsh -NoProfile -File
// infra/test-env.ps1 up. Test values only.
import { createHash, randomUUID } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { canonicalize, uuid7, type JsonEnvelope } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ColdSegmentStore } from '../../src/control-plane/cold-segments.ts';
import { PgColdSegmentStore } from '../../src/control-plane/cold-segments-pg.ts';
import type { TombstoneStore } from '../../src/control-plane/commit-tombstone.ts';
import { PgTombstoneStore } from '../../src/control-plane/commit-tombstone-pg.ts';
import { DAY_MS } from '../../src/control-plane/document-purge.ts';
import type { ThinningStore } from '../../src/control-plane/payload-thinning.ts';
import { PgThinningStore } from '../../src/control-plane/payload-thinning-pg.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { S3ObjectStore, type S3Settings } from '../../src/objects/s3.ts';
import { objectKeys, type ObjectStore, type PutOptions } from '../../src/objects/store.ts';
import { isSealed, type DocumentKeyStore } from '../../src/storage/document-keys.ts';
import { PgDocumentKeyStore } from '../../src/storage/document-keys-pg.ts';
import { MemoryKeyService } from '../../src/storage/key-service.ts';
import type { PgLogStore } from '../../src/storage/log-store.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../control-plane/support.ts';
import { insertText } from '../data-plane/client.ts';
import { ADMIN, settings } from '../support/env.ts';

const S = settings();
const s3Settings: S3Settings = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore(s3Settings).exists(`tenants/${randomUUID()}/probe`);
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${s3Settings.endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
  }
}

const skip = (await skipReason('postgres')) ?? (await s3Unavailable());
if (skip) console.warn(`skipped: ${skip}`);

const LETTERS = 'ABCDEFGHIJ';
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** The real object store, with a record of the calls made through the service. */
class CountedObjects implements ObjectStore {
  readonly #inner: ObjectStore;
  readonly calls: string[] = [];
  constructor(inner: ObjectStore) {
    this.#inner = inner;
  }
  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void> {
    this.calls.push(`PUT ${key}`);
    return this.#inner.put(key, body, opts);
  }
  get(key: string): Promise<Uint8Array | null> {
    this.calls.push(`GET ${key}`);
    return this.#inner.get(key);
  }
  exists(key: string): Promise<boolean> {
    return this.#inner.exists(key);
  }
  delete(key: string): Promise<void> {
    this.calls.push(`DELETE ${key}`);
    return this.#inner.delete(key);
  }
  list(prefix: string): Promise<string[]> {
    return this.#inner.list(prefix);
  }
  signedUrl(key: string, expiresAt: number): string {
    return this.#inner.signedUrl(key, expiresAt);
  }
}

interface Segment {
  format: string;
  entries: Array<{ seq: number; payloadHash: string; payload: unknown }>;
}

describe.skipIf(skip !== null)(
  'payloads in cold segments: thinning, a tombstone, a document key and the purge (HIS-029)',
  () => {
    let h: Harness;
    let purgePool: pg.Pool;
    const raw = new S3ObjectStore(s3Settings);
    const counted = new CountedObjects(raw);
    const keyService = new MemoryKeyService();
    // The stores need the database of the harness, which exists once it has started.
    let cold: ColdSegmentStore | null = null;
    let thinning: ThinningStore | null = null;
    let tombstones: PgTombstoneStore | null = null;
    let keyStore: PgDocumentKeyStore | null = null;
    const lazyCold: ColdSegmentStore = {
      documents: async (...a) => (cold ? cold.documents(...a) : []),
      pending: async (...a) => (cold ? cold.pending(...a) : []),
      facts: (...a) => cold!.facts(...a),
      locked: (...a) => cold!.locked(...a),
    };
    const lazyThinning: ThinningStore = {
      documents: async (...a) => (thinning ? thinning.documents(...a) : []),
      facts: (...a) => thinning!.facts(...a),
      remove: (...a) => thinning!.remove(...a),
    };
    const lazyTombstones: TombstoneStore = {
      state: (...a) => tombstones!.state(...a),
      remove: (...a) => tombstones!.remove(...a),
      record: (...a) => tombstones!.record(...a),
    };
    const lazyKeys: DocumentKeyStore = {
      tenantEnabled: (...a) => keyStore!.tenantEnabled(...a),
      setTenantEnabled: (...a) => keyStore!.setTenantEnabled(...a),
      get: (...a) => keyStore!.get(...a),
      insert: (...a) => keyStore!.insert(...a),
      markDestroyed: (...a) => keyStore!.markDestroyed(...a),
    };
    let pos = -1;
    const contentAt: JsonEnvelope[] = [];
    let twin: string;

    beforeAll(async () => {
      h = await startHarness('postgres', {
        purgeRole: true,
        config: { jobIdleMs: 50 },
        parts: {
          objects: counted,
          coldSegmentStore: lazyCold,
          thinningStore: lazyThinning,
          tombstoneStore: lazyTombstones,
          documentKeyStore: lazyKeys,
          keyService,
        },
      });
      purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 4 });
      purgePool.on('error', () => {});
      purgePool.on('connect', (c) => {
        void c.query('SET ROLE docedit_purge');
      });
      cold = new PgColdSegmentStore(purgePool);
      thinning = new PgThinningStore(purgePool);
      tombstones = new PgTombstoneStore(purgePool);
      keyStore = new PgDocumentKeyStore(h.db!.service);

      // The same ten commits as every document here, and no checkpoint: it never moves.
      twin = await documentWithHistory('Twin', { checkpoints: [], allRecent: true });
      for (let seq = 0; seq <= 10; seq++) {
        const r = await h.call('GET', `/v1/documents/${twin}/content?seq=${seq}`, {
          token: h.apiKey,
        });
        if (r.status !== 200) throw new Error(`twin content at ${seq}: ${r.status} ${r.text}`);
        contentAt[seq] = { cdm: r.json.cdm, requires: r.json.requires, doc: r.json.doc };
      }
    }, 120_000);

    afterAll(async () => {
      await h?.close();
      await purgePool?.end();
      if (h) for (const key of await raw.list(objectKeys.prefix(h.tenant))) await raw.delete(key);
    }, 120_000);

    const ref = (d: string): DocRef => ({ tenant: h.tenant, doc: d });
    const logs = () => h.parts.logs as PgLogStore;

    /**
     * A document with ten typing commits: seq 1 to 6 are 40 days old and 7 to 10 new, with a named
     * version at seq 3. `before` runs on the new document before any commit (a key is given then).
     */
    async function documentWithHistory(
      title: string,
      opts: { checkpoints: number[]; allRecent?: boolean; before?: (d: string) => Promise<void> },
    ): Promise<string> {
      const d = await h.createDocument({ content: documentWithRegions(), title });
      await opts.before?.(d);
      if (pos < 0) {
        const root = cdmSchema().nodeFromJSON(documentWithRegions()['doc']);
        root.descendants((node, p) => {
          if (pos < 0 && node.isTextblock) pos = p + 1;
          return pos < 0;
        });
      }
      const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
      const r = ref(d);
      const epoch = await h.parts.ownership.claim(r, 'test-node');
      for (let i = 0; i < 10; i++) {
        const seq = i + 1;
        const perms = await h.parts.grants.current(r);
        const res = await h.parts.logs.append(r, {
          epoch,
          revision: perms.revision,
          fromSeq: seq,
          commits: [
            {
              seq,
              id: uuid7(),
              kind: 'steps' as const,
              steps: [insertText(pos, LETTERS[i]!)] as never,
              user: bob,
              session: 's',
              time:
                seq <= 6 && !opts.allRecent
                  ? h.now() - 40 * DAY_MS + i * 1000
                  : h.now() - (10 - i) * 1000,
              origin: 'input',
              scopes: ['body'],
              revision: perms.revision,
              cdm: 1,
              engine: 'pm-steps/1',
              retired: [],
              claimed: [],
            },
          ],
        });
        if (res.status !== 'ok') throw new Error(`append refused: ${res.status}`);
        if (seq === 3) {
          const v = await h.parts.versions!.create(r, {
            kind: 'named',
            name: 'Kept',
            createdBy: bob,
            createdAt: h.now(),
          });
          if (!v.ok) throw new Error('version refused');
        }
      }
      for (const seq of opts.checkpoints) {
        const envelope = contentAt[seq]!;
        const text = canonicalize(envelope);
        // Through the service's own object store, which seals what belongs to a document with a key.
        await new ObjectCheckpointStore(h.service.parts.objects).put(r, seq, envelope);
        await h.parts.checkpointIndex!.record(r, {
          seq,
          key: objectKeys.checkpoint(h.tenant, d, seq),
          bytes: zstdCompressSync(Buffer.from(text, 'utf8')).byteLength,
          hash: createHash('sha256').update(text, 'utf8').digest('hex'),
        });
      }
      return d;
    }

    const payloadsOf = async (d: string) =>
      (
        await h.db!.admin.query<{ seq: string }>(
          'SELECT seq FROM doc_commit_payloads WHERE doc_id = $1 ORDER BY seq',
          [d],
        )
      ).rows.map((x) => Number(x.seq));

    const segmentsOf = async (d: string) =>
      (
        await h.db!.admin.query<{
          from_seq: string;
          to_seq: string;
          state: string;
          payloads: number;
        }>(
          `SELECT from_seq, to_seq, state, payloads FROM commit_cold_segments
            WHERE doc_id = $1 ORDER BY from_seq`,
          [d],
        )
      ).rows.map((x) => ({
        from: Number(x.from_seq),
        to: Number(x.to_seq),
        state: x.state,
        payloads: x.payloads,
      }));

    /** The entries of a segment object, read from the bucket as an operator would. */
    async function segmentOf(d: string, from: number, to: number): Promise<Segment> {
      const bytes = await raw.get(objectKeys.segment(h.tenant, d, from, to));
      if (!bytes) throw new Error('the segment object is not there');
      return JSON.parse(zstdDecompressSync(bytes).toString('utf8')) as Segment;
    }

    const finished = async (task: string) =>
      (
        await h.db!.admin.query<{ result: { failures: number; count: number } }>(
          `SELECT result FROM jobs
            WHERE kind = 'schedule' AND payload->>'task' = $1 AND state = 'completed'
            ORDER BY finished_at`,
          [task],
        )
      ).rows.map((x) => x.result);

    /** Moves the clock by `ms` and waits until the scheduler has run each of `tasks` once more. */
    async function nextScheduledRun(
      tasks: readonly string[],
      ms = DAY_MS,
    ): Promise<Record<string, { failures: number; count: number }>> {
      const before = new Map<string, number>();
      for (const t of tasks) before.set(t, (await finished(t)).length);
      h.advance(ms);
      await h.call('GET', '/healthz');
      const out: Record<string, { failures: number; count: number }> = {};
      const end = Date.now() + 90_000;
      for (;;) {
        for (const t of tasks) {
          const done = await finished(t);
          if (done.length > before.get(t)!) out[t] = done[done.length - 1]!;
        }
        if (Object.keys(out).length === tasks.length) return out;
        if (Date.now() > end) throw new Error(`the scheduler did not run ${tasks.join(', ')}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const keepAll = async (d: string) => {
      const r = await h.call('PUT', `/v1/documents/${d}/retention`, {
        token: h.apiKey,
        body: { mode: 'keep_all' },
        headers: { 'If-Match': '"0"' },
      });
      expect(r.status, r.text).toBe(200);
    };

    let thin: string;
    let tomb: string;
    let keyed: string;
    let gone: string;
    const lettersOf = (commits: Array<{ steps: unknown[] }>) =>
      commits.map(
        (c) => (c.steps[0] as { slice: { content: [{ text: string }] } }).slice.content[0].text,
      );

    it('moves the payloads of every document, and seals the segment of a document with its own key (HIS-041)', async () => {
      thin = await documentWithHistory('Thinned', { checkpoints: [2, 4, 8] });
      tomb = await documentWithHistory('Tombstone', { checkpoints: [2, 4, 8] });
      gone = await documentWithHistory('Deleted', { checkpoints: [2, 4, 8] });
      await h.service.parts.documentKeys!.setTenantOption(h.tenant, true);
      keyed = await documentWithHistory('Sensitive', {
        checkpoints: [2, 4, 8],
        before: (d) => h.service.parts.documentKeys!.provision(ref(d)),
      });
      // The payload rows of the keyed document are sealed in the table.
      const rows = await h.db!.admin.query<{ payload: Buffer }>(
        'SELECT payload FROM doc_commit_payloads WHERE doc_id = $1',
        [keyed],
      );
      expect(rows.rows).toHaveLength(10);
      for (const r of rows.rows) expect(isSealed(r.payload)).toBe(true);

      const run = await nextScheduledRun(['payloads.cold']);
      expect(run['payloads.cold']).toEqual({
        task: 'payloads.cold',
        slot: expect.any(Number),
        failures: 0,
        count: 24,
      });
      for (const d of [thin, tomb, gone, keyed]) {
        expect(await payloadsOf(d), d).toEqual([7, 8, 9, 10]);
        expect(await segmentsOf(d), d).toEqual([{ from: 1, to: 6, state: 'moved', payloads: 6 }]);
      }
      // In the bucket, the segment of a document without a key is a Zstandard frame, and that of
      // the keyed document is sealed: its bytes are no frame and hold none of the text.
      const plain = (await raw.get(objectKeys.segment(h.tenant, thin, 1, 6)))!;
      expect([...plain.subarray(0, 4)]).toEqual(ZSTD_MAGIC);
      const sealed = (await raw.get(objectKeys.segment(h.tenant, keyed, 1, 6)))!;
      expect(isSealed(sealed)).toBe(true);
      expect([...sealed.subarray(0, 4)]).not.toEqual(ZSTD_MAGIC);
      // The service opens it: the range reads as it was written, and the chain verifies with the
      // payloads of both stores.
      expect(lettersOf(await logs().read(ref(keyed), 1, 10))).toEqual([...LETTERS]);
      expect(await logs().verify(ref(keyed), { payloads: true })).toEqual({ ok: true, head: 10 });
      const r = await h.call('GET', `/v1/documents/${keyed}/content?seq=5`, { token: h.apiKey });
      expect(r.status, r.text).toBe(200);
      expect(r.json.doc).toEqual(contentAt[5]!.doc);
    }, 180_000);

    it('takes the payload of a tombstoned commit out of its segment object (HIS-040)', async () => {
      const before = await segmentOf(tomb, 1, 6);
      expect(before.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(JSON.stringify(before.entries[4]!.payload)).toContain('"E"');
      const rowsBefore = (
        await h.db!.admin.query<{ row: string }>(
          'SELECT to_jsonb(c)::text AS row FROM doc_commits c WHERE doc_id = $1 ORDER BY seq',
          [tomb],
        )
      ).rows;

      const res = await h.call('POST', `/v1/documents/${tomb}/commits/5/tombstone`, {
        token: h.apiKey,
        body: { reason: 'Text that must not be kept' },
      });
      expect(res.status, res.text).toBe(200);
      // The segment was written again without the payload, so it is not among the copies left.
      expect(res.json.copies.coldSegments).toEqual([]);
      expect(res.json.copies.checkpoints).toEqual([8]);

      const after = await segmentOf(tomb, 1, 6);
      expect(after.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 6]);
      expect(JSON.stringify(after)).not.toContain('"E"');
      expect(await segmentsOf(tomb)).toEqual([{ from: 1, to: 6, state: 'moved', payloads: 5 }]);
      const stone = await h.db!.admin.query<{ seq: string; reason: string }>(
        'SELECT seq, reason FROM commit_tombstones WHERE doc_id = $1',
        [tomb],
      );
      expect(stone.rows).toEqual([{ seq: '5', reason: 'Text that must not be kept' }]);
      // The metadata rows and the chain are what they were.
      expect(
        (
          await h.db!.admin.query<{ row: string }>(
            'SELECT to_jsonb(c)::text AS row FROM doc_commits c WHERE doc_id = $1 ORDER BY seq',
            [tomb],
          )
        ).rows,
      ).toEqual(rowsBefore);
      expect(await logs().verify(ref(tomb), { payloads: true })).toEqual({ ok: true, head: 10 });

      // A read that needs the payload says that the detail was removed; the rest is served.
      const removed = await h.call('GET', `/v1/documents/${tomb}/content?seq=5`, {
        token: h.apiKey,
      });
      expect(removed.status, removed.text).toBe(404);
      expect(removed.json.detail).toMatch(/removed|no longer available/);
      const page = await h.call('GET', `/v1/documents/${tomb}/commits?after=3&limit=3`, {
        token: h.apiKey,
      });
      expect(page.status, page.text).toBe(404);
      const earlier = await h.call('GET', `/v1/documents/${tomb}/content?seq=3`, {
        token: h.apiKey,
      });
      expect(earlier.status, earlier.text).toBe(200);
      expect(earlier.json.doc).toEqual(contentAt[3]!.doc);
      expect(
        (await h.call('GET', `/v1/documents/${tomb}/content`, { token: h.apiKey })).status,
      ).toBe(200);

      // A second call finds a tombstone already.
      const again = await h.call('POST', `/v1/documents/${tomb}/commits/5/tombstone`, {
        token: h.apiKey,
        body: { reason: 'Again' },
      });
      expect(again.status, again.text).toBe(409);
      const audit = await h.parts.audit!.query(h.tenant, {
        kind: 'commit.tombstoned',
        doc: tomb,
        limit: 5,
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ data: { seq: 5, reason: 'Text that must not be kept' } });
    }, 120_000);

    it('thins the payloads that have moved, keeps what a named version needs, and does not open a thinned segment again (HIS-032)', async () => {
      // The tenant keeps payloads for 30 days; the other documents keep everything.
      for (const d of [tomb, gone, keyed, twin]) await keepAll(d);
      const set = await h.call('PUT', '/v1/retention', {
        token: h.apiKey,
        body: { mode: 'thin_payloads', afterDays: 30 },
        headers: { 'If-Match': '"0"' },
      });
      expect(set.status, set.text).toBe(200);
      const verdict = await logs().verify(ref(thin));

      counted.calls.length = 0;
      const run = await nextScheduledRun(['payloads.cold', 'payloads.thin']);
      expect(run['payloads.thin']).toMatchObject({ failures: 0, count: 1 });
      // Seq 3 stays for the named version (it needs the commits after the checkpoint at 2); the
      // other five payloads of the segment are gone from its object.
      const segment = await segmentOf(thin, 1, 6);
      expect(segment.entries.map((e) => e.seq)).toEqual([3]);
      for (const letter of ['A', 'B', 'D', 'E', 'F'])
        expect(JSON.stringify(segment)).not.toContain(`"${letter}"`);
      expect(await segmentsOf(thin)).toEqual([{ from: 1, to: 6, state: 'moved', payloads: 1 }]);
      expect(await payloadsOf(thin)).toEqual([7, 8, 9, 10]);
      // The metadata rows stay, and the chain verifies as before.
      expect(
        (await h.db!.admin.query('SELECT 1 FROM doc_commits WHERE doc_id = $1', [thin])).rowCount,
      ).toBe(10);
      expect(await logs().verify(ref(thin))).toEqual(verdict);
      expect(await logs().verify(ref(thin), { payloads: true })).toEqual({ ok: true, head: 10 });

      const events = await h.parts.audit!.query(h.tenant, { kind: 'history.thinned', limit: 10 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        doc: thin,
        actor: 'system',
        data: { removed: 5, fromSegments: 5, keptForVersions: 1, afterDays: 30 },
      });

      // The named version and the states at checkpoints are served; a state that needs a removed
      // payload answers that the detail is no longer available.
      const get = (path: string) =>
        h.call('GET', `/v1/documents/${thin}${path}`, { token: h.apiKey });
      for (const seq of [2, 3, 4, 8, 9]) {
        const r = await get(`/content?seq=${seq}`);
        expect(r.status, `seq ${seq}: ${r.text}`).toBe(200);
        expect(r.json.doc, `seq ${seq}`).toEqual(contentAt[seq]!.doc);
      }
      for (const seq of [1, 5, 6]) {
        const r = await get(`/content?seq=${seq}`);
        expect(r.status, `seq ${seq}: ${r.text}`).toBe(404);
        expect(r.json.detail, `seq ${seq}`).toMatch(/removed|no longer available/);
      }
      expect((await get('/history')).status).toBe(200);

      // The documents with their own policy, and the one with a tombstone, lost nothing more.
      expect((await segmentOf(tomb, 1, 6)).entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 6]);
      expect(await segmentsOf(gone)).toEqual([{ from: 1, to: 6, state: 'moved', payloads: 6 }]);

      // The next run reads the index, sees that the segment holds no more than the plan keeps, and
      // does not open the object.
      const key = objectKeys.segment(h.tenant, thin, 1, 6);
      counted.calls.length = 0;
      const next = await nextScheduledRun(['payloads.cold', 'payloads.thin']);
      expect(next['payloads.thin']).toMatchObject({ failures: 0, count: 0 });
      expect(counted.calls.filter((c) => c.endsWith(key))).toEqual([]);
      expect((await segmentOf(thin, 1, 6)).entries.map((e) => e.seq)).toEqual([3]);
      expect(
        await h.parts.audit!.query(h.tenant, { kind: 'history.thinned', limit: 10 }),
      ).toHaveLength(1);
    }, 240_000);

    it('reads nothing of a document whose key was destroyed, in the table or in its segment (HIS-041)', async () => {
      await h.service.parts.documentKeys!.destroy(ref(keyed));
      // A state this process has not rebuilt before, so that no copy in its memory answers.
      const r = await h.call('GET', `/v1/documents/${keyed}/content?seq=6`, { token: h.apiKey });
      expect(r.status, r.text).toBe(404);
      expect(r.json.detail).toMatch(/key of this document was destroyed/);
      const page = await h.call('GET', `/v1/documents/${keyed}/commits?after=0&limit=3`, {
        token: h.apiKey,
      });
      expect(page.status, page.text).toBe(404);
      // The chain itself still verifies: it covers the stored hashes.
      expect(await logs().verify(ref(keyed))).toEqual({ ok: true, head: 10 });
    }, 60_000);

    it('removes the index rows and the segment objects of a purged document (HIS-039)', async () => {
      const prefix = `${objectKeys.prefix(h.tenant)}docs/${gone}/`;
      expect((await raw.list(prefix)).some((k) => k.includes('/segments/'))).toBe(true);
      const owner = h.userToken({ [gone]: 'owner' }, { sub: 'olga' });
      expect((await h.call('DELETE', `/v1/documents/${gone}`, { token: owner })).status).toBe(204);
      // 31 days later the purge is due (the default of owner decision 30 is 30 days).
      await nextScheduledRun(['documents.purge'], 31 * DAY_MS);
      const end = Date.now() + 30_000;
      for (;;) {
        const left = await h.db!.admin.query('SELECT 1 FROM documents WHERE id = $1', [gone]);
        if (left.rowCount === 0 || Date.now() > end) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(
        (await h.db!.admin.query('SELECT 1 FROM documents WHERE id = $1', [gone])).rowCount,
      ).toBe(0);
      expect(
        (await h.db!.admin.query('SELECT 1 FROM commit_cold_segments WHERE doc_id = $1', [gone]))
          .rowCount,
      ).toBe(0);
      expect(
        (await h.db!.admin.query('SELECT 1 FROM doc_commits WHERE doc_id = $1', [gone])).rowCount,
      ).toBe(0);
      expect(await raw.list(prefix)).toEqual([]);
    }, 240_000);
  },
);
