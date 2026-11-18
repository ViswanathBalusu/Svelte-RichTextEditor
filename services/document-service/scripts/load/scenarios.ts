/**
 * The scenarios of the FND-009 harness: commit acknowledgement latency, cold open of a room, a
 * ramp of connections and open documents that reports where one node saturates, and the three
 * faults of the phase 1b exit criteria (11 §4): dropped connections, a killed process and a
 * database outage.
 *
 * Targets (00 §9; 06 §6) are targets, not measurements: a result says what was measured, with the
 * workload settings it ran under, and whether the target was met in that run.
 */
import { uuid7 } from '@docedit/model';
import {
  LoadClient,
  createDocument,
  makeContent,
  mapLimit,
  mintToken,
  percentile,
  rest,
  round,
  sleep,
  startServiceProcess,
  summarise,
  insertAtIntro,
  type ServiceHandle,
  type ServiceOptions,
  type Summary,
} from './lib.ts';

/** The latency and capacity targets the harness reports against (00 §9; 06 §6). */
export const TARGETS = {
  ackP50Ms: 50,
  ackP99Ms: 300,
  coldOpenP95Ms: 500,
  coldOpenMaxCdmBytes: 1_000_000,
  exportP95Ms: 10_000,
  stage1Connections: 2_000,
  stage1Documents: 500,
} as const;

const ms = (s: Summary) => ({
  n: s.n,
  p50: round(s.p50),
  p95: round(s.p95),
  p99: round(s.p99),
  max: round(s.max),
  mean: round(s.mean),
});

/** The sequence number of an acknowledgement, or null. */
function ackSeq(m: { t: string; d?: Record<string, unknown> } | null): number | null {
  return m?.t === 'sync.ack' && typeof m.d?.['seq'] === 'number' ? (m.d['seq'] as number) : null;
}

// --- Commit acknowledgement latency (criterion 1) -----------------------------------------------

export interface AckLatencySettings {
  /** Writers in parallel, each on a document of its own, each with one commit in flight. */
  writers: number;
  commitsPerWriter: number;
  /** Commits per writer that are sent but not counted. */
  warmup: number;
  /** Pause between a writer's commits, from one acknowledgement to the next send; 0: back to back. */
  intervalMs?: number;
}

export async function ackLatency(svc: ServiceHandle, s: AckLatencySettings) {
  const docs = await mapLimit(Array.from({ length: s.writers }), 8, async () =>
    createDocument(svc, makeContent()),
  );
  const clients = await mapLimit(docs, 16, async (doc, i) => {
    const token = await mintToken(svc, `writer-${i}`, { [doc]: 'editor' });
    const c = await LoadClient.connect(svc.wsUrl, token);
    const o = await c.open(1, doc);
    if (o.msg?.t !== 'ch.opened') throw new Error(`open answered ${o.msg?.t}`);
    return c;
  });
  const samples: number[] = [];
  let failures = 0;
  const started = performance.now();
  await Promise.all(
    clients.map(async (c) => {
      let base = 0;
      for (let i = 0; i < s.warmup + s.commitsPerWriter; i++) {
        const r = await c.submit(1, base, 'x');
        const seq = ackSeq(r.msg);
        if (seq === null) {
          failures++;
          return;
        }
        base = seq;
        if (i >= s.warmup) samples.push(r.ms);
        if (s.intervalMs) await sleep(s.intervalMs);
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  for (const c of clients) c.close();
  const summary = summarise(samples);
  return {
    settings: s,
    ackMs: ms(summary),
    commitsPerSecond: round((s.writers * (s.warmup + s.commitsPerWriter)) / seconds),
    failures,
    target: { p50Ms: TARGETS.ackP50Ms, p99Ms: TARGETS.ackP99Ms },
    met: failures === 0 && summary.p50 <= TARGETS.ackP50Ms && summary.p99 <= TARGETS.ackP99Ms,
  };
}

// --- Cold open of a room (criterion 2) ----------------------------------------------------------

export interface ColdOpenSettings {
  documents: number;
  /** Paragraphs after the first, each of about 60 characters of text. */
  paragraphs: number;
}

export async function coldOpen(svc: ServiceHandle, s: ColdOpenSettings) {
  const content = makeContent(s.paragraphs);
  const cdmBytes = Buffer.byteLength(JSON.stringify(content), 'utf8');
  const docs = await mapLimit(Array.from({ length: s.documents }), 4, async () =>
    createDocument(svc, content),
  );
  const samples: number[] = [];
  let failures = 0;
  // One at a time, so that no other room is being opened: the node is otherwise idle.
  for (const [i, doc] of docs.entries()) {
    const token = await mintToken(svc, `reader-${i}`, { [doc]: 'editor' });
    const c = await LoadClient.connect(svc.wsUrl, token);
    const r = await c.open(1, doc);
    if (r.msg?.t === 'ch.opened') samples.push(r.ms);
    else failures++;
    c.close();
  }
  const summary = summarise(samples);
  return {
    settings: s,
    cdmBytes,
    openMs: ms(summary),
    failures,
    target: { p95Ms: TARGETS.coldOpenP95Ms, cdmBytesBelow: TARGETS.coldOpenMaxCdmBytes },
    met:
      failures === 0 &&
      cdmBytes < TARGETS.coldOpenMaxCdmBytes &&
      summary.p95 <= TARGETS.coldOpenP95Ms,
  };
}

// --- A ramp of connections and open documents (criterion 4) -------------------------------------

export interface RampSettings {
  /** Steps of the ramp: connections and open documents, each at least the one before. */
  steps: ReadonlyArray<{ connections: number; documents: number }>;
  /** How long each step runs its workload. */
  holdMs: number;
  /** Each document has one writer; it sends a commit this often. */
  commitIntervalMs: number;
  /** Connections opened at once. */
  connectConcurrency: number;
}

export interface RampStep {
  connections: number;
  documents: number;
  connectFailures: number;
  openMs: ReturnType<typeof ms>;
  commitsSent: number;
  commitsAcked: number;
  timeouts: number;
  commitsPerSecond: number;
  ackMs: ReturnType<typeof ms>;
  /** How far behind schedule the load generator's own timer ran (its p99): high means the generator, not the node, is slow. */
  generatorLagP99Ms: number;
  saturated: boolean;
  reason: string | null;
}

export async function ramp(svc: ServiceHandle, s: RampSettings) {
  const maxDocs = Math.max(...s.steps.map((x) => x.documents));
  const docs = await mapLimit(Array.from({ length: maxDocs }), 8, async () =>
    createDocument(svc, makeContent()),
  );
  interface Conn {
    client: LoadClient;
    doc: string;
    writer: boolean;
    base: number;
  }
  const conns: Conn[] = [];
  const results: RampStep[] = [];
  let openDocs = 0;
  let saturatedAt: { connections: number; reason: string } | null = null;
  for (const [stepIndex, step] of s.steps.entries()) {
    const openSamples: number[] = [];
    let connectFailures = 0;
    const toAdd = step.connections - conns.length;
    const wanted = Array.from({ length: Math.max(0, toAdd) }, (_, k) => conns.length + k);
    const newDocs = Math.max(0, step.documents - openDocs);
    await mapLimit(wanted, s.connectConcurrency, async (index) => {
      // The first connections of a step open the documents new to it, one writer each; the rest
      // read, round-robin over every document open in this step.
      const k = index - wanted[0]!;
      const writer = k < newDocs;
      const doc = writer ? docs[openDocs + k]! : docs[index % step.documents]!;
      try {
        const token = await mintToken(svc, `u-${index}`, { [doc]: 'editor' });
        const client = await LoadClient.connect(svc.wsUrl, token);
        const o = await client.open(1, doc);
        if (o.msg?.t !== 'ch.opened') {
          connectFailures++;
          client.terminate();
          return;
        }
        openSamples.push(o.ms);
        conns.push({
          client,
          doc,
          writer,
          base: typeof o.msg.d?.['head'] === 'number' ? (o.msg.d['head'] as number) : 0,
        });
      } catch {
        connectFailures++;
      }
    });
    openDocs = Math.max(openDocs, step.documents);
    // The workload: every writer commits on its interval for `holdMs`.
    const lags: number[] = [];
    let expected = performance.now() + 50;
    const lagTimer = setInterval(() => {
      const now = performance.now();
      lags.push(Math.max(0, now - expected));
      expected = now + 50;
    }, 50);
    const samples: number[] = [];
    let sent = 0;
    let acked = 0;
    let timeouts = 0;
    const end = performance.now() + s.holdMs;
    const writers = conns.filter((c) => c.writer && !c.client.closed);
    await Promise.all(
      writers.map(async (w, k) => {
        await sleep((k * s.commitIntervalMs) / Math.max(1, writers.length)); // spread the start
        while (performance.now() < end && !w.client.closed) {
          const t0 = performance.now();
          sent++;
          const r = await w.client.submit(1, w.base, 'x', 10_000);
          const seq = ackSeq(r.msg);
          if (seq === null) timeouts++;
          else {
            acked++;
            w.base = seq;
            samples.push(r.ms);
          }
          const wait = s.commitIntervalMs - (performance.now() - t0);
          if (wait > 0) await sleep(wait);
        }
      }),
    );
    clearInterval(lagTimer);
    const seconds = s.holdMs / 1000;
    const ack = summarise(samples);
    let reason: string | null = null;
    if (connectFailures > 0) reason = `${connectFailures} connections or opens failed`;
    else if (timeouts > 0) reason = `${timeouts} commits were not acknowledged in 10 s`;
    else if (ack.p99 > TARGETS.ackP99Ms)
      reason = `ack p99 ${round(ack.p99)} ms is above the target`;
    const saturated = reason !== null;
    if (saturated && !saturatedAt) saturatedAt = { connections: step.connections, reason: reason! };
    results.push({
      connections: conns.length,
      documents: step.documents,
      connectFailures,
      openMs: ms(summarise(openSamples)),
      commitsSent: sent,
      commitsAcked: acked,
      timeouts,
      commitsPerSecond: round(acked / seconds),
      ackMs: ms(ack),
      generatorLagP99Ms: round(
        percentile(
          [...lags].sort((a, b) => a - b),
          99,
        ),
      ),
      saturated,
      reason,
    });
    if (saturated && stepIndex < s.steps.length - 1 && connectFailures > 0) break;
  }
  for (const c of conns) c.client.close();
  const top = results[results.length - 1];
  return {
    settings: s,
    steps: results,
    saturation: saturatedAt,
    reachedConnections: top?.connections ?? 0,
    reachedStage1:
      (top?.connections ?? 0) >= TARGETS.stage1Connections &&
      (top?.documents ?? 0) >= TARGETS.stage1Documents,
  };
}

// --- Faults (criterion 5) -----------------------------------------------------------------------

/** The text of every commit in a document, joined; the writers' inserts are single words. */
async function contentText(
  svc: ServiceHandle,
  doc: string,
): Promise<{ text: string; seq: number }> {
  const r = await rest(svc, 'GET', `/documents/${doc}/content`);
  if (r.status !== 200) throw new Error(`content answered ${r.status}: ${JSON.stringify(r.json)}`);
  const texts: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const o = n as { text?: unknown; content?: unknown[] };
    if (typeof o.text === 'string') texts.push(o.text);
    o.content?.forEach(walk);
  };
  walk(r.json['doc']);
  return { text: texts.join(''), seq: r.json['seq'] as number };
}

const count = (haystack: string, needle: string): number =>
  needle ? haystack.split(needle).length - 1 : 0;

/**
 * Connections dropped while commits are in flight. Every writer commits, then every socket is
 * terminated at once with one commit unanswered. The writers reconnect, resume their channel, and
 * send the unanswered commit again with the same identifier. Nothing acknowledged may be missing
 * and nothing may be applied twice.
 */
export async function dropConnections(svc: ServiceHandle, s: { writers: number; commits: number }) {
  const docs = await mapLimit(Array.from({ length: s.writers }), 8, async () =>
    createDocument(svc, makeContent()),
  );
  const writers = await mapLimit(docs, 16, async (doc, i) => {
    const token = await mintToken(svc, `w-${i}`, { [doc]: 'editor' });
    const client = await LoadClient.connect(svc.wsUrl, token);
    const o = await client.open(1, doc);
    if (o.msg?.t !== 'ch.opened') throw new Error('open failed');
    return {
      client,
      doc,
      i,
      base: 0,
      acked: [] as string[],
      view: o.msg.d?.['view'],
      inc: o.msg.d?.['incarnation'],
    };
  });
  await Promise.all(
    writers.map(async (w) => {
      for (let k = 0; k < s.commits; k++) {
        const word = `<a${w.i}-${k}>`;
        const r = await w.client.submit(1, w.base, word);
        const seq = ackSeq(r.msg);
        if (seq === null) throw new Error('a commit before the drop was not acknowledged');
        w.base = seq;
        w.acked.push(word);
      }
    }),
  );
  // One commit per writer is in flight when the sockets go.
  const inflight = writers.map((w) => ({
    id: uuid7(),
    word: `<f${w.i}>`,
    base: w.base,
  }));
  for (const [k, w] of writers.entries()) {
    const f = inflight[k]!;
    w.client.ws.send(
      JSON.stringify({
        t: 'sync.submit',
        id: `inflight-${k}`,
        ch: 1,
        d: { id: f.id, base: f.base, steps: [insertAtIntro(f.word)], origin: 'input' },
      }),
    );
  }
  for (const w of writers) w.client.terminate();
  const sockets = writers.length;
  // Reconnect, resume, send the unanswered commit again.
  let resumed = 0;
  let resent = 0;
  await mapLimit(writers, 16, async (w, k) => {
    const token = await mintToken(svc, `w-${w.i}`, { [w.doc]: 'editor' });
    const client = await LoadClient.connect(svc.wsUrl, token);
    const o = await client.open(1, w.doc, {
      seq: w.base,
      incarnation: w.inc,
      view: w.view,
    });
    if (o.msg?.t === 'ch.opened') resumed++;
    const f = inflight[k]!;
    const head = typeof o.msg?.d?.['head'] === 'number' ? (o.msg.d['head'] as number) : w.base;
    const r = await client.request('sync.submit', 1, {
      id: f.id,
      base: head,
      steps: [insertAtIntro(f.word)],
      origin: 'input',
    });
    if (ackSeq(r.msg) !== null) {
      resent++;
      w.acked.push(f.word);
    }
    client.close();
  });
  let missing = 0;
  let duplicated = 0;
  for (const w of writers) {
    const { text } = await contentText(svc, w.doc);
    for (const word of w.acked) {
      const n = count(text, word);
      if (n === 0) missing++;
      if (n > 1) duplicated++;
    }
  }
  return {
    settings: s,
    socketsDropped: sockets,
    resumed,
    inflightResent: resent,
    acknowledgedMissing: missing,
    appliedTwice: duplicated,
    ok: missing === 0 && duplicated === 0 && resumed === sockets && resent === sockets,
  };
}

/**
 * A killed process. The service runs on PostgreSQL; its process is ended with SIGKILL after a run
 * of acknowledged commits, started again on the same database, and every acknowledged commit must
 * be there. `svc` is replaced by the restarted process in the result's `restarted` field.
 */
export async function killProcess(
  svc: ServiceHandle,
  startOptions: ServiceOptions,
  s: { documents: number; commits: number },
) {
  const docs = await mapLimit(Array.from({ length: s.documents }), 4, async () =>
    createDocument(svc, makeContent()),
  );
  const acked = new Map<string, string[]>();
  await mapLimit(docs, 8, async (doc, i) => {
    const token = await mintToken(svc, `k-${i}`, { [doc]: 'editor' });
    const c = await LoadClient.connect(svc.wsUrl, token);
    await c.open(1, doc);
    let base = 0;
    const words: string[] = [];
    for (let k = 0; k < s.commits; k++) {
      const word = `<k${i}-${k}>`;
      const r = await c.submit(1, base, word);
      const seq = ackSeq(r.msg);
      if (seq === null) throw new Error('a commit before the kill was not acknowledged');
      base = seq;
      words.push(word);
    }
    acked.set(doc, words);
    c.terminate();
  });
  await svc.kill();
  const t0 = performance.now();
  const restarted = await startServiceProcess({ ...startOptions, tenant: svc.seed });
  const restartMs = performance.now() - t0;
  let missing = 0;
  for (const [doc, words] of acked) {
    const { text } = await contentText(restarted, doc);
    for (const w of words) if (count(text, w) !== 1) missing++;
  }
  // The restarted service takes writes again once the dead process's ownership has lapsed
  // (06 §2.1): try until a commit is acknowledged, for at most 60 s from the restart.
  const doc = docs[0]!;
  let writeAgainMs: number | null = null;
  while (performance.now() - t0 < 60_000 && writeAgainMs === null) {
    try {
      const token = await mintToken(restarted, 'k-after', { [doc]: 'editor' });
      const c = await LoadClient.connect(restarted.wsUrl, token);
      const o = await c.open(1, doc);
      const head = typeof o.msg?.d?.['head'] === 'number' ? (o.msg.d['head'] as number) : 0;
      if (o.msg?.t === 'ch.opened' && ackSeq((await c.submit(1, head, '<after>')).msg) !== null)
        writeAgainMs = performance.now() - t0;
      c.close();
    } catch {
      // Not yet: the service answers errors while it recovers.
    }
    if (writeAgainMs === null) await sleep(500);
  }
  return {
    settings: s,
    restarted,
    restartToListeningMs: round(restartMs),
    acknowledgedMissing: missing,
    writeAgainMs: writeAgainMs === null ? null : round(writeAgainMs),
    ok: missing === 0 && writeAgainMs !== null,
  };
}

/**
 * A database outage as the service's own test hook makes it (BE-079: every write fails as if the
 * database were away; the service must be in test mode). While it lasts nothing is acknowledged;
 * afterwards a new connection commits again, and the document holds what was acknowledged and
 * nothing that was refused.
 */
export async function databaseOutage(svc: ServiceHandle, s: { outageMs: number }) {
  const doc = await createDocument(svc, makeContent());
  const token = await mintToken(svc, 'db-1', { [doc]: 'editor' });
  const c = await LoadClient.connect(svc.wsUrl, token);
  await c.open(1, doc);
  const before = ackSeq((await c.submit(1, 0, '<before>')).msg);
  await rest(svc, 'POST', '/database', { down: true }, '/_test');
  const during = await c.submit(1, before ?? 0, '<during>', 3000);
  const duringAcked = ackSeq(during.msg) !== null;
  await sleep(s.outageMs);
  await rest(svc, 'POST', '/database', { down: false }, '/_test');
  c.terminate();
  // A new connection after the outage.
  const token2 = await mintToken(svc, 'db-2', { [doc]: 'editor' });
  const c2 = await LoadClient.connect(svc.wsUrl, token2);
  const o = await c2.open(1, doc);
  const head = typeof o.msg?.d?.['head'] === 'number' ? (o.msg.d['head'] as number) : 0;
  const afterAck = ackSeq((await c2.submit(1, head, '<after>')).msg);
  c2.close();
  const { text } = await contentText(svc, doc);
  const out = {
    settings: s,
    ackedBefore: before !== null,
    ackedDuringOutage: duringAcked,
    ackedAfter: afterAck !== null,
    hasBefore: count(text, '<before>') === 1,
    hasAfter: count(text, '<after>') === 1,
    // A refused commit is not in the document; a commit whose outcome the client never learned
    // may or may not be (it is then the client's to send again by its identifier).
    refusedAppliedAnyway: !duringAcked && count(text, '<during>') > 0,
  };
  return {
    ...out,
    ok:
      out.ackedBefore &&
      !out.ackedDuringOutage &&
      out.ackedAfter &&
      out.hasBefore &&
      out.hasAfter &&
      !out.refusedAppliedAnyway,
  };
}
