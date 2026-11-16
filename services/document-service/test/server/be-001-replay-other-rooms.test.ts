// BE-001 criterion 3, the part about other rooms: while log replays for content reads run in the
// worker thread, the main thread keeps acknowledging commits of another room. The service is the
// one process of BE-001 (REST, the DEP WebSocket and the rooms on one event loop, in-memory stores,
// one worker thread), started inside this test process, so the acknowledgements and the replays
// share the main thread unless the replays really run elsewhere.
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { threadId } from 'node:worker_threads';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { startService, type Service } from '../../src/server.ts';
import { documentWithRegions } from '../control-plane/support.ts';
import { DepClient, insertText } from '../data-plane/client.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
type Json = Record<string, any>;

/** Commits written to the replayed document, and the size of the text each one inserts. */
const COMMITS = 120;
const CHUNK = 'lorem ipsum dolor sit amet '.repeat(80);
/** Pinned reads, one after another: each is one replay from sequence number 0 in the pool. */
const READS = 40;

describe('replays for content reads leave the main thread to other rooms (BE-001 criterion 3)', () => {
  let s: Service;
  let apiKey: string;
  beforeAll(async () => {
    s = await startService({ config: { ...configFromEnv({}), port: 0, workers: 1 } });
    const tenant = randomUUID();
    await s.parts.registry.putTenant(tenant, 'replay and rooms');
    const key = newApiKey(tenant);
    await s.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
    apiKey = key.credential;
  });
  afterAll(async () => {
    await s?.close();
  });

  const rest = async (method: string, path: string, body?: unknown, token = apiKey) => {
    const res = await fetch(`${s.url}/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Json };
  };
  const intro = (doc: unknown) => {
    let pos = -1;
    cdmSchema()
      .nodeFromJSON(doc)
      .descendants((n, p) => {
        if (n.attrs['id'] === 'pIntro0000000001') pos = p + 1;
        return pos < 0;
      });
    return pos;
  };
  const open = async (doc: string, sub: string) => {
    const token = (await rest('POST', '/tokens', { sub, docs: { [doc]: 'editor' } })).json[
      'token'
    ] as string;
    const c = await DepClient.connect(`${s.url.replace('http:', 'ws:')}/dep`);
    expect((await c.hello(token)).t).toBe('welcome');
    expect((await c.open(1, doc)).t).toBe('ch.opened');
    return c;
  };

  it('acknowledges commits of another room while the pool replays a long log many times', async () => {
    const create = async () =>
      (await rest('POST', '/documents', { content: documentWithRegions() })).json['id'] as string;
    const replayed = await create();
    const other = await create();
    const at = intro((await rest('GET', `/documents/${replayed}/content`)).json['doc']);

    // A log worth replaying: every commit inserts a block of text at the same place.
    const writer = await open(replayed, 'ann');
    for (let i = 0; i < COMMITS; i++) {
      const ack = await writer.submit(1, {
        base: i,
        steps: [insertText(at, CHUNK)],
        origin: 'input',
      });
      expect(ack.t).toBe('sync.ack');
    }
    writer.close();

    const typist = await open(other, 'ben');
    const replaysBefore = s.content.replays;
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();

    // The pinned reads: none is cached, so each is a replay in the worker.
    const started = performance.now();
    let finished = 0;
    const reads = (async () => {
      const all: Array<{ status: number; json: Json }> = [];
      for (let i = 0; i < READS; i++)
        all.push(await rest('GET', `/documents/${replayed}/content?seq=${COMMITS - i}`));
      finished = performance.now();
      return all;
    })();

    // Meanwhile the other room takes commits, one at a time, until the reads are answered.
    const ackedAt: number[] = [];
    for (let base = 0; finished === 0; base++) {
      const ack = await typist.submit(1, {
        base,
        steps: [insertText(at, 'x')],
        origin: 'input',
      });
      expect(ack.t).toBe('sync.ack');
      ackedAt.push(performance.now());
    }
    const answers = await reads;
    loop.disable();
    typist.close();

    expect(answers.map((a) => a.status)).toEqual(Array(READS).fill(200));
    expect(answers[0]!.json['seq']).toBe(COMMITS);
    // The replays ran, and in the worker thread, not here.
    expect(s.content.replays - replaysBefore).toBe(READS);
    expect(await s.pool.run<number>('thread', null)).not.toBe(threadId);
    expect(s.pool.replaced).toBe(0);

    // Commits of the other room were acknowledged while the replays were still running. Had the
    // replays held the main thread, no acknowledgement could have been sent before they ended.
    const during = ackedAt.filter((t) => t < finished);
    expect(during.length).toBeGreaterThanOrEqual(10);
    const gaps = during.map((t, i) => t - (i === 0 ? started : during[i - 1]!));
    const replayMs = finished - started;
    // The figures of this run, for the story's evidence (a measurement, not a target).
    console.info(
      `BE-001 replay and rooms: ${READS} replays of ${COMMITS} commits took ${replayMs.toFixed(0)} ms; ` +
        `${during.length} commits of the other room acknowledged meanwhile, longest wait ` +
        `${Math.max(...gaps).toFixed(1)} ms; event loop delay p99 ${(loop.percentile(99) / 1e6).toFixed(1)} ms, ` +
        `max ${(loop.max / 1e6).toFixed(1)} ms`,
    );
  }, 120_000);
});
