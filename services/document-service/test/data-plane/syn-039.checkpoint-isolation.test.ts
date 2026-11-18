// SYN-039 criterion 2 (lane w4): a document at the canonical size limit of 16 MiB (invariant I7) is
// serialised as a checkpoint in the worker thread while a client edits another document on the same
// process. The acknowledgement latency of that client is measured before and during the
// checkpoint and judged against the SYN-015 target (50 ms median, 300 ms at the 99th percentile).
//
// What this does and does not show: the room, the WebSocket and the stores are the real ones, but the
// stores are in memory, so storage time is not in the acknowledgement; the target of SYN-015 is for
// the stage-1 deployment, which includes it. The figures are taken on the machine that runs the
// test and are printed, not stored. The result holds for the checkpoint task (base as encoded bytes,
// as the room passes it), not for the `encode` task, whose input is the whole object tree.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from './client.ts';
import { BASE_JSON, startPlane, type Plane } from './support.ts';

/** The canonical size limit of invariant I7. */
const LIMIT_BYTES = 16 * 1024 * 1024;
const MEDIAN_TARGET_MS = 50;
const P99_TARGET_MS = 300;

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
  const n = Math.ceil(bytes / per);
  for (let i = 0; i < n; i++)
    body.content!.push({
      type: 'paragraph',
      attrs: { id: `pBig${String(i).padStart(12, '0')}` },
      content: [{ type: 'text', text }],
    } as never);
  return { cdm: 1, requires: [] as string[], doc };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
}

describe('SYN-039 criterion 2: a 16 MiB checkpoint does not slow other documents', () => {
  let plane: Plane;
  beforeAll(async () => {
    plane = await startPlane({ settings: { workers: 1, workerTimeoutMs: 120_000 } });
  });
  afterAll(async () => {
    await plane?.close().catch(() => {});
  });

  it('keeps the acknowledgement latency of another document within the SYN-015 target', async () => {
    const pool = plane.plane.workers;
    const envelope = bigEnvelope(LIMIT_BYTES);
    // The stored form of the big document, made by the worker: this is the `base` the room hands to
    // the checkpoint task. It is not part of the measured window.
    const bigPos = posInside(cdmSchema().nodeFromJSON(envelope.doc), 'pBig000000000000');
    const encoded = await pool.run('encode', { envelope: envelope as never });
    expect(encoded.bytes, 'the document is at the 16 MiB limit').toBeGreaterThan(
      LIMIT_BYTES * 0.99,
    );
    expect(encoded.bytes).toBeLessThanOrEqual(LIMIT_BYTES * 1.02);

    const doc = await plane.createDocument();
    const bob = await plane.client('bob', { [doc]: 'owner' });
    const opened = await bob.open(1, doc);
    if (opened.t !== 'ch.opened') throw new Error(`open: ${JSON.stringify(opened)}`);
    let seq = 0;
    // One commit every 100 ms, about a typist at a 100 ms batching window (SYN-038); faster than that
    // the connection's own budget refuses the commits (SYN-037).
    const ackOnce = async (): Promise<number> => {
      await new Promise((r) => setTimeout(r, 100));
      const t0 = performance.now();
      const r = await bob.submit(1, { base: seq, steps: [insertText(intro(), 'x')] });
      if (r.t !== 'sync.ack' || !r.d) throw new Error(`submit: ${JSON.stringify(r)}`);
      seq = r.d.seq;
      return performance.now() - t0;
    };
    // Warm up so that the first acknowledgements do not count.
    for (let i = 0; i < 10; i++) await ackOnce();

    const quiet: number[] = [];
    const until = Date.now() + 2000;
    while (Date.now() < until) quiet.push(await ackOnce());

    const lag = monitorEventLoopDelay({ resolution: 1 });
    lag.enable();
    const during: number[] = [];
    const startedAt = performance.now();
    // One checkpoint takes about half a second, so several follow one another to give the
    // acknowledgements a window of seconds.
    const CHECKPOINTS = 8;
    const work = (async () => {
      let last: Awaited<ReturnType<typeof pool.run<'checkpoint'>>> | undefined;
      for (let i = 0; i < CHECKPOINTS; i++)
        last = await pool.run('checkpoint', {
          base: { encoded: encoded.encoded },
          cdm: 1,
          requires: [],
          commits: [[insertText(bigPos, 'z')]] as never,
        });
      return last!;
    })();
    let done = false;
    void work.then(
      () => (done = true),
      () => (done = true),
    );
    while (!done) during.push(await ackOnce());
    const checkpointMs = performance.now() - startedAt;
    lag.disable();
    const out = await work;

    const q = [...quiet].sort((a, b) => a - b);
    const d = [...during].sort((a, b) => a - b);
    const line = (name: string, s: number[], n: number) =>
      `${name}: ${n} acks, median ${percentile(s, 0.5).toFixed(2)} ms, p99 ${percentile(s, 0.99).toFixed(2)} ms, max ${s[s.length - 1]!.toFixed(2)} ms`;
    console.log(
      [
        `SYN-039 criterion 2 (${process.platform}, Node.js ${process.version}; memory stores; one worker)`,
        `${CHECKPOINTS} checkpoints of ${out.bytes} canonical bytes took ${checkpointMs.toFixed(0)} ms in the worker`,
        line('without a checkpoint', q, q.length),
        line('during the checkpoint', d, d.length),
        `event loop delay of the main thread during the checkpoint: p99 ${(lag.percentile(99) / 1e6).toFixed(2)} ms, max ${(lag.max / 1e6).toFixed(2)} ms`,
      ].join('\n'),
    );

    expect(out.bytes, 'the checkpoint is of the 16 MiB document').toBeGreaterThan(
      LIMIT_BYTES * 0.99,
    );
    expect(during.length, 'enough acknowledgements fell inside the checkpoint').toBeGreaterThan(10);
    expect(percentile(d, 0.5), 'median acknowledgement during the checkpoint').toBeLessThan(
      MEDIAN_TARGET_MS,
    );
    expect(percentile(d, 0.99), 'p99 acknowledgement during the checkpoint').toBeLessThan(
      P99_TARGET_MS,
    );
    expect(plane.errors).toEqual([]);
  }, 300_000);
});
