/**
 * A flooding tenant on its own thread (SEC-018 criterion 2). The flood's client work (sending, and
 * reading tens of thousands of refusals) must not run on the event loop of the service under test
 * or of the client that is being timed, so it runs in a `node:worker_threads` worker.
 *
 * `workerData`: the service's WebSocket address, the tenant's origin, one token for each connection,
 * the documents to open (one for each channel, and one more for the open beyond the channel
 * limit), and a commit position. The worker connects, opens, posts `ready`, floods commits until it
 * is told `stop`, and posts what it saw.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { uuid7 } from '@docedit/model';
import { WireClient } from './wire.ts';

interface FloodInput {
  wsUrl: string;
  origin: string;
  tokens: string[];
  docs: string[];
  channels: number;
  pos: number;
  seq: number;
}

export interface FloodReport {
  /** The answer code of the open beyond the channel limit, for each connection. */
  beyondChannelLimit: string[];
  sent: number;
  rateLimited: number;
  /** Whether every `rate_limited` answer said when to try again. */
  allSayRetryAfter: boolean;
  /** Times a connection of the flood was closed by the service and opened again. */
  reconnects: number;
}

const input = workerData as FloodInput;
const port = parentPort!;

const clients: WireClient[] = [];
const beyondChannelLimit: string[] = [];
for (const token of input.tokens) {
  const c = await WireClient.connect(input.wsUrl, { origin: input.origin });
  clients.push(c);
  await c.hello(token);
  for (let ch = 1; ch <= input.channels; ch++) await c.open(ch, input.docs[ch - 1]!);
  const extra = await c.open(input.channels + 1, input.docs[input.channels]!);
  beyondChannelLimit.push(String(extra.d?.['code']));
}

let flooding = true;
port.on('message', (m) => {
  if (m === 'stop') flooding = false;
});
port.postMessage('ready');

let sent = 0;
let reconnects = 0;
// The worker stops by itself after 40 seconds, so that a starved parent cannot leave it flooding.
const deadline = Date.now() + 40_000;
while (flooding && Date.now() < deadline) {
  // The service closes a connection after too many refusals in a row; the flood comes back.
  for (let i = 0; i < clients.length; i++) {
    if (clients[i]!.closeInfo === null) continue;
    reconnects++;
    try {
      const c = await WireClient.connect(input.wsUrl, { origin: input.origin });
      await c.hello(input.tokens[i]!);
      for (let ch = 1; ch <= input.channels; ch++) await c.open(ch, input.docs[ch - 1]!);
      clients[i]!.terminate();
      clients[i] = c;
    } catch {
      // Refused for now (a limit, or the upgrade); tried again on the next round.
    }
  }
  for (const c of clients)
    for (let k = 0; k < 20; k++) {
      if (c.closeInfo !== null) break;
      sent++;
      c.send({
        t: 'sync.submit',
        id: c.nextId(),
        ch: 1 + (k % input.channels),
        d: {
          id: uuid7(),
          base: input.seq,
          steps: [
            {
              stepType: 'replace',
              from: input.pos,
              to: input.pos,
              slice: { content: [{ type: 'text', text: 'a' }] },
            },
          ],
        },
      });
    }
  await new Promise((resolve) => setTimeout(resolve, 5));
}
await new Promise((resolve) => setTimeout(resolve, 300));

const refusals = clients.flatMap((c) =>
  c.log.filter((m) => (m.d as { code?: string } | undefined)?.code === 'rate_limited'),
);
const report: FloodReport = {
  beyondChannelLimit,
  sent,
  rateLimited: refusals.length,
  allSayRetryAfter: refusals.every(
    (m) => typeof (m.d as { retryAfterMs?: unknown }).retryAfterMs === 'number',
  ),
  reconnects,
};
for (const c of clients) c.terminate();
port.postMessage(report);
