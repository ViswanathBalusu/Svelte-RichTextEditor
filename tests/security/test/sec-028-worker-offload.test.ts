/**
 * SEC-028 criterion 3 (lane w8): while expensive commits are sent in volume, the work that is
 * heavy by itself (a replay of the log for a pinned read, a comparison of two versions, the
 * conversion of replaced content and the serialisation of a checkpoint) runs in worker threads,
 * and the event-loop delay stays within the budget of the load harness.
 *
 * The setting is the one of sec-028-expensive-commits.test.ts that holds (a connection budget of
 * 1000 units, 200 a second). The attackers are the same six kinds, on a thread of their own. In the
 * main process, beside the service, three things run for MEASURE_MS: the heavy work below, one
 * victim room that commits and waits for each acknowledgement, and a monitor of the event-loop
 * delay. Every task the service sends to one of its two pools is recorded with the thread that ran
 * it. The harness budget is the default of `eventLoopBudgetMs` in
 * services/document-service/scripts/load/stage1.ts: the 99th percentile of acknowledgement, 300 ms
 * (BE-058 criterion 3).
 *
 * What stays on the main thread is not hidden: the figures printed by the test include the delay of
 * the event loop, and 04 §12 (steps 2 to 7 are not pre-empted) says validation of a commit runs on
 * the room's loop.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { threadId, Worker } from 'node:worker_threads';
import { cdmSchema } from '@docedit/model/prosemirror';
import { Transform } from 'prosemirror-transform';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, inside, loadDoc, stepsJson } from './support/cdm.ts';
import {
  documentWithRegions,
  insertText,
  startHarness,
  type Harness,
} from './support/harness.ts';
import { MAX_FRAME, asCommit, baseOf, readCase, type Json } from './support/invariant-corpus.ts';
import type { AttackInput, Attacker, AttackerReport } from './support/sec-028-attack-worker.ts';
import { WireClient } from './support/wire.ts';

const MEASURE_MS = 12_000;
/** The harness's budget for the event-loop delay: `eventLoopBudgetMs` of stage1.ts, the ack target. */
const HARNESS_BUDGET_MS = 300;
/** Each kind of heavy work is asked for again this long after the last answer: a few a second. */
const HEAVY_PACE_MS = 250;
const COMMITS = 120;
const CHUNK = 'lorem ipsum dolor sit amet '.repeat(80);
/** About 0.5 MB of canonical text: a document under the 1 MB of BE-058's cold-open case. */
const PARAGRAPHS = 600;
const PARAGRAPH_TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(18).trim();
const LARGE_BYTES = 300_000;

interface Flight {
  kind: string;
  thread: number | null;
  bytes: number | null;
}

type Pool = { run: (kind: string, input: unknown) => Promise<unknown> };

/** The fixture with many long paragraphs before its first one: about 0.5 MB of canonical text. */
function largeContent(mark: string): Json {
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
  return envelope as unknown as Json;
}

const featuresOf = (requires: unknown): string[] => [
  ...new Set(['presence', 'regions', ...(Array.isArray(requires) ? (requires as string[]) : [])]),
];

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

describe('SEC-028 criterion 3: heavy work leaves the main thread while expensive commits arrive', () => {
  let h: Harness;
  const flights: Flight[] = [];

  beforeAll(async () => {
    h = await startHarness('memory', {
      dataPlane: {
        admission: { connection: { capacity: 1000, refillPerSecond: 200 } },
        // A checkpoint after every commit, so that the large document's are serialised in the run.
        checkpoint: { everyCommits: 1, everyMs: 600_000, minIntervalMs: 0 },
      },
    });
    // Every task of the service's pool and of the data plane's pool is recorded with its thread.
    const record = (pool: Pool): void => {
      const run = pool.run.bind(pool);
      pool.run = async (kind, input) => {
        const out = (await run(kind, input)) as { threadId?: number; bytes?: number } | null;
        flights.push({ kind, thread: out?.threadId ?? null, bytes: out?.bytes ?? null });
        return out;
      };
    };
    record(h.service.pool as unknown as Pool);
    const plane = h.service.dataPlane as unknown as { workers?: Pool };
    if (plane.workers) record(plane.workers);
  });
  afterAll(async () => {
    await h?.close();
  });

  const contentOf = async (doc: string) =>
    (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json as Json;

  async function attacker(
    name: string,
    base: Json,
    steps: (content: Json) => unknown[],
    more: Partial<Attacker> = {},
    doc?: string,
  ): Promise<Attacker> {
    const id = doc ?? (await h.createDocument(h.a, base));
    const content = await contentOf(id);
    return {
      name,
      origin: h.a.origin,
      token: await h.mintToken(h.a, `attacker-${name}`, { [id]: 'owner' }),
      doc: id,
      features: featuresOf(base['requires']),
      seq: content['seq'] as number,
      steps: steps(content),
      stale: false,
      ...more,
    };
  }

  /** A document of COMMITS commits, each a block of text at the same place, written by a client. */
  async function longLog(): Promise<string> {
    const doc = await h.createDocument(h.a, documentWithRegions());
    const pos = inside(loadDoc((await contentOf(doc))['doc']), 'pIntro0000000001');
    const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    try {
      await c.hello(await h.mintToken(h.a, 'writer', { [doc]: 'editor' }));
      await c.open(1, doc);
      for (let i = 0; i < COMMITS; i++) {
        const r = await c.submit(1, { id: uuid7(), base: i, steps: [insertText(pos, CHUNK)] });
        expect(r.t, JSON.stringify(r.d)).toBe('sync.ack');
        // Below the message rate a connection may keep up.
        await new Promise((done) => setTimeout(done, 6));
      }
    } finally {
      c.terminate();
    }
    return doc;
  }

  it('runs replay, comparison, conversion and checkpoint tasks in worker threads during the attack', async () => {
    const plain = documentWithRegions() as Json;
    const inserts = (content: Json) => {
      const pos = inside(loadDoc(content['doc']), 'pIntro0000000001');
      return Array.from({ length: 500 }, () => insertText(pos, 'a'));
    };
    const maxSteps = await attacker('max-steps', plain, inserts);
    const maxRebase = await attacker('max-rebase', plain, inserts, { stale: true }, maxSteps.doc);
    const deep = asCommit(baseOf(readCase('i7-depth-12')['base']), []);
    const depth = await attacker('depth', deep.base, () => deep.steps);
    const example = baseOf(readCase('i7-latex-4000')['base']);
    const equation = (readCase('i7-latex-4000')['steps'] as Json[])[0]!;
    const hugeAttributes = await attacker(
      'huge-attributes',
      example,
      () => [
        {
          ...equation,
          slice: {
            content: Array.from({ length: 20 }, (_, i) => ({
              type: 'equation_block',
              attrs: { id: `eqHUGE${String(i).padStart(10, '0')}`, latex: 'x'.repeat(4000) },
            })),
          },
        },
      ],
      { freshIds: 'HUGE' },
    );
    const replaceAround = await attacker('replace-around', plain, (content) => {
      const d = loadDoc(content['doc']);
      const pos = at(d, 'pIntro0000000001');
      const tr = new Transform(d);
      for (let i = 0; i < 500; i++)
        tr.setNodeMarkup(pos, null, {
          ...tr.doc.nodeAt(pos)!.attrs,
          align: i % 2 === 0 ? 'end' : 'start',
        });
      return stepsJson(tr.steps);
    });
    const oneMebibyte = await attacker('one-mebibyte', plain, (content) => [
      insertText(inside(loadDoc(content['doc']), 'pIntro0000000001'), 'm'.repeat(1_000_000)),
    ]);
    const attackers = [maxSteps, maxRebase, depth, hugeAttributes, replaceAround, oneMebibyte];

    // What the heavy work works on, made before the attack starts.
    const logged = await longLog();
    const converted = await h.createDocument(h.a, documentWithRegions());
    const big = await h.createDocument(h.a, largeContent('Checkpointed.'));
    const bigRef = { tenant: h.a.id, doc: big };
    const bigPos = inside(loadDoc((await contentOf(big))['doc']), 'pBig000000000000');
    const flightsBefore = flights.length;

    const worker = new Worker(new URL('./support/sec-028-attack-worker.ts', import.meta.url), {
      workerData: { wsUrl: h.wsUrl, maxFrame: MAX_FRAME, attackers } satisfies AttackInput,
    });
    const next = <T>(what: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`the attack worker did not post ${what}`)),
          120_000,
        );
        worker.once('message', (m) => {
          clearTimeout(timer);
          resolve(m as T);
        });
        worker.once('error', reject);
        worker.once('exit', (code) =>
          reject(new Error(`the attack worker exited with ${code} before ${what}`)),
        );
      });

    const loop = monitorEventLoopDelay({ resolution: 10 });
    const latencies: number[] = [];
    const answers = { replay: 0, compare: 0, convert: 0, checkpoint: 0 };
    let reports: AttackerReport[];
    try {
      expect(await next<string>('ready')).toBe('ready');
      await new Promise((done) => setTimeout(done, 1000));
      const until = performance.now() + MEASURE_MS;
      loop.enable();

      // The victim: one small commit after another in a room of its own.
      const victimDoc = await h.createDocument(h.b, documentWithRegions());
      const victim = (async () => {
        const c = await WireClient.connect(h.wsUrl, { origin: h.b.origin });
        try {
          await c.hello(await h.mintToken(h.b, 'vera', { [victimDoc]: 'editor' }));
          await c.open(1, victimDoc);
          const content = await (async () =>
            (await h.call('GET', `/v1/documents/${victimDoc}/content`, { token: h.b.apiKey }))
              .json as Json)();
          const pos = inside(loadDoc(content['doc']), 'pIntro0000000001');
          let base = content['seq'] as number;
          while (performance.now() < until) {
            const t0 = performance.now();
            const r = await c.submit(1, { id: uuid7(), base, steps: [insertText(pos, 'v')] }, 30_000);
            latencies.push(performance.now() - t0);
            expect(r.t, JSON.stringify(r.d)).toBe('sync.ack');
            base = (r.d as { seq: number }).seq;
            await new Promise((done) => setTimeout(done, 20));
          }
        } finally {
          c.terminate();
        }
      })();

      // Replays (pinned reads, never cached) and comparisons of the long log.
      const reading = (async () => {
        for (let i = 0; performance.now() < until; i++) {
          const r = await h.call('GET', `/v1/documents/${logged}/content?seq=${COMMITS - (i % 60)}`, {
            token: h.a.apiKey,
          });
          expect(r.status, r.text).toBe(200);
          answers.replay++;
          const d = await h.call('GET', `/v1/documents/${logged}/diff?fromSeq=0&toSeq=${COMMITS}`, {
            token: h.a.apiKey,
          });
          expect(d.status, d.text).toBe(200);
          answers.compare++;
          await new Promise((done) => setTimeout(done, HEAVY_PACE_MS));
        }
      })();

      // Conversions: replaced content of about 0.5 MB, each one a conversion into the stored form.
      const converting = (async () => {
        for (let i = 0; performance.now() < until; i++) {
          const etag = (
            await h.call('GET', `/v1/documents/${converted}/content`, { token: h.a.apiKey })
          ).headers.get('etag')!;
          const put = await h.call('PUT', `/v1/documents/${converted}/content`, {
            token: h.a.apiKey,
            body: largeContent(`Version ${i + 1}.`),
            headers: { 'If-Match': etag },
          });
          expect(put.status, put.text).toBe(204);
          answers.convert++;
          await new Promise((done) => setTimeout(done, HEAVY_PACE_MS));
        }
      })();

      // Checkpoints: a commit to the large document, then wait until its checkpoint is recorded.
      const checkpointing = (async () => {
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          await c.hello(await h.mintToken(h.a, 'cay', { [big]: 'editor' }));
          await c.open(1, big);
          let base = (await h.parts.logs.head(bigRef)).seq;
          while (performance.now() < until) {
            const r = await c.submit(1, { id: uuid7(), base, steps: [insertText(bigPos, 'y')] }, 30_000);
            expect(r.t, JSON.stringify(r.d)).toBe('sync.ack');
            base = (r.d as { seq: number }).seq;
            const deadline = Date.now() + 30_000;
            while (!(await h.parts.checkpointIndex!.list(bigRef)).some((row) => row.seq === base)) {
              if (Date.now() > deadline) throw new Error(`no checkpoint at seq ${base}`);
              await new Promise((done) => setTimeout(done, 5));
            }
            answers.checkpoint++;
            await new Promise((done) => setTimeout(done, HEAVY_PACE_MS));
          }
        } finally {
          c.terminate();
        }
      })();

      await Promise.all([victim, reading, converting, checkpointing]);
      loop.disable();
      const report = next<AttackerReport[]>('its report');
      worker.postMessage('stop');
      reports = await report;
    } finally {
      await worker.terminate();
    }

    const ran = flights.slice(flightsBefore);
    const kinds: Record<string, number> = {};
    for (const f of ran) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    latencies.sort((a, b) => a - b);
    const figures = {
      answers,
      tasksByKind: kinds,
      victim: { commits: latencies.length, median: percentile(latencies, 50), p99: percentile(latencies, 99) },
      eventLoopDelayMs: { p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
      rateLimited: reports.reduce((n, r) => n + (r.answers['rate_limited'] ?? 0), 0),
    };
    console.info(`SEC-028 heavy work during the attack: ${JSON.stringify(figures)}`);

    // The attack was real.
    expect(figures.rateLimited, 'rate_limited answers over all attackers').toBeGreaterThan(10);

    // Each kind of heavy work was triggered, and every task of it ran in a thread that is not this one.
    for (const [what, n] of Object.entries(answers)) expect(n, what).toBeGreaterThanOrEqual(2);
    // A replay is a `materialise` task of the service's pool.
    for (const kind of ['materialise', 'compare', 'encode', 'checkpoint']) {
      const tasks = ran.filter((f) => f.kind === kind);
      expect(tasks.length, `${kind} tasks`).toBeGreaterThanOrEqual(2);
      for (const f of tasks) if (f.thread !== null) expect(f.thread, `${kind} thread`).not.toBe(threadId);
    }
    expect(ran.filter((f) => f.thread !== null).length, 'tasks that report their thread').toBeGreaterThan(0);
    expect(
      ran.some((f) => f.kind === 'checkpoint' && f.bytes !== null && f.bytes > LARGE_BYTES),
    ).toBe(true);
    expect((h.service.pool as unknown as { replaced: number }).replaced).toBe(0);
    const plane = h.service.dataPlane as unknown as { workers?: { stats: { inline: number } } };
    expect(plane.workers?.stats.inline ?? 0, 'tasks run inline on the main thread').toBe(0);

    // The event loop and the other room, against the harness's budget.
    expect(figures.eventLoopDelayMs.p99, 'event-loop delay, 99th percentile, ms').toBeLessThanOrEqual(
      HARNESS_BUDGET_MS,
    );
    // The victim's acknowledgement latency is printed, not asserted: SEC-028 criterion 1 owns it.
  }, 300_000);
});
