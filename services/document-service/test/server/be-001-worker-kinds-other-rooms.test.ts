// BE-001 criterion 3, the kinds of work the replay test (be-001-replay-other-rooms.test.ts) does not
// cover: a comparison, a conversion and a checkpoint serialisation (a room's, and that of the content
// a document is created with) each run in a worker thread, and while one runs the main thread keeps
// acknowledging commits of another room.
//
// The service is the one process of BE-001 (REST, the DEP WebSocket and the rooms on one event loop,
// in-memory stores), started inside this test process, so the acknowledgements and the heavy work
// share the main thread unless the work really runs elsewhere. Every task the service sends to one of
// its pools is recorded with the time it was in flight. An acknowledgement of the other room counts
// only when it arrived inside such a window: the main thread received the commit, stored it and
// answered while the worker was still busy with the task.
//
// "A conversion" is the conversion of content into its stored form (canonical text, Zstandard,
// SHA-256): what `PUT /documents/{id}/content` and an import job ask of the service. The Word
// importer itself is a port the host supplies (EXP-098); its sandboxed worker is EXP-099.
//
// What stays on the main thread is not hidden: each case prints the longest wait of the other room
// and the delay of the event loop. Replacing the content of a document and committing to a large one
// validate the whole document on the room's loop (04 §12: steps 2 to 7 are not pre-empted), and that
// shows in those figures. The assertions here are about the tasks, not about that share.
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { threadId } from 'node:worker_threads';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { createDepDataPlane, type DepDataPlaneInstance } from '../../src/data-plane/index.ts';
import type { DataPlaneSettings } from '../../src/seams.ts';
import { startService, type Service } from '../../src/server.ts';
import { documentWithRegions } from '../control-plane/support.ts';
import { DepClient, insertText } from '../data-plane/client.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
type Json = Record<string, any>;

/** One task as a pool ran it: its kind, when it was in flight, and what its answer says of it. */
interface Flight {
  kind: string;
  from: number;
  to: number;
  /** The thread the task reports, for the kinds that report one. */
  thread: number | null;
  /** The canonical bytes of the content a task encoded, to tell a large document from a small one. */
  bytes: number | null;
}

/** Commits written to the compared document, and the text each one inserts. */
const COMMITS = 120;
const CHUNK = 'lorem ipsum dolor sit amet '.repeat(80);
/** Comparisons of the whole log, one after another. */
const COMPARISONS = 12;
/** Paragraphs and their text in the content that is converted and checkpointed. */
const PARAGRAPHS = 2500;
const PARAGRAPH_TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(18).trim();
/** Canonical bytes above which content counts as the large document (it has about 2.2 million). */
const LARGE_BYTES = 1_000_000;
/** Replacements of the whole content, one after another: each is one conversion. */
const CONVERSIONS = 6;
/** Large documents created one after another: each serialises its content at seq 0. */
const CREATIONS = 6;
/** Commits to the large document, each followed by one checkpoint of it. */
const CHECKPOINTS = 6;
/** Fewest acknowledgements of the other room that must fall inside the windows of the tasks. */
const MIN_ACKS_IN_FLIGHT = 5;
/**
 * The other room pauses this long after each acknowledgement, so that it stays below the message
 * rate a connection may keep up (BE-030: 200 a second by default) however fast the machine is.
 */
const PACE_MS = 5;

/** The fixture with many long paragraphs before its first one: about 2.2 MB of canonical text. */
function largeContent(mark: string) {
  const envelope = documentWithRegions() as {
    doc: { content: Array<{ type: string; content?: unknown[] }> };
  };
  const body = envelope.doc.content.find((n) => n.type === 'body')!;
  const paragraphs = Array.from({ length: PARAGRAPHS }, (_, i) => ({
    type: 'paragraph',
    attrs: { id: `pBig${String(i).padStart(12, '0')}`, style: 'Normal' },
    content: [{ type: 'text', text: `${mark} ${PARAGRAPH_TEXT}` }],
  }));
  body.content = [...paragraphs, ...body.content!];
  return envelope;
}

/** The position just inside the block with `id`. */
function inside(doc: unknown, id: string): number {
  let pos = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, p) => {
      if (n.attrs['id'] === id) pos = p + 1;
      return pos < 0;
    });
  if (pos < 0) throw new Error(`no block ${id}`);
  return pos;
}

/** The acknowledgements that arrived while one of `tasks` was in flight. */
const inFlight = (acks: readonly number[], tasks: readonly Flight[]) =>
  acks.filter((t) => tasks.some((f) => f.from < t && t < f.to));

/** The one-process service with a tenant, and what the cases need to drive and observe it. */
async function start(checkpoint?: DataPlaneSettings['checkpoint']) {
  let plane!: DepDataPlaneInstance;
  const s: Service = await startService({
    config: { ...configFromEnv({}), port: 0, workers: 1 },
    createDataPlane: (deps) =>
      (plane = createDepDataPlane({
        ...deps,
        settings: { ...deps.settings, ...(checkpoint ? { checkpoint } : {}) },
      })),
  });
  const tenant = randomUUID();
  await s.parts.registry.putTenant(tenant, 'worker kinds and rooms');
  const key = newApiKey(tenant);
  await s.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });

  /** Every task a pool ran, in the order the answers arrived. */
  const flights: Flight[] = [];
  const record = (pool: { run: unknown }): void => {
    const run = (pool.run as (kind: string, input: unknown) => Promise<unknown>).bind(pool);
    pool.run = async (kind: string, input: unknown) => {
      const from = performance.now();
      const out = (await run(kind, input)) as { threadId?: number; bytes?: number } | null;
      flights.push({
        kind,
        from,
        to: performance.now(),
        thread: out?.threadId ?? null,
        bytes: out?.bytes ?? null,
      });
      return out;
    };
  };
  record(s.pool);
  record(plane.workers);

  const rest = async (method: string, path: string, body?: unknown, headers: object = {}) => {
    const res = await fetch(`${s.url}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key.credential}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: (text ? JSON.parse(text) : {}) as Json,
    };
  };
  const create = async (content: unknown = documentWithRegions()) => {
    const r = await rest('POST', '/documents', { content });
    if (r.status !== 201) throw new Error(`create: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json['id'] as string;
  };
  const open = async (doc: string, sub: string) => {
    const token = (await rest('POST', '/tokens', { sub, docs: { [doc]: 'editor' } })).json[
      'token'
    ] as string;
    const client = await DepClient.connect(`${s.url.replace('http:', 'ws:')}/dep`);
    const welcome = await client.hello(token);
    if (welcome.t !== 'welcome') throw new Error(`hello: ${JSON.stringify(welcome)}`);
    const opened = await client.open(1, doc);
    if (opened.t !== 'ch.opened') throw new Error(`open: ${JSON.stringify(opened)}`);
    return { client, head: opened.d!['head'] as number };
  };

  /**
   * Runs `work` while a client commits to a room of its own, one commit at a time. Gives the times
   * of the acknowledgements, the longest a commit waited for its own, the tasks the pools ran
   * meanwhile and the delay of the event loop.
   */
  const whileAnotherRoomTypes = async (work: () => Promise<void>) => {
    const other = await create();
    const at = inside(
      (await rest('GET', `/documents/${other}/content`)).json['doc'],
      'pIntro0000000001',
    );
    const typist = await open(other, 'ben');
    const firstFlight = flights.length;
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    const started = performance.now();
    let finished = 0;
    const working = work().finally(() => {
      finished = performance.now();
    });
    // A failure of the work ends the typing too, and is thrown below.
    working.catch(() => undefined);
    const ackedAt: number[] = [];
    const waited: number[] = [];
    for (let base = typist.head; finished === 0; base++) {
      const sent = performance.now();
      const ack = await typist.client.submit(1, {
        base,
        steps: [insertText(at, 'x')],
        origin: 'input',
      });
      if (ack.t !== 'sync.ack') throw new Error(`the other room: ${JSON.stringify(ack)}`);
      const now = performance.now();
      if (finished === 0) {
        ackedAt.push(now);
        waited.push(now - sent);
      }
      await new Promise((resolve) => setTimeout(resolve, PACE_MS));
    }
    await working;
    loop.disable();
    typist.client.close();
    return {
      ran: flights.slice(firstFlight),
      acks: ackedAt,
      ms: finished - started,
      longestWaitMs: waited.length ? Math.max(...waited) : NaN,
      loopP99Ms: loop.percentile(99) / 1e6,
      loopMaxMs: loop.max / 1e6,
    };
  };
  return { s, plane, tenant, rest, create, open, whileAnotherRoomTypes };
}

type Started = Awaited<ReturnType<typeof start>>;
type Meanwhile = Awaited<ReturnType<Started['whileAnotherRoomTypes']>>;

/** The figures of a run, for the story's evidence (a measurement, not a target). */
function report(what: string, tasks: readonly Flight[], r: Meanwhile): void {
  const busy = tasks.reduce((a, f) => a + (f.to - f.from), 0);
  console.info(
    `BE-001 ${what}: ${tasks.length} tasks in flight for ${busy.toFixed(0)} ms of ` +
      `${r.ms.toFixed(0)} ms; ${r.acks.length} commits of the other room acknowledged meanwhile, ` +
      `${inFlight(r.acks, tasks).length} of them while a task was in flight; longest wait for an ` +
      `acknowledgement ${r.longestWaitMs.toFixed(1)} ms; event loop delay p99 ` +
      `${r.loopP99Ms.toFixed(1)} ms, max ${r.loopMaxMs.toFixed(1)} ms`,
  );
}

describe('comparisons and conversions leave the main thread to other rooms (BE-001 criterion 3)', () => {
  let h: Started;
  beforeAll(async () => {
    h = await start();
  });
  afterAll(async () => {
    await h?.s.close();
  });

  it('runs both pools in threads other than the main one', async () => {
    expect(await h.s.pool.run<number>('thread', null)).not.toBe(threadId);
    expect((await h.plane.workers.run('thread', null)).threadId).not.toBe(threadId);
  });

  it('acknowledges commits of another room while the worker compares two versions', async () => {
    const doc = await h.create();
    const at = inside(
      (await h.rest('GET', `/documents/${doc}/content`)).json['doc'],
      'pIntro0000000001',
    );
    // A log worth comparing: every commit inserts a block of text at the same place.
    const writer = await h.open(doc, 'ann');
    for (let i = 0; i < COMMITS; i++) {
      const ack = await writer.client.submit(1, {
        base: i,
        steps: [insertText(at, CHUNK)],
        origin: 'input',
      });
      expect(ack.t).toBe('sync.ack');
    }
    writer.client.close();

    const answers: Array<{ status: number; json: Json }> = [];
    const r = await h.whileAnotherRoomTypes(async () => {
      for (let i = 0; i < COMPARISONS; i++)
        answers.push(await h.rest('GET', `/documents/${doc}/diff?fromSeq=0&toSeq=${COMMITS}`));
    });

    expect(answers.map((a) => a.status)).toEqual(Array(COMPARISONS).fill(200));
    expect(answers[0]!.json).toMatchObject({ fromSeq: 0, toSeq: COMMITS, method: 'steps' });
    expect((answers[0]!.json['changes'] as unknown[]).length).toBeGreaterThan(0);
    // Every comparison was a task of the pool, answered by a thread that is not this one.
    const compared = r.ran.filter((f) => f.kind === 'compare');
    expect(compared.length).toBe(COMPARISONS);
    for (const f of compared) {
      expect(f.thread).not.toBeNull();
      expect(f.thread).not.toBe(threadId);
    }
    expect(h.s.pool.replaced).toBe(0);
    // Commits of the other room were acknowledged while a comparison was in flight. Had the
    // comparisons held the main thread, no acknowledgement could have arrived inside a window.
    expect(inFlight(r.acks, compared).length).toBeGreaterThanOrEqual(MIN_ACKS_IN_FLIGHT);
    report(`${COMPARISONS} comparisons of ${COMMITS} commits`, compared, r);
  }, 120_000);

  it('acknowledges commits of another room while the worker converts replaced content', async () => {
    const doc = await h.create();
    const before = { ...h.plane.workers.stats };
    const statuses: number[] = [];
    const r = await h.whileAnotherRoomTypes(async () => {
      for (let i = 0; i < CONVERSIONS; i++) {
        const etag = (await h.rest('GET', `/documents/${doc}/content`)).headers.get('etag')!;
        const put = await h.rest(
          'PUT',
          `/documents/${doc}/content`,
          largeContent(`Version ${i + 1}.`),
          { 'If-Match': etag },
        );
        statuses.push(put.status);
      }
    });

    expect(statuses).toEqual(Array(CONVERSIONS).fill(204));
    // Each replacement is one snapshot commit, so the head is at their number.
    expect((await h.s.parts.logs.head({ tenant: h.tenant, doc })).seq).toBe(CONVERSIONS);
    // Every replacement was converted by one task of the data plane's pool, never inline.
    const converted = r.ran.filter((f) => f.kind === 'encode');
    expect(converted.length).toBe(CONVERSIONS);
    for (const f of converted) expect(f.bytes).toBeGreaterThan(LARGE_BYTES);
    expect(h.plane.workers.stats.inline).toBe(before.inline);
    expect(h.plane.workers.stats.replaced).toBe(before.replaced);
    expect(inFlight(r.acks, converted).length).toBeGreaterThanOrEqual(MIN_ACKS_IN_FLIGHT);
    report(`${CONVERSIONS} conversions of ${converted[0]!.bytes} bytes`, converted, r);
  }, 120_000);

  it('acknowledges commits of another room while the worker serialises the content of new documents', async () => {
    // The content a document is created with is its checkpoint at seq 0 (D67).
    const statuses: number[] = [];
    const r = await h.whileAnotherRoomTypes(async () => {
      for (let i = 0; i < CREATIONS; i++) {
        const made = await h.rest('POST', '/documents', {
          content: largeContent(`Created ${i + 1}.`),
        });
        statuses.push(made.status);
      }
    });

    expect(statuses).toEqual(Array(CREATIONS).fill(201));
    // Each was serialised by one task of the pool, answered by a thread that is not this one. The
    // small document of the other room, created in the same run, was not: it has no task.
    const serialised = r.ran.filter((f) => f.kind === 'serialise');
    expect(serialised.length).toBe(CREATIONS);
    for (const f of serialised) {
      expect(f.thread).not.toBeNull();
      expect(f.thread).not.toBe(threadId);
    }
    expect(h.s.pool.replaced).toBe(0);
    expect(inFlight(r.acks, serialised).length).toBeGreaterThanOrEqual(MIN_ACKS_IN_FLIGHT);
    report(`${CREATIONS} serialisations of the content of new documents`, serialised, r);
  }, 120_000);
});

describe('checkpoint serialisation leaves the main thread to other rooms (BE-001 criterion 3)', () => {
  let h: Started;
  beforeAll(async () => {
    // A checkpoint after every stored commit (06 §2.2 says 2,000 commits or ten minutes; a setting).
    h = await start({ everyCommits: 1, everyMs: 600_000, minIntervalMs: 0 });
  });
  afterAll(async () => {
    await h?.s.close();
  });

  it('acknowledges commits of another room while the worker serialises checkpoints', async () => {
    const doc = await h.create(largeContent('Checkpointed.'));
    const ref = { tenant: h.tenant, doc };
    const at = inside(
      (await h.rest('GET', `/documents/${doc}/content`)).json['doc'],
      'pBig000000000000',
    );
    const writer = await h.open(doc, 'cay');
    const before = { ...h.plane.workers.stats };
    expect(await h.s.parts.checkpointIndex!.list(ref)).toEqual([]);

    const r = await h.whileAnotherRoomTypes(async () => {
      for (let i = 0; i < CHECKPOINTS; i++) {
        const ack = await writer.client.submit(
          1,
          { base: writer.head + i, steps: [insertText(at, 'y')], origin: 'input' },
          30_000,
        );
        expect(ack.t).toBe('sync.ack');
        const seq = ack.d!['seq'] as number;
        // The checkpoint due after this commit is serialised by the worker. The next commit waits
        // until it is recorded, so each window holds a checkpoint and no commit of this document.
        const deadline = Date.now() + 30_000;
        while (!(await h.s.parts.checkpointIndex!.list(ref)).some((row) => row.seq === seq)) {
          if (Date.now() > deadline) throw new Error(`no checkpoint at seq ${seq}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
    });
    writer.client.close();

    // The checkpoints of the large document, told from the other room's by the size they encoded.
    const large = r.ran.filter(
      (f) => f.kind === 'checkpoint' && f.bytes !== null && f.bytes > LARGE_BYTES,
    );
    expect(large.length).toBe(CHECKPOINTS);
    expect((await h.s.parts.checkpointIndex!.list(ref)).map((row) => row.seq)).toEqual(
      Array.from({ length: CHECKPOINTS }, (_, i) => writer.head + i + 1),
    );
    // None ran inline, and no worker had to be replaced.
    expect(h.plane.workers.stats.inline).toBe(before.inline);
    expect(h.plane.workers.stats.replaced).toBe(before.replaced);
    expect(inFlight(r.acks, large).length).toBeGreaterThanOrEqual(MIN_ACKS_IN_FLIGHT);
    report(`${CHECKPOINTS} checkpoints of ${large[0]!.bytes} bytes`, large, r);
  }, 120_000);
});
