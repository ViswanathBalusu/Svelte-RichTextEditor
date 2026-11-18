// BE-019 criterion 5 (lane w5; owner decision 72): a document near the 16 MiB limit is parsed and
// checked in a worker thread when its room opens, the main thread builds it a slice at a time, and
// another room keeps acknowledging commits meanwhile.
//
// The room, the WebSocket and the stores are the real ones; the stores are in memory (the object
// store is a `MemoryObjectStore`), so storage time is not in the figures. They are taken on the
// machine that runs the test and are printed, not stored. Replaying the log tail, building the
// room's indexes and the gateway's first projection still run on the main thread (the story's Notes),
// which is why the test asserts progress and the worker, not a latency target.
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { MemoryCheckpointIndex } from '../../src/data-plane/index.ts';
import { buildFromParts } from '../../src/data-plane/open-parts.ts';
import { open } from '../../src/data-plane/tasks.ts';
import { ObjectCheckpointStore, encodeCheckpoint } from '../../src/objects/checkpoints.ts';
import { MemoryObjectStore } from '../../src/objects/store.ts';
import { insertText } from './client.ts';
import { BASE_JSON, startPlane, type Plane } from './support.ts';

const LIMIT_BYTES = 16 * 1024 * 1024;
const intro = () => posInside(baseDoc(), 'pIntro0000000001');

/** A document of about `bytes` of canonical content: the fixture with many long paragraphs. */
function bigEnvelope(bytes: number) {
  const doc = structuredClone(BASE_JSON) as {
    content: Array<{ type: string; content?: unknown[] }>;
  };
  const body = doc.content.find((n) => n.type === 'body')!;
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(18).trim();
  const per = JSON.stringify({
    type: 'paragraph',
    attrs: { id: 'pBig000000000000' },
    content: [{ type: 'text', text }],
  }).length;
  for (let i = 0; i < Math.ceil(bytes / per); i++)
    body.content!.push({
      type: 'paragraph',
      attrs: { id: `pBig${String(i).padStart(12, '0')}` },
      content: [{ type: 'text', text }],
    } as never);
  return { cdm: 1, requires: [] as string[], doc };
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;

describe('the open task and the builder (BE-019 criterion 5)', () => {
  it('build the same document as nodeFromJSON, with the large containers in slices', async () => {
    const envelope = bigEnvelope(200_000);
    const encoded = encodeCheckpoint(envelope as never);
    const parts = open({ encoded, slice: 50 });
    expect(parts.split.length, 'the body is cut').toBeGreaterThan(0);
    expect(parts.split[0]!.slices.length).toBeGreaterThan(1);
    expect(parts.bytes).toBe(Buffer.byteLength(JSON.stringify(envelope.doc), 'utf8'));
    const built = await buildFromParts(cdmSchema(), parts);
    const direct = cdmSchema().nodeFromJSON(envelope.doc);
    expect(built.eq(direct)).toBe(true);
    built.check();
  });

  it('lets the event loop run between two slices', async () => {
    const encoded = encodeCheckpoint(bigEnvelope(400_000) as never);
    const parts = open({ encoded, slice: 20 });
    const slices = parts.split.reduce((n, s) => n + s.slices.length, 0);
    expect(slices).toBeGreaterThan(10);
    let turns = 0;
    let stop = false;
    const spin = () => {
      turns++;
      if (!stop) setImmediate(spin);
    };
    setImmediate(spin);
    await buildFromParts(cdmSchema(), parts);
    stop = true;
    expect(turns, 'event loop turns while the nodes were built').toBeGreaterThanOrEqual(slices);
  });

  it('refuses a document that breaks the schema, in the task', () => {
    const bad = structuredClone(BASE_JSON) as { content: unknown[] };
    bad.content = [{ type: 'paragraph' }];
    const encoded = encodeCheckpoint({ cdm: 1, requires: [], doc: bad } as never);
    expect(() => open({ encoded, slice: 50 })).toThrow();
  });
});

describe('a 16 MiB room opens off the main thread (BE-019 criterion 5)', () => {
  let planes: Plane[] = [];
  afterEach(async () => {
    for (const p of planes) await p.close().catch(() => {});
    planes = [];
  });

  async function run(openInWorkerBytes: number) {
    const objects = new ObjectCheckpointStore(new MemoryObjectStore());
    const plane = await startPlane({
      settings: { workers: 1, workerTimeoutMs: 120_000, openInWorkerBytes },
      deps: { checkpoints: objects, checkpointIndex: new MemoryCheckpointIndex() },
    });
    planes.push(plane);
    const small = await plane.createDocument();
    await objects.put(plane.ref(small), 0, (await plane.checkpoints.get(plane.ref(small), 0))!);
    const big = await plane.createDocument();
    const envelope = bigEnvelope(LIMIT_BYTES);
    await objects.putEncoded(plane.ref(big), 0, encodeCheckpoint(envelope as never));

    const bob = await plane.client('bob', { [small]: 'owner' });
    const alice = await plane.client('alice', { [big]: 'owner' });
    const first = await bob.open(1, small);
    if (first.t !== 'ch.opened') throw new Error(`open: ${JSON.stringify(first)}`);
    let seq = 0;
    const ackOnce = async (): Promise<number> => {
      await new Promise((r) => setTimeout(r, 50));
      const t0 = performance.now();
      const r = await bob.submit(1, { base: seq, steps: [insertText(intro(), 'x')] });
      if (r.t !== 'sync.ack' || !r.d) throw new Error(`submit: ${JSON.stringify(r)}`);
      seq = r.d.seq;
      return performance.now() - t0;
    };
    for (let i = 0; i < 10; i++) await ackOnce();

    const before = { ...plane.plane.workers.stats };
    // The longest time the main thread went without running a 5 ms timer.
    let last = performance.now();
    let longestStall = 0;
    const tick = setInterval(() => {
      const n = performance.now();
      longestStall = Math.max(longestStall, n - last);
      last = n;
    }, 5);
    const during: number[] = [];
    const t0 = performance.now();
    let opened: Awaited<ReturnType<typeof alice.open>> | undefined;
    void alice.open(1, big).then((r) => (opened = r));
    while (!opened) during.push(await ackOnce());
    const openMs = performance.now() - t0;
    clearInterval(tick);
    if (opened.t !== 'ch.opened') throw new Error(`open: ${JSON.stringify(opened)}`);
    return {
      plane,
      during: during.sort((a, b) => a - b),
      openMs,
      longestStall,
      ran: plane.plane.workers.stats.run - before.run,
      inline: plane.plane.workers.stats.inline - before.inline,
    };
  }

  it('keeps acknowledging another room while it opens, and the open ran in the worker', async () => {
    const worker = await run(0);
    const main = await run(Number.POSITIVE_INFINITY);
    const line = (name: string, r: Awaited<ReturnType<typeof run>>) =>
      `${name}: open took ${r.openMs.toFixed(0)} ms; ${r.during.length} acks meanwhile, median ${percentile(r.during, 0.5).toFixed(1)} ms, p99 ${percentile(r.during, 0.99).toFixed(1)} ms, max ${r.during[r.during.length - 1]!.toFixed(1)} ms; longest stall of the main thread ${r.longestStall.toFixed(0)} ms; worker tasks ${r.ran}`;
    console.log(
      [
        `BE-019 criterion 5 (${process.platform}, Node.js ${process.version}; memory stores; one worker; a document of about 16 MiB)`,
        line('parsed in the worker', worker),
        line('parsed on the main thread', main),
      ].join('\n'),
    );
    expect(worker.ran, 'the open task ran in the worker pool').toBeGreaterThan(0);
    expect(worker.inline).toBe(0);
    expect(main.ran, 'no task with the worker path off').toBe(0);
    expect(worker.during.length, 'acknowledgements fell inside the open').toBeGreaterThan(2);
    expect(worker.plane.errors).toEqual([]);
  }, 300_000);
});
