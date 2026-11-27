/**
 * SEC-028 criterion 1 (10 §3.3 "stalling or crashing a process that hosts many rooms"; 04 §12;
 * 06 §8): commits designed to be expensive, sent in volume from several channels, and the
 * acknowledgement latency of other rooms on the same process, against the targets BE-058 names
 * (a median of 50 ms and a 99th percentile of 300 ms).
 *
 * The attackers, each on its own connection and channel, each sending its commit again as soon as
 * the last one is answered (support/sec-028-attack-worker.ts, on its own thread):
 *
 * - `max-steps`: 500 steps (`maxStepsPerCommit`) at the head.
 * - `max-rebase`: 500 steps from a base that stays behind, in the same room as `max-steps`, so the
 *   commit is rebased over up to `maxRebaseSteps` (5000) stored steps.
 * - `depth`: the block of the corpus fixture `i7-depth-12`, nested at the depth limit (I7).
 * - `huge-attributes`: 20 equation blocks, each with 4000 characters of LaTeX (the limit of I7),
 *   with new identifiers in each commit.
 * - `replace-around`: 500 `replaceAround` steps that each replace a paragraph's markup around its
 *   content.
 * - `one-mebibyte`: one step that inserts 1,000,000 characters, a commit just under
 *   `maxCommitBytes` (1 MiB), sent as chunks; the room's document grows towards the 16 MiB of I7.
 *
 * The victims are three editors, each in a room of its own, two of them in another tenant. Each
 * sends one small commit, waits for its `sync.ack`, pauses 20 ms and sends the next, for MEASURE_MS,
 * first alone (the baseline) and then during the attack; they are connected and in their rooms
 * before each measurement starts. The service and the timed clients share
 * one process and one event loop; loopback, memory storage. The run is made twice (SETTINGS): with
 * the service's default settings, which configure no admission budget, and with a budget for each
 * connection. The figures are for those settings and are printed by the test, with the event-loop
 * delay of the process during the attack.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Transform } from 'prosemirror-transform';
import { uuid7 } from '@docedit/model';
import { at, inside, loadDoc, stepsJson } from './support/cdm.ts';
import {
  documentWithRegions,
  insertText,
  startHarness,
  type Harness,
  type TestTenant,
} from './support/harness.ts';
import { MAX_FRAME, asCommit, baseOf, readCase, type Json } from './support/invariant-corpus.ts';
import type { AttackInput, Attacker, AttackerReport } from './support/sec-028-attack-worker.ts';
import { WireClient } from './support/wire.ts';

const MEASURE_MS = 15_000;
const MEDIAN_TARGET_MS = 50;
const P99_TARGET_MS = 300;

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

const featuresOf = (requires: unknown): string[] => [
  ...new Set(['presence', 'regions', ...(Array.isArray(requires) ? (requires as string[]) : [])]),
];

/**
 * The two settings measured. The budget of the second is this file's own choice, in the cost units
 * of `defaultCost` of the authority (a 500-step commit at the head costs about 550 units, the
 * commit of a mebibyte about 980): the spec gives no figure, and SYN-038 calibrates them.
 */
const SETTINGS = [
  { name: 'the default settings, no admission budget', admission: null, holds: false },
  {
    name: 'a connection budget of 1000 units, 200 a second',
    admission: { connection: { capacity: 1000, refillPerSecond: 200 } },
    holds: true,
  },
] as const;

describe.each(SETTINGS)('SEC-028 criterion 1: expensive commits, $name', (setting) => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness(
      'memory',
      setting.admission ? { dataPlane: { admission: setting.admission } } : {},
    );
  });
  afterAll(async () => {
    await h?.close();
  });

  const contentOf = async (tenant: TestTenant, doc: string) =>
    (await h.call('GET', `/v1/documents/${doc}/content`, { token: tenant.apiKey })).json as Json;

  /**
   * One victim: an editor that is connected, has said hello and has opened its room. `run` sends
   * small commits one after another for `ms` and gives the latencies in milliseconds. Setup is
   * apart from the measurement because SEC-028 measures the acknowledgement of commits in rooms
   * that are already open. The wait for `hello` is the test client's own five-second limit, not a
   * figure of the criterion, and an attack that stalls the process would fail it.
   */
  async function victim(tenant: TestTenant, sub: string) {
    const doc = await h.createDocument(tenant, documentWithRegions());
    const c = await WireClient.connect(h.wsUrl, { origin: tenant.origin });
    try {
      await c.hello(await h.mintToken(tenant, sub, { [doc]: 'editor' }));
      await c.open(1, doc);
    } catch (e) {
      c.terminate();
      throw e;
    }
    const content = await contentOf(tenant, doc);
    const pos = inside(loadDoc(content['doc']), 'pIntro0000000001');
    let base = content['seq'] as number;
    return {
      close: () => c.terminate(),
      async run(ms: number): Promise<number[]> {
        const out: number[] = [];
        const until = performance.now() + ms;
        while (performance.now() < until) {
          const t0 = performance.now();
          const r = await c.submit(1, { id: uuid7(), base, steps: [insertText(pos, 'v')] }, 30_000);
          out.push(performance.now() - t0);
          expect(r.t, JSON.stringify(r.d)).toBe('sync.ack');
          base = (r.d as { seq: number }).seq;
          await new Promise((done) => setTimeout(done, 20));
        }
        return out;
      },
    };
  }

  /** Three editors in three rooms, connected before any measurement. */
  async function editors() {
    const made = await Promise.all([victim(h.a, 'vera'), victim(h.b, 'bea'), victim(h.b, 'ben')]);
    return {
      close: () => made.forEach((v) => v.close()),
      measure: async (ms: number): Promise<number[]> =>
        (await Promise.all(made.map((v) => v.run(ms)))).flat().sort((x, y) => x - y),
    };
  }

  /** An attacker that owns a new document made from `base`. */
  async function attacker(
    name: string,
    base: Json,
    steps: (content: Json) => unknown[],
    more: Partial<Attacker> = {},
    doc?: string,
  ): Promise<Attacker> {
    const id = doc ?? (await h.createDocument(h.a, base));
    const content = await contentOf(h.a, id);
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

  it('measures three other rooms while six kinds of expensive commit are sent in volume', async () => {
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
      const steps = stepsJson(tr.steps);
      expect(steps.every((s) => s['stepType'] === 'replaceAround')).toBe(true);
      return steps;
    });

    const oneMebibyte = await attacker('one-mebibyte', plain, (content) => [
      insertText(inside(loadDoc(content['doc']), 'pIntro0000000001'), 'm'.repeat(1_000_000)),
    ]);

    const attackers = [maxSteps, maxRebase, depth, hugeAttributes, replaceAround, oneMebibyte];

    const first = await editors();
    const baseline = await first.measure(3000).finally(first.close);
    // Connected before the attack starts: the measurement is of commits, not of the handshake.
    const second = await editors();

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
    let reports: AttackerReport[];
    let during: number[];
    const loop = monitorEventLoopDelay({ resolution: 10 });
    try {
      expect(await next<string>('ready')).toBe('ready');
      // Let every attacker be in its loop before the measurement starts.
      await new Promise((done) => setTimeout(done, 1000));
      loop.enable();
      during = await second.measure(MEASURE_MS);
      loop.disable();
      const report = next<AttackerReport[]>('its report');
      worker.postMessage('stop');
      reports = await report;
    } finally {
      second.close();
      await worker.terminate();
    }

    const figures = {
      baseline: {
        commits: baseline.length,
        median: percentile(baseline, 50),
        p99: percentile(baseline, 99),
      },
      during: {
        commits: during.length,
        median: percentile(during, 50),
        p99: percentile(during, 99),
        max: during[during.length - 1],
      },
      eventLoopDelayMs: {
        p99: loop.percentile(99) / 1e6,
        max: loop.max / 1e6,
      },
      attackers: reports,
    };
    console.info(`SEC-028 expensive commits (${setting.name}): ${JSON.stringify(figures)}`);

    // The attack was real: every kind was sent and answered several times during the measurement.
    for (const r of reports) {
      const answered = Object.entries(r.answers)
        .filter(([k]) => k !== 'closed')
        .reduce((n, [, v]) => n + v, 0);
      expect(answered, `${r.name}: commits answered`).toBeGreaterThanOrEqual(3);
    }
    const bytes = Object.fromEntries(reports.map((r) => [r.name, r.bytes]));
    expect(bytes['one-mebibyte']).toBeGreaterThan(1_000_000);
    expect(bytes['one-mebibyte']).toBeLessThanOrEqual(1024 * 1024 + 512);

    // The other rooms, measured.
    if (!setting.holds) {
      // The finding (SEC-028 Notes): with no budget configured, which is the default, the attack
      // stalls the other rooms. This expectation fails when the default settings start to hold.
      expect(
        figures.during.p99,
        'the other rooms are no longer stalled under the default settings: move this case to the ones that hold',
      ).toBeGreaterThan(P99_TARGET_MS);
      return;
    }
    // With the budget set, an attacker who resends at once spends it and is refused (SEC-018
    // criterion 5): the attackers are answered `rate_limited` in volume. A cheap kind (the
    // nested block) may not spend the budget in a run, so the total is asserted, not each kind.
    const limited = reports.reduce((n, r) => n + (r.answers['rate_limited'] ?? 0), 0);
    expect(limited, 'rate_limited answers over all attackers').toBeGreaterThan(10);
    expect(
      reports.filter((r) => (r.answers['rate_limited'] ?? 0) > 0).length,
      'kinds of attacker answered rate_limited',
    ).toBeGreaterThanOrEqual(4);
    expect(figures.during.median, 'median acknowledgement, ms').toBeLessThanOrEqual(
      MEDIAN_TARGET_MS,
    );
    expect(figures.during.p99, '99th percentile acknowledgement, ms').toBeLessThanOrEqual(
      P99_TARGET_MS,
    );
  }, 240_000);
});
