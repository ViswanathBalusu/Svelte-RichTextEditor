/**
 * Attackers that send expensive commits, on their own thread (SEC-028 criterion 1). Their client
 * work (building, chunking and sending megabytes of JSON) must not run on the event loop of the
 * service under test or of the clients being timed, so it runs in a `node:worker_threads` worker.
 *
 * `workerData`: the service's WebSocket address and one entry for each attacker: its origin, token,
 * document, the features to announce and the steps of its commit. Each attacker has its own
 * connection and channel. It sends its commit, waits for the answer and sends it again with a new
 * identifier, until the worker is told `stop`. A commit above the frame size goes as chunks
 * (05 §4), as the component would send it.
 *
 * - `stale: false`: the base follows the head, so the commit is judged against the current document.
 * - `stale: true`: the base stays where it was for as long as the service accepts it, so the commit
 *   is rebased over everything stored since; when it is refused, the base moves to the head named
 *   in the refusal and falls behind again.
 * - `freshIds`: a marker in the steps that is replaced by new characters in each commit, so that
 *   inserted nodes do not repeat an identifier and the commit is judged in full each time.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { uuid7 } from '@docedit/model';
import { chunkMessage } from '@docedit/protocol';
import { WireClient } from './wire.ts';

export interface Attacker {
  name: string;
  origin: string;
  token: string;
  doc: string;
  features: string[];
  seq: number;
  steps: unknown[];
  stale: boolean;
  freshIds?: string;
}

export interface AttackInput {
  wsUrl: string;
  maxFrame: number;
  attackers: Attacker[];
}

export interface AttackerReport {
  name: string;
  /** Bytes of one commit of this attacker, as sent. */
  bytes: number;
  sent: number;
  /** Answers by `ack` or the rejection code; `closed` when the connection was closed. */
  answers: Record<string, number>;
  /** The longest time one commit took to be answered, in milliseconds. */
  slowestMs: number;
}

const input = workerData as AttackInput;
const port = parentPort!;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

let attacking = true;
port.on('message', (m) => {
  if (m === 'stop') attacking = false;
});
// The worker stops by itself after 90 seconds, so that a starved parent cannot leave it running.
const deadline = Date.now() + 90_000;

async function connect(a: Attacker): Promise<WireClient> {
  const c = await WireClient.connect(input.wsUrl, { origin: a.origin });
  const welcome = await c.hello(a.token, { features: a.features });
  if (welcome.t !== 'welcome') throw new Error(`${a.name}: ${JSON.stringify(welcome.d)}`);
  const opened = await c.open(1, a.doc, { features: a.features });
  if (opened.t !== 'ch.opened') throw new Error(`${a.name}: ${JSON.stringify(opened.d)}`);
  return c;
}

async function run(a: Attacker, ready: () => void): Promise<AttackerReport> {
  const report: AttackerReport = { name: a.name, bytes: 0, sent: 0, answers: {}, slowestMs: 0 };
  const count = (k: string) => (report.answers[k] = (report.answers[k] ?? 0) + 1);
  const template = JSON.stringify(a.steps);
  let c = await connect(a);
  ready();
  let base = a.seq;
  while (attacking && Date.now() < deadline) {
    if (c.closeInfo !== null) {
      count('closed');
      c.terminate();
      c = await connect(a);
    }
    let steps = template;
    if (a.freshIds) {
      let fresh = '';
      for (let i = 0; i < a.freshIds.length; i++)
        fresh += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      steps = steps.replaceAll(a.freshIds, fresh);
    }
    const id = c.nextId();
    const text = `{"t":"sync.submit","id":${JSON.stringify(id)},"ch":1,"d":{"id":"${uuid7()}","base":${base},"steps":${steps}}}`;
    report.bytes = Buffer.byteLength(text, 'utf8');
    const t0 = performance.now();
    if (report.bytes <= input.maxFrame) c.sendRaw(text);
    else for (const frame of chunkMessage(text, input.maxFrame, uuid7())) c.sendRaw(frame);
    report.sent++;
    try {
      const r = await c.take((m) => m.re === id, 60_000, `answer to ${a.name}`);
      report.slowestMs = Math.max(report.slowestMs, performance.now() - t0);
      const d = (r.d ?? {}) as {
        seq?: number;
        head?: number;
        code?: string;
        retryAfterMs?: number;
      };
      if (r.t === 'sync.ack') {
        count('ack');
        if (!a.stale && typeof d.seq === 'number') base = d.seq;
      } else {
        count(String(d.code));
        if (typeof d.head === 'number') base = d.head;
        if (typeof d.retryAfterMs === 'number')
          await new Promise((done) => setTimeout(done, Math.min(d.retryAfterMs!, 1000)));
      }
    } catch {
      count('closed');
    }
  }
  c.terminate();
  return report;
}

let waiting = input.attackers.length;
const reports = input.attackers.map((a) =>
  run(a, () => {
    if (--waiting === 0) port.postMessage('ready');
  }),
);
port.postMessage(await Promise.all(reports));
