/**
 * Traces from a `hello` through the session, the channel and the commits (BE-087 criterion 2;
 * 06 §11; 05 §5.1 `hello.traceparent`). The real data plane runs over the in-memory stores and
 * records its spans through `settings.onSpan`; a span is recorded when it ends, so the test closes
 * the client before it reads the session and channel spans. The REST trace (criterion 1), the
 * restore through the outbox (criterion 3) and the jobs (criterion 4) are not covered here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { DepClient, insertText } from '../../test/data-plane/client.ts';
import { startPlane, until, type Plane } from '../../test/data-plane/support.ts';
import type { Span } from '../seams.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const traceparent = `00-${TRACE}-${PARENT}-01`;

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** A plane whose finished spans are kept in order. */
async function tracedPlane(): Promise<{ p: Plane; spans: Span[] }> {
  const spans: Span[] = [];
  const p = await startPlane({ settings: { onSpan: (s: Span) => void spans.push(s) } });
  planes.push(p);
  return { p, spans };
}

/** A client whose hello carries the given traceparent (or none), opened on the document. */
async function openWith(p: Plane, doc: string, extra: Record<string, unknown>): Promise<DepClient> {
  const token = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
  const c = await DepClient.connect(p.url);
  await c.hello(token, extra);
  expect((await c.open(1, doc)).t).toBe('ch.opened');
  return c;
}

describe('a traced session (BE-087 criterion 2)', () => {
  it('makes the session, its channel and its commits spans of the hello trace', async () => {
    const { p, spans } = await tracedPlane();
    const doc = await p.createDocument();
    const c = await openWith(p, doc, { traceparent });
    expect(
      (await c.submit(1, { base: 0, steps: [insertText(intro(), 'secret typed text')] })).t,
    ).toBe('sync.ack');
    // Closing the client ends the channel and the session, and their spans are recorded.
    c.terminate();
    await until(() => spans.some((s) => s.name === 'dep.session' && s.traceId === TRACE));

    const mine = spans.filter((s) => s.traceId === TRACE);
    const names = new Set(mine.map((s) => s.name));
    expect(names.has('dep.session')).toBe(true);
    expect(names.has('dep.channel')).toBe(true);
    expect(names.has('dep.commit')).toBe(true);
    // The session's root span hangs off the caller's span.
    expect(mine.find((s) => s.name === 'dep.session')?.parentSpanId).toBe(PARENT);
    // Attributes are identifiers and codes, never the typed text (06 §11).
    for (const s of mine) expect(JSON.stringify(s.attributes)).not.toContain('secret typed text');
  });

  it('starts a trace of its own when hello carries no traceparent', async () => {
    const { p, spans } = await tracedPlane();
    const doc = await p.createDocument();
    const c = await openWith(p, doc, {});
    c.terminate();
    await until(() => spans.some((s) => s.name === 'dep.session'));
    const sessions = spans.filter((s) => s.name === 'dep.session');
    expect(sessions.every((s) => s.traceId !== TRACE)).toBe(true);
    expect(sessions.every((s) => /^[0-9a-f]{32}$/.test(s.traceId))).toBe(true);
    expect(sessions.every((s) => s.parentSpanId === null)).toBe(true);
  });
});
