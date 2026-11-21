// HIS-029: moving old commit payloads to cold segments, through the composed service, on PostgreSQL
// and the S3-compatible store of the test environment (FND-010).
//
// The service runs with its real data plane and its own scheduler. The task `payloads.cold` is the
// one `startService` registers; no job is run by hand: the service clock is moved a day with
// `advance`, the queued slot becomes due and the job runner runs it. Its rows are written by
// `PgColdSegmentStore` over a pool whose connections `SET ROLE docedit_purge` (migrations 0073 and
// 0097), so the test also shows that the role's grants are enough. Commits are appended as a room
// does, with times in the past, and the checkpoints hold the real content at their `seq`.
//
// Criteria: 1 (old payloads leave `doc_commit_payloads` for `segments/{from}-{to}.payloads.zst`
// objects, the metadata rows stay), 2 (a range, a replay and a commits page that straddle the
// boundary read as before), 3 (nothing is deleted before the object read back; a move that died is
// resumed and loses nothing), 4 (the chain verifies with the payloads read from the segments, in
// the service and with the command-line tool of BE-081), 5 (an unreadable segment is `unavailable`
// and live editing goes on), 6 (a document under a legal hold is moved all the same).
//
// Skipped, with the reason, when PostgreSQL or the object store is not up:
// pwsh -NoProfile -File infra/test-env.ps1 up. The database is made for this file and dropped
// afterwards, and the objects of this run's tenant are removed. Test values only.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { LogCommit } from '@docedit/authority';
import { canonicalize, uuid7, type JsonEnvelope } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ColdSegmentStore } from '../../src/control-plane/cold-segments.ts';
import { PgColdSegmentStore } from '../../src/control-plane/cold-segments-pg.ts';
import { DAY_MS } from '../../src/control-plane/document-purge.ts';
import { rebuild, type RecoveryStores } from '../../src/data-plane/recovery.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { S3ObjectStore, type S3Settings } from '../../src/objects/s3.ts';
import { objectKeys, type ObjectStore, type PutOptions } from '../../src/objects/store.ts';
import type { PgLogStore } from '../../src/storage/log-store.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../control-plane/support.ts';
import { DepClient, insertText } from '../data-plane/client.ts';
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

const HOUR = 60 * 60 * 1000;
const LETTERS = 'ABCDEFGHIJ';
const CLI = fileURLToPath(new URL('../../src/data-plane/recovery-cli.ts', import.meta.url));
const SERVICE_DIR = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The object store the service is given: the real one, with a door the test can shut. `onGet` may
 * answer a read in the store's place, and `dead` makes every call fail, as for a process that is
 * gone.
 */
class GatedObjects implements ObjectStore {
  readonly #inner: ObjectStore;
  readonly calls: string[] = [];
  dead = false;
  onGet: ((key: string) => Promise<Uint8Array | null | undefined>) | null = null;

  constructor(inner: ObjectStore) {
    this.#inner = inner;
  }

  #enter(call: string): void {
    if (this.dead) throw new Error('the process is gone');
    this.calls.push(call);
  }

  async put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void> {
    this.#enter(`PUT ${key}`);
    return this.#inner.put(key, body, opts);
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.#enter(`GET ${key}`);
    const answered = this.onGet ? await this.onGet(key) : undefined;
    if (this.dead) throw new Error('the process is gone');
    return answered === undefined ? this.#inner.get(key) : answered;
  }

  async exists(key: string): Promise<boolean> {
    this.#enter(`HEAD ${key}`);
    return this.#inner.exists(key);
  }

  async delete(key: string): Promise<void> {
    this.#enter(`DELETE ${key}`);
    return this.#inner.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    this.#enter(`LIST ${prefix}`);
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

const decodeSegment = (bytes: Uint8Array): Segment =>
  JSON.parse(zstdDecompressSync(bytes).toString('utf8')) as Segment;
const encodeSegment = (s: Segment): Uint8Array =>
  zstdCompressSync(Buffer.from(canonicalize(s), 'utf8'));

describe.skipIf(skip !== null)(
  'cold segments (HIS-029, PostgreSQL and the S3-compatible store)',
  () => {
    let h: Harness;
    let purgePool: pg.Pool;
    const raw = new S3ObjectStore(s3Settings);
    const gate = new GatedObjects(raw);
    let inner: ColdSegmentStore | null = null;
    // The service is started before the database's name is known, so its store is made afterwards.
    const lazy: ColdSegmentStore = {
      documents: async (...a) => (inner ? inner.documents(...a) : []),
      pending: async (...a) => (inner ? inner.pending(...a) : []),
      facts: (...a) => inner!.facts(...a),
      locked: (...a) => inner!.locked(...a),
    };
    const clients: DepClient[] = [];
    let pos = -1;
    /** The content of a document of this file at each `seq`, read from one that never moves. */
    const contentAt: JsonEnvelope[] = [];
    let twin: string;

    beforeAll(async () => {
      h = await startHarness('postgres', {
        realDataPlane: true,
        config: { jobIdleMs: 50 },
        parts: { objects: gate, coldSegmentStore: lazy },
      });
      purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 4 });
      purgePool.on('error', () => {});
      purgePool.on('connect', (c) => {
        c.on('error', () => {});
        void c.query('SET ROLE docedit_purge');
      });
      inner = new PgColdSegmentStore(purgePool);

      // A document with the same ten commits as every other one here and no checkpoint, so that
      // nothing of it ever moves: what the others must read as, at every `seq`.
      twin = await documentWithHistory('Twin', { recentFrom: 1, checkpoints: [] });
      for (let seq = 0; seq <= 10; seq++) {
        const r = await h.call('GET', `/v1/documents/${twin}/content?seq=${seq}`, {
          token: h.apiKey,
        });
        if (r.status !== 200) throw new Error(`twin content at ${seq}: ${r.status} ${r.text}`);
        contentAt[seq] = { cdm: r.json.cdm, requires: r.json.requires, doc: r.json.doc };
      }
    }, 120_000);

    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      gate.dead = false;
      gate.onGet = null;
      await h?.close();
      await purgePool?.end();
      if (h) for (const key of await raw.list(objectKeys.prefix(h.tenant))) await raw.delete(key);
    }, 120_000);

    const ref = (d: string): DocRef => ({ tenant: h.tenant, doc: d });
    const logs = () => h.parts.logs as PgLogStore;
    const stores = (): RecoveryStores => ({
      logs: h.parts.logs,
      checkpoints: new ObjectCheckpointStore(raw),
      index: h.parts.checkpointIndex!,
    });

    /**
     * A document with ten typing commits. Commits below `recentFrom` are `oldDays` old (40 by
     * default) and the others are new. A checkpoint with the real content is written at each `seq`
     * of `checkpoints`.
     */
    async function documentWithHistory(
      title: string,
      opts: { recentFrom: number; checkpoints: number[]; oldAgeMs?: number },
    ): Promise<string> {
      const d = await h.createDocument({ content: documentWithRegions(), title });
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
      const oldAge = opts.oldAgeMs ?? 40 * DAY_MS;
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
              time: seq < opts.recentFrom ? h.now() - oldAge + i * 1000 : h.now() - (10 - i) * 1000,
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
      }
      for (const seq of opts.checkpoints) {
        const envelope = contentAt[seq]!;
        const text = canonicalize(envelope);
        await new ObjectCheckpointStore(h.parts.objects).put(r, seq, envelope);
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
          object_key: string;
          state: string;
          payloads: number;
        }>(
          `SELECT from_seq, to_seq, object_key, state, payloads FROM commit_cold_segments
            WHERE doc_id = $1 ORDER BY from_seq`,
          [d],
        )
      ).rows.map((x) => ({
        from: Number(x.from_seq),
        to: Number(x.to_seq),
        key: x.object_key,
        state: x.state,
        payloads: x.payloads,
      }));

    /** The metadata rows of a document as text, every column. */
    const commitRowsOf = async (d: string) =>
      (
        await h.db!.admin.query<{ row: string }>(
          'SELECT to_jsonb(c)::text AS row FROM doc_commits c WHERE doc_id = $1 ORDER BY seq',
          [d],
        )
      ).rows.map((x) => x.row);

    const segmentKeysOf = (d: string) =>
      raw.list(`${objectKeys.prefix(h.tenant)}docs/${d}/segments/`);

    const finished = async () =>
      (
        await h.db!.admin.query<{ result: { failures: number; count: number } }>(
          `SELECT result FROM jobs
            WHERE kind = 'schedule' AND payload->>'task' = 'payloads.cold' AND state = 'completed'
            ORDER BY finished_at`,
        )
      ).rows.map((x) => x.result);

    /**
     * Lets the scheduler run `payloads.cold` once: the clock moves a day, the queued slot is due,
     * and the job runner of the service runs it. Returns the result the job stored.
     */
    async function nextScheduledRun(): Promise<{ failures: number; count: number }> {
      const before = (await finished()).length;
      h.advance(DAY_MS);
      // `advance` shifts the jobs' times in the database; a call waits for that.
      await h.call('GET', '/healthz');
      const end = Date.now() + 60_000;
      for (;;) {
        const done = await finished();
        if (done.length > before) return done[done.length - 1]!;
        if (Date.now() > end) throw new Error('the scheduler did not run payloads.cold in time');
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    let main: string;
    let held: string;
    let young: string;
    let edge: string;
    let cut: string;
    let tamper: string;
    let rest: string;
    const before: {
      log?: LogCommit[];
      hashes: string[];
      rows?: string[];
      verdict?: unknown;
      commitsPage?: unknown;
      history?: unknown;
      diff?: unknown;
    } = { hashes: [] };
    let firstRun: { failures: number; count: number };

    it('moves the payloads older than 30 days to segment objects and keeps the metadata rows (criterion 1)', async () => {
      // Seq 1 to 5 are 40 days old and 6 to 10 are new. Checkpoints at 2 and 8.
      main = await documentWithHistory('Main', { recentFrom: 6, checkpoints: [2, 8] });
      held = await documentWithHistory('Held', { recentFrom: 6, checkpoints: [2, 8] });
      cut = await documentWithHistory('Cut', { recentFrom: 6, checkpoints: [2, 8] });
      tamper = await documentWithHistory('Tamper', { recentFrom: 6, checkpoints: [2, 8] });
      // A document at rest: every commit is 40 days old and its newest checkpoint is at the head.
      rest = await documentWithHistory('At rest', { recentFrom: 11, checkpoints: [2, 10] });
      young = await documentWithHistory('Young', { recentFrom: 1, checkpoints: [8] });
      // Seq 1 to 5 are 29 days old when written; a day passes before the run, less an hour.
      edge = await documentWithHistory('Edge', {
        recentFrom: 6,
        checkpoints: [8],
        oldAgeMs: 29 * DAY_MS - HOUR,
      });
      // A real legal hold on one document (criterion 6).
      const hold = await h.call('POST', `/v1/documents/${held}/holds`, {
        token: h.apiKey,
        body: { reason: 'Matter 2026-41' },
      });
      expect(hold.status, hold.text).toBe(201);

      // What the main document reads as before anything moves. It is not read over HTTP at the
      // states compared later, so no cache of the service stands in for the log.
      before.log = await logs().read(ref(main), 1, 10);
      for (let seq = 0; seq <= 10; seq++)
        before.hashes[seq] = (await rebuild(stores(), ref(main), seq)).hash;
      before.rows = await commitRowsOf(main);
      before.verdict = await logs().verify(ref(main), { payloads: true });
      expect(before.verdict).toEqual({ ok: true, head: 10 });
      before.commitsPage = (
        await h.call('GET', `/v1/documents/${main}/commits?after=0&limit=200`, {
          token: h.apiKey,
        })
      ).json;
      before.history = (
        await h.call('GET', `/v1/documents/${main}/history`, { token: h.apiKey })
      ).json;
      before.diff = (
        await h.call('GET', `/v1/documents/${main}/diff?fromSeq=2&toSeq=7`, { token: h.apiKey })
      ).json;
      expect((before.commitsPage as { items: unknown[] }).items).toHaveLength(10);
      expect(await payloadsOf(main)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      firstRun = await nextScheduledRun();
      expect(firstRun.failures).toBe(0);
      // Five payloads each of the main, held, cut and tamper documents, and ten of the one at rest.
      expect(firstRun.count).toBe(30);
      expect(await payloadsOf(rest)).toEqual([]);
      expect(await segmentsOf(rest)).toMatchObject([
        { from: 1, to: 10, state: 'moved', payloads: 10 },
      ]);

      // The payload rows of seq 1 to 5 are gone; 6 to 10 are newer than 30 days and stay.
      expect(await payloadsOf(main)).toEqual([6, 7, 8, 9, 10]);
      expect(await segmentsOf(main)).toEqual([
        {
          from: 1,
          to: 5,
          key: `tenants/${h.tenant}/docs/${main}/segments/1-5.payloads.zst`,
          state: 'moved',
          payloads: 5,
        },
      ]);
      // The object is in object storage under the key of 06 section 4.2, Zstandard-compressed.
      expect(await segmentKeysOf(main)).toEqual([
        `tenants/${h.tenant}/docs/${main}/segments/1-5.payloads.zst`,
      ]);
      const object = await raw.get(objectKeys.segment(h.tenant, main, 1, 5));
      expect(object).not.toBeNull();
      // Zstandard frames start with the magic number 0xFD2FB528, little-endian.
      expect([...object!.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
      const segment = decodeSegment(object!);
      expect(segment.format).toBe('docedit-payload-segment/1');
      expect(segment.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      const hashes = await h.db!.admin.query<{ seq: string; hash: string }>(
        `SELECT seq, encode(payload_hash, 'hex') AS hash FROM doc_commits
          WHERE doc_id = $1 AND seq <= 5 ORDER BY seq`,
        [main],
      );
      expect(segment.entries.map((e) => e.payloadHash)).toEqual(hashes.rows.map((x) => x.hash));

      // The metadata rows are what they were, every column, the payload hash and the chain included.
      expect(await commitRowsOf(main)).toEqual(before.rows);
      // Listing and filtering need no payload: the history list is what it was.
      const list = await h.call('GET', `/v1/documents/${main}/history`, { token: h.apiKey });
      expect(list.status, list.text).toBe(200);
      expect(list.json).toEqual(before.history);

      // 30 days is the default: commits 29 days and 23 hours old stay where they are, and a
      // document with nothing old or with no checkpoint is not touched.
      expect(await payloadsOf(edge)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(await payloadsOf(young)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(await payloadsOf(twin)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(await segmentsOf(edge)).toEqual([]);

      const events = await h.parts.audit!.query(h.tenant, {
        kind: 'history.moved',
        doc: main,
        limit: 10,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor: 'system',
        data: { segments: 1, payloads: 5, held: false, afterDays: 30 },
      });
      // No text of the document is in the audit event.
      for (const letter of LETTERS)
        expect(JSON.stringify(events[0]!.data)).not.toContain(`"${letter}"`);
    }, 180_000);

    it('reads a range, a replay and a commits page that straddle the boundary as before the move (criterion 2)', async () => {
      // The log itself: seq 1 to 5 from the segment, 6 to 10 from the table, as one range.
      expect(await logs().read(ref(main), 1, 10)).toEqual(before.log);
      expect(await logs().read(ref(main), 4, 7)).toEqual(before.log!.slice(3, 7));
      expect(await logs().read(ref(main), 5, 5)).toEqual(before.log!.slice(4, 5));
      const byId = await logs().byId(ref(main), before.log![2]!.id);
      expect(byId).toEqual(before.log![2]);

      // A replay to every state gives the same content: from the content at 0 across seq 1 and 2,
      // and from the checkpoint at 2 across the cold 3 to 5 into the hot 6 and 7.
      for (let seq = 0; seq <= 10; seq++)
        expect((await rebuild(stores(), ref(main), seq)).hash, `seq ${seq}`).toBe(
          before.hashes[seq],
        );
      expect(await rebuild(stores(), ref(main), 7)).toMatchObject({ from: 2, replayed: 5 });

      // Over HTTP with the service credential: the content at each state is what the document
      // that never moved reads as.
      for (const seq of [1, 3, 4, 5, 6, 7, 9]) {
        const r = await h.call('GET', `/v1/documents/${main}/content?seq=${seq}`, {
          token: h.apiKey,
        });
        expect(r.status, `seq ${seq}: ${r.text}`).toBe(200);
        expect(r.json.doc, `seq ${seq}`).toEqual(contentAt[seq]!.doc);
      }
      // A commits page that starts in the segment and ends in the table.
      const page = await h.call('GET', `/v1/documents/${main}/commits?after=0&limit=200`, {
        token: h.apiKey,
      });
      expect(page.status, page.text).toBe(200);
      expect(page.json).toEqual(before.commitsPage);
      const part = await h.call('GET', `/v1/documents/${main}/commits?after=3&limit=4`, {
        token: h.apiKey,
      });
      expect(part.json.items.map((c: { seq: number }) => c.seq)).toEqual([4, 5, 6, 7]);
      expect(part.json.items).toEqual(
        (before.commitsPage as { items: unknown[] }).items.slice(3, 7),
      );
      // A comparison over a range that straddles the boundary.
      const diff = await h.call('GET', `/v1/documents/${main}/diff?fromSeq=2&toSeq=7`, {
        token: h.apiKey,
      });
      expect(diff.status, diff.text).toBe(200);
      expect(diff.json).toEqual(before.diff);

      // And as a person, through the data plane: content at an old state and a page of commits.
      const owner = h.userToken({ [main]: 'owner' }, { sub: 'olga' });
      for (const seq of [4, 7]) {
        const r = await h.call('GET', `/v1/documents/${main}/content?seq=${seq}`, { token: owner });
        expect(r.status, `seq ${seq}: ${r.text}`).toBe(200);
        expect(r.json.doc, `seq ${seq}`).toEqual(contentAt[seq]!.doc);
      }
      const asOwner = await h.call('GET', `/v1/documents/${main}/commits?after=2&limit=6`, {
        token: owner,
      });
      expect(asOwner.status, asOwner.text).toBe(200);
      expect(asOwner.json.items.map((c: { seq: number }) => c.seq)).toEqual([3, 4, 5, 6, 7, 8]);
      const stepsOf = (items: Array<{ seq: number; steps: unknown }>) =>
        items.map((c) => [c.seq, c.steps]);
      expect(stepsOf(asOwner.json.items)).toEqual(
        stepsOf(
          (before.commitsPage as { items: Array<{ seq: number; steps: unknown }> }).items.slice(
            2,
            8,
          ),
        ),
      );
    }, 120_000);

    it('still verifies the chain, with the payloads and their hashes read from the segments (criterion 4)', async () => {
      // Every payload is hashed again, those in the table and those in the segment, and compared
      // with the hash the chain covers; the verdict is the one from before the move.
      expect(await logs().verify(ref(main), { payloads: true })).toEqual(before.verdict);
      expect(await logs().verify(ref(main))).toEqual({ ok: true, head: 10 });

      // The command-line tool of BE-081, as an operator runs it, with no service in between.
      const c = h.db!.serviceConfig;
      const env = {
        DOCEDIT_DATABASE_URL: `postgres://${encodeURIComponent(String(c.user))}:${encodeURIComponent(String(c.password))}@${c.host}:${c.port}/${c.database}`,
        DOCEDIT_S3_HOST: S['DOCEDIT_S3_HOST'] ?? '',
        DOCEDIT_S3_PORT: S['DOCEDIT_S3_PORT'] ?? '',
        DOCEDIT_S3_REGION: s3Settings.region,
        DOCEDIT_S3_BUCKET: s3Settings.bucket,
        DOCEDIT_S3_ACCESS_KEY: s3Settings.accessKeyId,
        DOCEDIT_S3_SECRET_KEY: s3Settings.secretAccessKey,
      };
      const clean = await runCli(['verify', '--tenant', h.tenant, '--doc', main], env);
      expect(clean.code, clean.stderr).toBe(0);
      expect(clean.stdout).toContain('chain ok up to seq 10');
      expect(clean.stdout).toMatch(/checkpoint 2 ok/);
      expect(clean.stdout).toMatch(/checkpoint 8 ok/);
      const rebuilt = await runCli(
        ['rebuild', '--tenant', h.tenant, '--doc', main, '--seq', '7'],
        env,
      );
      expect(rebuilt.code, rebuilt.stderr).toBe(0);
      expect(rebuilt.stdout.split(/\s+/)[0]).toBe(before.hashes[7]);

      // A payload changed inside the segment object: the chain does not verify, and the commit is named.
      const key = objectKeys.segment(h.tenant, tamper, 1, 5);
      const original = (await raw.get(key))!;
      const segment = decodeSegment(original);
      const forged: Segment = {
        ...segment,
        entries: segment.entries.map((e) =>
          e.seq === 3 ? { ...e, payload: { steps: [], retired: [], claimed: [] } } : e,
        ),
      };
      await raw.put(key, encodeSegment(forged));
      expect(await logs().verify(ref(tamper), { payloads: true })).toEqual({
        ok: false,
        seq: 3,
        reason: 'the payload in a cold segment does not match its hash',
      });
      const broken = await runCli(['verify', '--tenant', h.tenant, '--doc', tamper], env);
      expect(broken.code).toBe(1);
      expect(broken.stderr).toContain('broken at seq 3');
      // The same with the recorded hash made to fit the changed payload: the hash a segment records
      // must be the hash the chain covers.
      const emptyHash = createHash('sha256')
        .update(canonicalize({ steps: [], retired: [], claimed: [] }), 'utf8')
        .digest('hex');
      await raw.put(
        key,
        encodeSegment({
          ...forged,
          entries: forged.entries.map((e) => (e.seq === 3 ? { ...e, payloadHash: emptyHash } : e)),
        }),
      );
      expect(await logs().verify(ref(tamper), { payloads: true })).toMatchObject({
        ok: false,
        seq: 3,
      });
      // The object gone: the payloads cannot be checked, and the verdict says so.
      await raw.delete(key);
      expect(await logs().verify(ref(tamper), { payloads: true })).toEqual({
        ok: false,
        seq: 1,
        reason: 'a cold segment cannot be read, so its payloads cannot be checked',
      });
      // The chain itself needs no payload and still verifies.
      expect(await logs().verify(ref(tamper))).toEqual({ ok: true, head: 10 });
      await raw.put(key, original);
      expect(await logs().verify(ref(tamper), { payloads: true })).toEqual({ ok: true, head: 10 });
    }, 180_000);

    it('moves a document under a legal hold all the same, because moving is not thinning (criterion 6)', async () => {
      expect(await h.parts.holds!.inForce(h.tenant, held)).toBe(true);
      expect(await payloadsOf(held)).toEqual([6, 7, 8, 9, 10]);
      expect(await segmentsOf(held)).toMatchObject([
        { from: 1, to: 5, state: 'moved', payloads: 5 },
      ]);
      const events = await h.parts.audit!.query(h.tenant, {
        kind: 'history.moved',
        doc: held,
        limit: 10,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ data: { held: true, payloads: 5 } });
      // Nothing of the held document is lost: every state still rebuilds, and the chain verifies.
      for (let seq = 0; seq <= 10; seq++)
        expect((await rebuild(stores(), ref(held), seq)).hash, `seq ${seq}`).toBe(
          before.hashes[seq],
        );
      expect(await logs().verify(ref(held), { payloads: true })).toEqual({ ok: true, head: 10 });
    }, 60_000);

    it('answers unavailable for a cold range whose segment cannot be read, and live editing goes on (criterion 5)', async () => {
      const key = objectKeys.segment(h.tenant, cut, 1, 5);
      const original = (await raw.get(key))!;
      const owner = h.userToken({ [cut]: 'owner' }, { sub: 'olga' });
      const get = (path: string, token: string = h.apiKey) =>
        h.call('GET', `/v1/documents/${cut}${path}`, { token });

      for (const state of ['missing', 'not a segment', 'a changed payload'] as const) {
        if (state === 'missing') await raw.delete(key);
        if (state === 'not a segment') await raw.put(key, new TextEncoder().encode('lost'));
        if (state === 'a changed payload') {
          const s = decodeSegment(original);
          s.entries[0]!.payload = { steps: [], retired: [], claimed: [] };
          await raw.put(key, encodeSegment(s));
        }
        // A replay, a commits page and a comparison that need the cold range.
        for (const path of [
          '/content?seq=1',
          '/commits?after=0&limit=3',
          '/diff?fromSeq=0&toSeq=4',
        ]) {
          const r = await get(path);
          expect(r.status, `${state} ${path}: ${r.text}`).toBe(503);
          expect(r.json.code, `${state} ${path}`).toBe('unavailable');
          expect(r.headers.get('retry-after'), `${state} ${path}`).not.toBeNull();
          // Nothing of the document is in the answer.
          expect(r.text).not.toContain('Hello');
        }
        const asOwner = await get('/content?seq=1', owner);
        expect(asOwner.status, `${state}: ${asOwner.text}`).toBe(503);
        expect(asOwner.json.code).toBe('unavailable');
      }

      // What needs no cold payload is served: the list, the head, the states from the newest
      // checkpoint on, and the commits after it.
      const list = await get('/history');
      expect(list.status, list.text).toBe(200);
      for (const [path, seq] of [
        ['/content', 10],
        ['/content?seq=8', 8],
        ['/content?seq=9', 9],
      ] as const) {
        const r = await get(path);
        expect(r.status, `${path}: ${r.text}`).toBe(200);
        expect(r.json.doc, path).toEqual(contentAt[seq]!.doc);
      }
      const tail = await get('/commits?after=8&limit=10');
      expect(tail.status, tail.text).toBe(200);
      expect(tail.json.items.map((c: { seq: number }) => c.seq)).toEqual([9, 10]);
      expect((await get('/content', owner)).status).toBe(200);

      // Live editing: a person opens the document and writes; the commit is acknowledged and stored.
      const client = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`, {
        origin: 'https://app.example.test',
      });
      clients.push(client);
      const welcome = await client.hello(owner);
      expect(welcome.t, JSON.stringify(welcome.d)).toBe('welcome');
      const opened = await client.open(1, cut);
      expect(opened.t, JSON.stringify(opened.d)).toBe('ch.opened');
      const ack = await client.submit(1, { base: 10, steps: [insertText(pos, 'K')] });
      expect(ack.t, JSON.stringify(ack.d)).toBe('sync.ack');
      expect((await h.parts.logs.head(ref(cut))).seq).toBe(11);
      expect(await payloadsOf(cut)).toEqual([6, 7, 8, 9, 10, 11]);
      const second = await client.submit(1, { base: 11, steps: [insertText(pos, 'L')] });
      expect(second.t, JSON.stringify(second.d)).toBe('sync.ack');
      client.close();

      // A document that was at rest for longer than 30 days: every payload has moved, the one of the
      // commit at its newest checkpoint included, and the segment cannot be read. It opens, and a
      // person writes into it.
      await raw.delete(objectKeys.segment(h.tenant, rest, 1, 10));
      const old = await h.call('GET', `/v1/documents/${rest}/content?seq=5`, { token: h.apiKey });
      expect(old.status, old.text).toBe(503);
      const writer = h.userToken({ [rest]: 'owner' }, { sub: 'olga' });
      const head = await h.call('GET', `/v1/documents/${rest}/content`, { token: writer });
      expect(head.status, head.text).toBe(200);
      expect(head.json.doc).toEqual(contentAt[10]!.doc);
      const again = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`, {
        origin: 'https://app.example.test',
      });
      clients.push(again);
      expect((await again.hello(writer)).t).toBe('welcome');
      const reopened = await again.open(1, rest);
      expect(reopened.t, JSON.stringify(reopened.d)).toBe('ch.opened');
      const written = await again.submit(1, { base: 10, steps: [insertText(pos, 'K')] });
      expect(written.t, JSON.stringify(written.d)).toBe('sync.ack');
      expect((await h.parts.logs.head(ref(rest))).seq).toBe(11);
      expect(await payloadsOf(rest)).toEqual([11]);
      again.close();

      // With the object back, the cold range reads again.
      await raw.put(key, original);
      const back = await get('/content?seq=1');
      expect(back.status, back.text).toBe(200);
      expect(back.json.doc).toEqual(contentAt[1]!.doc);
    }, 120_000);

    it('deletes no payload before the segment read back, and nothing when it does not read back (criterion 3)', async () => {
      const d = await documentWithHistory('Read-back', { recentFrom: 6, checkpoints: [2, 8] });
      const key = objectKeys.segment(h.tenant, d, 1, 5);
      const beforeLog = await logs().read(ref(d), 1, 10);
      const seenAtReadBack: number[][] = [];
      gate.onGet = async (k) => {
        if (k !== key) return undefined;
        // The object is written, and it is being read back: every payload row is still there.
        seenAtReadBack.push(await payloadsOf(d));
        expect(await raw.exists(key)).toBe(true);
        // It reads back as something else.
        return new TextEncoder().encode('not what was written');
      };
      const failed = await nextScheduledRun();
      gate.onGet = null;
      expect(failed.failures).toBe(1);
      expect(seenAtReadBack).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
      // Nothing was deleted, no row says the payloads moved, and the object is gone again.
      expect(await payloadsOf(d)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(await segmentsOf(d)).toEqual([]);
      expect(await segmentKeysOf(d)).toEqual([]);
      expect(await logs().read(ref(d), 1, 10)).toEqual(beforeLog);
      expect(
        await h.parts.audit!.query(h.tenant, { kind: 'history.moved', doc: d, limit: 10 }),
      ).toEqual([]);
      // The order of a move that works: the object is put, then read back, and only then the rows go.
      gate.calls.length = 0;
      const rowsAtReadBack: number[][] = [];
      gate.onGet = async (k) => {
        if (k === key) rowsAtReadBack.push(await payloadsOf(d));
        return undefined;
      };
      const ok = await nextScheduledRun();
      gate.onGet = null;
      expect(ok.failures).toBe(0);
      const mine = gate.calls.filter((call) => call.endsWith(key));
      expect(mine).toEqual([`PUT ${key}`, `GET ${key}`]);
      expect(rowsAtReadBack).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
      expect(await payloadsOf(d)).toEqual([6, 7, 8, 9, 10]);
      expect(await logs().read(ref(d), 1, 10)).toEqual(beforeLog);
    }, 180_000);

    it('loses no payload when a move dies half way, and finishes it when the scheduler runs again (criterion 3)', async () => {
      const d = await documentWithHistory('Crash', { recentFrom: 6, checkpoints: [2, 8] });
      const key = objectKeys.segment(h.tenant, d, 1, 5);
      const beforeLog = await logs().read(ref(d), 1, 10);
      const hashes: string[] = [];
      for (let seq = 0; seq <= 10; seq++) hashes[seq] = (await rebuild(stores(), ref(d), seq)).hash;

      // The process dies while it reads the object back: the session that holds the document's
      // lock and the open transaction is ended by the server, and nothing the process would do
      // afterwards happens.
      let killed = 0;
      gate.onGet = async (k) => {
        if (k !== key) return undefined;
        const r = await h.db!.admin.query(
          `SELECT pg_terminate_backend(l.pid) FROM pg_locks l
            WHERE l.locktype = 'advisory' AND l.granted AND l.pid <> pg_backend_pid()
              AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        );
        killed += r.rowCount ?? 0;
        gate.dead = true;
        return undefined;
      };
      const died = await nextScheduledRun();
      gate.onGet = null;
      expect(killed).toBe(1);
      expect(died.failures).toBe(1);

      // What a dead process leaves: the object, a pending row, and every payload row.
      expect(await payloadsOf(d)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(await segmentsOf(d)).toEqual([{ from: 1, to: 5, key, state: 'pending', payloads: 0 }]);
      expect(await raw.exists(key)).toBe(true);
      // The service is alive again. The pending row is not read: the log is served from the table.
      gate.dead = false;
      expect(await logs().read(ref(d), 1, 10)).toEqual(beforeLog);
      const r = await h.call('GET', `/v1/documents/${d}/content?seq=4`, { token: h.apiKey });
      expect(r.status, r.text).toBe(200);
      expect(r.json.doc).toEqual(contentAt[4]!.doc);

      // The scheduler runs again: the leftover is cleared and the payloads move.
      const resumed = await nextScheduledRun();
      expect(resumed.failures).toBe(0);
      expect(await payloadsOf(d)).toEqual([6, 7, 8, 9, 10]);
      expect(await segmentsOf(d)).toEqual([{ from: 1, to: 5, key, state: 'moved', payloads: 5 }]);
      expect(await segmentKeysOf(d)).toEqual([key]);
      expect(await logs().read(ref(d), 1, 10)).toEqual(beforeLog);
      for (let seq = 0; seq <= 10; seq++)
        expect((await rebuild(stores(), ref(d), seq)).hash, `seq ${seq}`).toBe(hashes[seq]);
      expect(await logs().verify(ref(d), { payloads: true })).toEqual({ ok: true, head: 10 });
      // The run before it also left the earlier documents as they were.
      expect(await logs().read(ref(main), 1, 10)).toEqual(before.log);
    }, 240_000);

    it('lets the service role read the index and nothing more', async () => {
      const rows = await h.db!.service.query('SELECT 1 FROM commit_cold_segments');
      expect(rows.rowCount).toBe(0); // no tenant is set: row-level security shows nothing
      for (const sql of [
        `INSERT INTO commit_cold_segments (doc_id, tenant_id, from_seq, to_seq, object_key, state, payloads, created_at)
         VALUES ('${main}', '${h.tenant}', 6, 6, 'k', 'pending', 0, now())`,
        "UPDATE commit_cold_segments SET state = 'pending'",
        'DELETE FROM commit_cold_segments',
        'DELETE FROM doc_commit_payloads',
      ])
        await expect(h.db!.service.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      // The purge role holds what the job needs and no more on the log.
      const c = await purgePool.connect();
      try {
        for (const sql of [
          'UPDATE doc_commits SET size = 0',
          "UPDATE doc_commit_payloads SET payload = '\\x00'",
          'DELETE FROM audit_events',
        ]) {
          await c.query('BEGIN');
          await c.query("SELECT set_config('docedit.tenant_id', $1, true)", [h.tenant]);
          await expect(c.query(sql), sql).rejects.toThrow(/permission denied/);
          await c.query('ROLLBACK');
        }
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    });
  },
);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv['DOCEDIT_S3_ENDPOINT'];
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: SERVICE_DIR, env: childEnv, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}
