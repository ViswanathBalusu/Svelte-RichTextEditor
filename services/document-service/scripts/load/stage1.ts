/**
 * BE-058: the stage 1 load test of one node, and the gate that compares a run with a baseline.
 *
 * `stage1` opens 2,000 connections on 500 documents (the settings default to the stage 1 figures of
 * 06 §6; the others watch), and then runs phases with more and more typists, each committing a few
 * times a second. During every phase it opens documents of about 700 kB of CDM cold. At the end it
 * lets every client leave. It reports measured values beside the targets of 00 §9 and 06 §6, and
 * checks three things that the targets do not state: no healthy client was closed with
 * `slow_consumer` (or at all), the number of open rooms returned to zero, and the event loop of the
 * service stayed within the budget the harness sets.
 *
 * Why phases: the specification says that a busy typist produces a few commits a second (06 §10)
 * but not how many of 500 open documents have one. The curve of phases shows where one node stops
 * meeting the targets; the gate looks at one phase, `gateTypists`, which is a setting of the run
 * and not a figure of the specification.
 *
 * Targets are targets. A run is a measurement of the machine it ran on, with the settings it ran
 * under, and the report says both.
 */
import { performance } from 'node:perf_hooks';
import {
  LoadClient,
  createDocument,
  makeContent,
  mapLimit,
  mintToken,
  percentile,
  round,
  sleep,
  summarise,
  type ServiceHandle,
  type Summary,
} from './lib.ts';
import { TARGETS } from './scenarios.ts';

export interface Stage1Settings {
  /** Connections held open, each on one document. */
  connections: number;
  /** Documents open; the first connection of each is the one that may type. */
  documents: number;
  /** Typists of each phase, ascending; each is on a document of its own. */
  typistSteps: number[];
  /** The phase the gate looks at: one of `typistSteps`. */
  gateTypists: number;
  /** Commits a second from each typist ("a few"). */
  commitsPerSecond: number;
  /** How long each phase lasts. */
  holdMs: number;
  /** Documents opened cold in each phase, each of `coldParagraphs` paragraphs. */
  coldDocuments: number;
  coldParagraphs: number;
  /** Connections opened at once while the ramp-up runs. */
  connectConcurrency: number;
  /** The most the event loop of the service may be delayed (its 99th percentile), in ms. */
  eventLoopBudgetMs: number;
  /** How long to wait for the open rooms to return to zero after the clients leave. */
  drainWaitMs: number;
  /** The `DOCEDIT_METRICS_TOKEN` the service was started with. */
  metricsToken: string;
}

export const STAGE1_DEFAULTS: Omit<Stage1Settings, 'metricsToken'> = {
  connections: TARGETS.stage1Connections,
  documents: TARGETS.stage1Documents,
  // One typist on 25, 50, 75, 100 and 150 of the 500 documents; the gate looks at 50. Both are
  // settings, chosen from the first runs (docs/research/2026-11-17-be-058-stage1-load.md), to be
  // chosen again on the reference machine.
  typistSteps: [25, 50, 75, 100, 150],
  gateTypists: 50,
  commitsPerSecond: 3,
  holdMs: 20_000,
  coldDocuments: 10,
  coldParagraphs: 4000,
  connectConcurrency: 50,
  // A stall of the event loop above the 99th-percentile target for acknowledgement (00 §9) would by
  // itself make that target unreachable, so the 99th percentile of the delay may not pass it.
  eventLoopBudgetMs: TARGETS.ackP99Ms,
  drainWaitMs: 90_000,
};

// --- Metrics ------------------------------------------------------------------------------------

export interface Sample {
  labels: Record<string, string>;
  value: number;
}

/** The samples of one family in the Prometheus text format. */
export function metricSamples(text: string, name: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g))
      labels[l[1]!] = l[2]!;
    out.push({ labels, value: Number(m[3]) });
  }
  return out;
}

export const sumOf = (samples: readonly Sample[]): number =>
  samples.reduce((a, s) => a + s.value, 0);

export async function scrape(svc: ServiceHandle, token: string): Promise<string> {
  const res = await fetch(`${svc.url}/metrics`, {
    headers: { Authorization: `Bearer ${token}`, Connection: 'close' },
  });
  if (res.status !== 200) throw new Error(`/metrics answered ${res.status}`);
  return res.text();
}

interface Reading {
  openRooms: number;
  slowConsumers: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  rssMiB: number;
  /** CPU seconds of the service process since it started, and when this was read. */
  cpuSeconds: number;
  at: number;
}

async function reading(svc: ServiceHandle, token: string): Promise<Reading> {
  const text = await scrape(svc, token);
  const loop = metricSamples(text, 'docedit_event_loop_delay_seconds');
  const q = (quantile: string) => loop.find((s) => s.labels['quantile'] === quantile)?.value ?? NaN;
  const rss = metricSamples(text, 'docedit_process_memory_bytes').find(
    (s) => s.labels['kind'] === 'rss',
  );
  return {
    openRooms: sumOf(metricSamples(text, 'dep_open_rooms')),
    slowConsumers: sumOf(metricSamples(text, 'dep_slow_consumers_total')),
    eventLoopP99Ms: round(q('0.99') * 1000, 2),
    eventLoopMaxMs: round(q('1') * 1000, 2),
    rssMiB: round((rss?.value ?? NaN) / 2 ** 20),
    cpuSeconds: sumOf(metricSamples(text, 'docedit_process_cpu_seconds')),
    at: performance.now(),
  };
}

// --- The scenario -------------------------------------------------------------------------------

const ms = (s: Summary) => ({
  n: s.n,
  p50: round(s.p50),
  p95: round(s.p95),
  p99: round(s.p99),
  max: round(s.max),
  mean: round(s.mean),
});

function ackSeq(m: { t: string; d?: Record<string, unknown> } | null): number | null {
  return m?.t === 'sync.ack' && typeof m.d?.['seq'] === 'number' ? (m.d['seq'] as number) : null;
}

interface Conn {
  client: LoadClient;
  doc: string;
  /** The connection that may type on its document. */
  owner: boolean;
  base: number;
}

export interface PhaseChecks {
  ackMedian: boolean;
  ackP99: boolean;
  coldOpenP95: boolean;
  noSlowConsumer: boolean;
  noEarlyClose: boolean;
  allCommitsAcknowledged: boolean;
  eventLoopWithinBudget: boolean;
}

export interface Phase {
  typists: number;
  offeredCommitsPerSecond: number;
  commitsSent: number;
  commitsAcked: number;
  unacked: number;
  commitsPerSecond: number;
  ackMs: ReturnType<typeof ms>;
  cold: { openMs: ReturnType<typeof ms>; failures: number };
  generatorLagP99Ms: number;
  closedEarly: number;
  /** WebSocket close codes and reasons of the clients that were closed in this phase. */
  closeCodes: Record<string, number>;
  slowConsumerCloses: number;
  eventLoop: { p99Ms: number; maxMs: number };
  serviceRssMiB: number;
  /** CPU of the service process over the phase, in percent of one core. */
  serviceCpuPct: number;
  openRooms: number;
  checks: PhaseChecks;
  ok: boolean;
}

export async function stage1(svc: ServiceHandle, s: Stage1Settings) {
  if (s.connections < s.documents) throw new RangeError('a connection is needed for each document');
  if (!s.typistSteps.includes(s.gateTypists))
    throw new RangeError('the gate phase must be one of the typist steps');
  if (Math.max(...s.typistSteps) > s.documents)
    throw new RangeError('a typist needs a document of its own');
  const docs = await mapLimit(Array.from({ length: s.documents }), 8, async () =>
    createDocument(svc, makeContent()),
  );
  const coldContent = makeContent(s.coldParagraphs);
  const cdmBytes = Buffer.byteLength(JSON.stringify(coldContent), 'utf8');
  const coldDocs = await mapLimit(
    Array.from({ length: s.coldDocuments * s.typistSteps.length }),
    4,
    async () => createDocument(svc, coldContent),
  );

  // Ramp up: the first `documents` connections each open a document of their own; the rest watch,
  // round-robin.
  const conns: Conn[] = [];
  const connectOpenMs: number[] = [];
  let connectFailures = 0;
  const rampStart = performance.now();
  await mapLimit(
    Array.from({ length: s.connections }, (_, i) => i),
    s.connectConcurrency,
    async (i) => {
      const doc = docs[i % s.documents]!;
      try {
        const token = await mintToken(svc, `u-${i}`, { [doc]: 'editor' });
        const client = await LoadClient.connect(svc.wsUrl, token);
        const o = await client.open(1, doc);
        if (o.msg?.t !== 'ch.opened') {
          connectFailures++;
          client.terminate();
          return;
        }
        connectOpenMs.push(o.ms);
        conns.push({
          client,
          doc,
          owner: i < s.documents,
          base: typeof o.msg.d?.['head'] === 'number' ? (o.msg.d['head'] as number) : 0,
        });
      } catch {
        connectFailures++;
      }
    },
  );
  const rampMs = performance.now() - rampStart;
  const atPeak = await reading(svc, s.metricsToken);
  const owners = conns.filter((c) => c.owner);

  let lastReading = atPeak;
  const phases: Phase[] = [];
  let saturation: { typists: number; failed: string[] } | null = null;
  let closedSeen = conns.filter((c) => c.client.closed).length;
  let slowSeen = 0;
  let coldNext = 0;
  for (const typistCount of s.typistSteps) {
    const typists = owners.filter((c) => !c.client.closed).slice(0, typistCount);
    const interval = 1000 / s.commitsPerSecond;
    const ackSamples: number[] = [];
    const coldSamples: number[] = [];
    let sent = 0;
    let acked = 0;
    let unacked = 0;
    let coldFailures = 0;
    const lags: number[] = [];
    let expected = performance.now() + 50;
    const lagTimer = setInterval(() => {
      const now = performance.now();
      lags.push(Math.max(0, now - expected));
      expected = now + 50;
    }, 50);
    const start = performance.now();
    const end = start + s.holdMs;
    const typing = Promise.all(
      typists.map(async (t, k) => {
        await sleep((k * interval) / Math.max(1, typists.length)); // spread the starts
        while (performance.now() < end && !t.client.closed) {
          const t0 = performance.now();
          sent++;
          const r = await t.client.submit(1, t.base, 'x', 10_000);
          const seq = ackSeq(r.msg);
          if (seq === null) unacked++;
          else {
            acked++;
            t.base = seq;
            ackSamples.push(r.ms);
          }
          const wait = interval - (performance.now() - t0);
          if (wait > 0) await sleep(wait);
        }
      }),
    );
    // Cold opens, spread over the middle of the phase, one at a time on a new connection.
    const mine = coldDocs.slice(coldNext, coldNext + s.coldDocuments);
    coldNext += s.coldDocuments;
    const cold = (async () => {
      const gap = (s.holdMs * 0.8) / Math.max(1, mine.length);
      await sleep(s.holdMs * 0.1);
      for (const [i, doc] of mine.entries()) {
        const t0 = performance.now();
        try {
          const token = await mintToken(svc, `cold-${coldNext}-${i}`, { [doc]: 'editor' });
          const c = await LoadClient.connect(svc.wsUrl, token);
          const r = await c.open(1, doc);
          if (r.msg?.t === 'ch.opened') coldSamples.push(r.ms);
          else coldFailures++;
          c.close();
        } catch {
          coldFailures++;
        }
        const wait = gap - (performance.now() - t0);
        if (wait > 0) await sleep(wait);
      }
    })();
    await Promise.all([typing, cold]);
    clearInterval(lagTimer);
    const seconds = (performance.now() - start) / 1000;
    const now = await reading(svc, s.metricsToken);

    const closedNow = conns.filter((c) => c.client.closed);
    const closeCodes: Record<string, number> = {};
    for (const c of closedNow.slice(closedSeen)) {
      const k = c.client.socketClose
        ? `${c.client.socketClose.code} ${c.client.socketClose.reason}`.trim()
        : 'unknown';
      closeCodes[k] = (closeCodes[k] ?? 0) + 1;
    }
    const slowNow = conns.reduce(
      (n, c) => n + c.client.channelCloses.filter((x) => x === 'slow_consumer').length,
      0,
    );
    const ack = summarise(ackSamples);
    const open = summarise(coldSamples);
    const checks: PhaseChecks = {
      ackMedian: ack.p50 <= TARGETS.ackP50Ms,
      ackP99: ack.p99 <= TARGETS.ackP99Ms,
      coldOpenP95:
        coldSamples.length > 0 && coldFailures === 0 && open.p95 <= TARGETS.coldOpenP95Ms,
      noSlowConsumer: slowNow - slowSeen === 0 && now.slowConsumers === 0,
      noEarlyClose: closedNow.length - closedSeen === 0,
      allCommitsAcknowledged: unacked === 0 && acked > 0,
      eventLoopWithinBudget: now.eventLoopP99Ms <= s.eventLoopBudgetMs,
    };
    const phase: Phase = {
      typists: typists.length,
      offeredCommitsPerSecond: round(typists.length * s.commitsPerSecond),
      commitsSent: sent,
      commitsAcked: acked,
      unacked,
      commitsPerSecond: round(acked / seconds),
      ackMs: ms(ack),
      cold: { openMs: ms(open), failures: coldFailures },
      generatorLagP99Ms: round(
        percentile(
          [...lags].sort((a, b) => a - b),
          99,
        ),
      ),
      closedEarly: closedNow.length - closedSeen,
      closeCodes,
      slowConsumerCloses: slowNow - slowSeen,
      eventLoop: { p99Ms: now.eventLoopP99Ms, maxMs: now.eventLoopMaxMs },
      serviceRssMiB: now.rssMiB,
      serviceCpuPct: round(
        ((now.cpuSeconds - lastReading.cpuSeconds) / ((now.at - lastReading.at) / 1000)) * 100,
      ),
      openRooms: now.openRooms,
      checks,
      ok: Object.values(checks).every(Boolean),
    };
    closedSeen = closedNow.length;
    slowSeen = slowNow;
    lastReading = now;
    phases.push(phase);
    if (!phase.ok && !saturation)
      saturation = {
        typists: phase.typists,
        failed: Object.entries(checks)
          .filter(([, v]) => !v)
          .map(([k]) => k),
      };
    // A node that lost clients or commits is not measured further: the next phase would start
    // from a damaged state.
    if (phase.closedEarly > 0 || phase.unacked > 0) break;
  }

  // Everyone leaves; the rooms must go.
  const atEnd = await reading(svc, s.metricsToken);
  for (const c of conns) c.client.close();
  const leaveAt = performance.now();
  let openRoomsAfter = atEnd.openRooms;
  let roomsGoneMs: number | null = null;
  while (performance.now() - leaveAt < s.drainWaitMs) {
    openRoomsAfter = (await reading(svc, s.metricsToken)).openRooms;
    if (openRoomsAfter === 0) {
      roomsGoneMs = performance.now() - leaveAt;
      break;
    }
    await sleep(1000);
  }
  const final = await reading(svc, s.metricsToken);

  const gatePhase = phases.find((p) => p.typists === s.gateTypists) ?? null;
  const checks = {
    gatePhaseReached: gatePhase !== null,
    ackMedian: gatePhase?.checks.ackMedian ?? false,
    ackP99: gatePhase?.checks.ackP99 ?? false,
    coldOpenP95: gatePhase?.checks.coldOpenP95 ?? false,
    coldOpenDocumentUnder1MB: cdmBytes < TARGETS.coldOpenMaxCdmBytes,
    noSlowConsumer: phases.every((p) => p.checks.noSlowConsumer) && final.slowConsumers === 0,
    noEarlyClose: gatePhase !== null && phases.every((p) => p.checks.noEarlyClose),
    allCommitsAcknowledged: gatePhase !== null && gatePhase.checks.allCommitsAcknowledged,
    allConnected: connectFailures === 0 && conns.length === s.connections,
    roomsReturnToZero: roomsGoneMs !== null,
    eventLoopWithinBudget: gatePhase?.checks.eventLoopWithinBudget ?? false,
  };
  const nan = { n: 0, p50: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN };
  return {
    settings: s,
    rampUpMs: round(rampMs),
    connected: conns.length,
    connectFailures,
    connectOpenMs: ms(summarise(connectOpenMs)),
    atPeak,
    cdmBytes,
    phases,
    /** The first phase that failed a check, or null. */
    saturation,
    gateTypists: s.gateTypists,
    // The gate phase, at the top level, for the gate and for reading.
    ackMs: gatePhase?.ackMs ?? nan,
    cold: gatePhase
      ? { cdmBytes, openMs: gatePhase.cold.openMs, failures: gatePhase.cold.failures }
      : { cdmBytes, openMs: nan, failures: 0 },
    eventLoop: {
      budgetP99Ms: s.eventLoopBudgetMs,
      p99Ms: gatePhase?.eventLoop.p99Ms ?? NaN,
      maxMs: gatePhase?.eventLoop.maxMs ?? NaN,
    },
    openRoomsAtEnd: atEnd.openRooms,
    openRoomsAfterLeave: openRoomsAfter,
    roomsGoneMs: roomsGoneMs === null ? null : round(roomsGoneMs),
    serviceRssMiB: { atPeak: atPeak.rssMiB, atEnd: atEnd.rssMiB, afterLeave: final.rssMiB },
    targets: {
      ackP50Ms: TARGETS.ackP50Ms,
      ackP99Ms: TARGETS.ackP99Ms,
      coldOpenP95Ms: TARGETS.coldOpenP95Ms,
      stage1Connections: TARGETS.stage1Connections,
      stage1Documents: TARGETS.stage1Documents,
    },
    checks,
    met: Object.values(checks).every(Boolean),
  };
}

export type Stage1Result = Awaited<ReturnType<typeof stage1>>;

// --- The gate -----------------------------------------------------------------------------------

export interface GateSettings {
  /** A value may be this much above the baseline, in percent, before it is a regression. */
  tolerancePct: number;
  /** A value may always be this many milliseconds above the baseline: below it, it is noise. */
  floorMs: number;
}

export const GATE_DEFAULTS: GateSettings = { tolerancePct: 50, floorMs: 10 };

export interface GateResult {
  ok: boolean;
  failures: string[];
}

/**
 * Compares a run with a baseline run of the same harness. The gate fails when a hard check of the
 * run fails (a slow consumer, a client closed, rooms that stay open, a connection or commit lost,
 * an event loop over its budget), or when a latency of the gate phase is above the baseline by more
 * than the tolerance and the floor. The figures of 00 §9 are not the gate: a run on a machine that
 * misses them still passes as long as it does not get worse than its own baseline.
 */
export function gate(
  run: Pick<Stage1Result, 'checks' | 'ackMs' | 'cold' | 'eventLoop'>,
  baseline: Pick<Stage1Result, 'ackMs' | 'cold' | 'eventLoop'>,
  g: GateSettings = GATE_DEFAULTS,
): GateResult {
  const failures: string[] = [];
  const hard: Array<keyof Stage1Result['checks']> = [
    'gatePhaseReached',
    'noSlowConsumer',
    'noEarlyClose',
    'allCommitsAcknowledged',
    'allConnected',
    'roomsReturnToZero',
    'eventLoopWithinBudget',
    'coldOpenDocumentUnder1MB',
  ];
  for (const k of hard) if (!run.checks[k]) failures.push(`${k} failed`);
  const compare = (name: string, now: number, before: number) => {
    if (!Number.isFinite(now)) failures.push(`${name} was not measured`);
    else if (Number.isFinite(before) && now > before * (1 + g.tolerancePct / 100) + g.floorMs)
      failures.push(
        `${name} ${now} ms is above the baseline ${before} ms by more than ${g.tolerancePct} % and ${g.floorMs} ms`,
      );
  };
  compare('ack median', run.ackMs.p50, baseline.ackMs.p50);
  compare('ack 99th percentile', run.ackMs.p99, baseline.ackMs.p99);
  compare('cold open 95th percentile', run.cold.openMs.p95, baseline.cold.openMs.p95);
  compare('event loop 99th percentile', run.eventLoop.p99Ms, baseline.eventLoop.p99Ms);
  return { ok: failures.length === 0, failures };
}
