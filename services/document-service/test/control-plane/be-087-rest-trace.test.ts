/**
 * BE-087 criterion 1, the request half: a REST request with `traceparent` is answered with a request
 * identifier, and its request span is part of the caller's trace, with the caller's span as parent.
 * The handler does not receive the trace (`Ctx` carries none), so spans a handler opens are not
 * shown here; criterion 1 stays unticked for that reason (see the story Notes).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Span } from '../../src/seams.ts';
import { startHarness, type Harness } from './support.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const traceparent = `00-${TRACE}-${PARENT}-01`;

describe('a REST request with traceparent (BE-087 criterion 1, request span)', () => {
  let h: Harness;
  const spans: Span[] = [];

  beforeAll(async () => {
    h = await startHarness('memory', {
      onSpan: (s) => {
        spans.push(s);
      },
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  it('answers with a request identifier and records the request span under the caller trace', async () => {
    const doc = await h.createDocument();
    spans.length = 0;
    const r = await h.call('GET', `/v1/documents/${doc}/content`, {
      token: h.apiKey,
      headers: { traceparent },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('DEP-Request-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const span = spans.find((s) => s.name === 'http.request');
    expect(span).toBeDefined();
    expect(span!.traceId).toBe(TRACE);
    expect(span!.parentSpanId).toBe(PARENT);
    expect(span!.attributes).toMatchObject({ method: 'GET', status: 200 });
  });

  it('starts a trace of its own when the request has no traceparent', async () => {
    const doc = await h.createDocument();
    spans.length = 0;
    const r = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    expect(r.status).toBe(200);
    const span = spans.find((s) => s.name === 'http.request');
    expect(span).toBeDefined();
    expect(span!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span!.traceId).not.toBe(TRACE);
    expect(span!.parentSpanId).toBeNull();
  });
});
