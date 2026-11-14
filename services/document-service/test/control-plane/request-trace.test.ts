// The request identifier, the trace and the log lines of REST requests (PRO-044 criteria 1, 2 and
// the REST part of 4; 05 §6.1; 06 §11; BE-088), over real HTTP against an in-process service with
// in-memory storage. PostgreSQL is not run here.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log.ts';
import type { Span } from '../../src/seams.ts';
import { startHarness, type Harness } from './support.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE}-${PARENT}-01`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('REST requests: request identifier, trace and log lines (PRO-044)', () => {
  let h: Harness;
  const spans: Span[] = [];
  const lines: string[] = [];

  beforeAll(async () => {
    h = await startHarness('memory', {
      logger: createLogger((line) => void lines.push(line)),
      onSpan: (s) => void spans.push(s),
    });
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(() => {
    spans.length = 0;
    lines.length = 0;
  });

  it('answers every REST response, errors and preflights included, with a DEP-Request-Id (PRO-044 criterion 2)', async () => {
    const ok = await h.call('GET', '/v1/documents', { token: h.apiKey });
    const noAuth = await h.call('GET', '/v1/documents');
    const unknown = await h.call('GET', '/v1/no-such-route', { token: h.apiKey });
    const bad = await h.call('POST', '/v1/documents', {
      token: h.apiKey,
      raw: '{not json',
      headers: { 'Content-Type': 'application/json' },
    });
    const pre = await h.call('OPTIONS', '/v1/documents', {
      headers: {
        Origin: 'https://app.example.test',
        'Access-Control-Request-Method': 'POST',
      },
    });
    const plain = await h.call('GET', '/.well-known/dep');
    const all = [ok, noAuth, unknown, bad, pre, plain];
    for (const r of all)
      expect(r.headers.get('DEP-Request-Id'), `status ${r.status}`).toMatch(UUID);
    // Each request has its own identifier.
    expect(new Set(all.map((r) => r.headers.get('DEP-Request-Id'))).size).toBe(all.length);
    // An error's problem document carries the same identifier as its header.
    expect(noAuth.status).toBeGreaterThanOrEqual(400);
    expect(noAuth.json?.requestId).toBe(noAuth.headers.get('DEP-Request-Id'));
    expect(unknown.status).toBe(404);
    expect(unknown.json?.requestId).toBe(unknown.headers.get('DEP-Request-Id'));
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.json?.requestId).toBe(bad.headers.get('DEP-Request-Id'));
  });

  it('records a REST request as a span of the trace its traceparent names, errors included (PRO-044 criterion 1)', async () => {
    const ok = await h.call('GET', '/v1/documents', {
      token: h.apiKey,
      headers: { traceparent: TRACEPARENT },
    });
    const denied = await h.call('GET', '/v1/documents', { headers: { traceparent: TRACEPARENT } });
    expect(denied.status).toBeGreaterThanOrEqual(400);

    const mine = spans.filter((s) => s.traceId === TRACE);
    expect(mine.length).toBe(2);
    for (const s of mine) {
      expect(s.name).toBe('http.request');
      expect(s.parentSpanId).toBe(PARENT);
    }
    expect(mine.map((s) => s.attributes['status']).sort()).toEqual(
      [ok.status, denied.status].sort(),
    );

    // The log line of each request names the same trace.
    const httpLines = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['event'] === 'http');
    expect(httpLines.filter((l) => l['traceId'] === TRACE).length).toBe(2);
  });

  it('starts a trace of its own for a REST request with no traceparent', async () => {
    await h.call('GET', '/v1/documents', { token: h.apiKey });
    const own = spans.filter((s) => s.name === 'http.request');
    expect(own.length).toBe(1);
    expect(own[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(own[0]!.traceId).not.toBe(TRACE);
    expect(own[0]!.parentSpanId).toBeNull();
  });

  it('keeps document content and tokens out of REST logs and spans (PRO-044 criterion 4, REST part)', async () => {
    const secret = 'pro044 typed secret text';
    const bogus = 'bogus-token-pro044';
    const id = await h.createDocument({ properties: { title: secret } });
    await h.call('GET', `/v1/documents/${id}`, { token: h.apiKey });
    await h.call('GET', `/v1/documents/${id}`, { token: bogus });

    const logged = lines.join('\n');
    const traced = spans.map((s) => JSON.stringify(s)).join('\n');
    // Not vacuous: the requests were logged and traced.
    expect(logged).toContain('"event":"http"');
    expect(traced).toContain('"name":"http.request"');
    for (const text of [logged, traced]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(bogus);
      expect(text).not.toContain(h.apiKey);
    }
  });
});
