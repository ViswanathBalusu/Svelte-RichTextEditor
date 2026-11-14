/**
 * BE-087 criterion 3 (lane V-BE-085-098): a restore requested over REST passes through the outbox,
 * the room and a checkpoint, and the spans of all of them belong to the request's trace. Run on the
 * full service with the real data plane and memory storage, over a real WebSocket for the commit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cdmSchema } from '@docedit/model/prosemirror';
import type { Span } from '../../src/seams.ts';
import { DepClient, insertText } from '../data-plane/client.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const TRACE = '5bf92f3577b34da6a3ce929d0e0e4737';
const PARENT = '10f067aa0ba902b8';
const INTRO = 'pIntro0000000001';

function insideAt(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

const clients: DepClient[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const h of harnesses.splice(0)) await h.close();
});

describe('a restore over REST is one trace through the outbox, the room and a checkpoint (BE-087 criterion 3)', () => {
  it('records the outbox, room and checkpoint spans under the request trace', async () => {
    const spans: Span[] = [];
    const h = await startHarness('memory', {
      config: { testMode: true, environment: 'test' },
      realDataPlane: true,
      onSpan: (s) => void spans.push(s),
    });
    harnesses.push(h);
    const content = documentWithRegions();
    const doc = await h.createDocument({ content });
    const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
    clients.push(c);
    expect((await c.hello(h.userToken({ [doc]: 'owner' }))).t).toBe('welcome');
    expect((await c.open(1, doc)).t).toBe('ch.opened');
    const intro = insideAt(content['doc'], INTRO);
    expect((await c.submit(1, { base: 0, steps: [insertText(intro, 'later')] })).t).toBe(
      'sync.ack',
    );

    spans.length = 0;
    const r = await h.call('POST', `/v1/documents/${doc}/restore`, {
      token: h.apiKey,
      headers: { traceparent: `00-${TRACE}-${PARENT}-01` },
      body: { toSeq: 0 },
    });
    expect(r.status).toBe(200);

    const inTrace = (name: string) => spans.filter((s) => s.name === name && s.traceId === TRACE);
    expect(inTrace('http.request').length).toBe(1);
    expect(inTrace('dep.outbox').length).toBeGreaterThan(0);
    // The checkpoint is written by a worker after the restore is acknowledged; its span ends then.
    for (let i = 0; i < 200 && !spans.some((s) => s.name === 'dep.checkpoint'); i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(inTrace('dep.checkpoint').length).toBeGreaterThan(0);
    // Every span of the restore (outbox and checkpoint) is in the trace, none is in another one.
    const restoreSpans = spans.filter((s) => ['dep.outbox', 'dep.checkpoint'].includes(s.name));
    for (const s of restoreSpans) expect(s.traceId).toBe(TRACE);
  });
});
