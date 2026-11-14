// The request identifier, the trace and the log lines of REST requests on PostgreSQL (PRO-044
// criteria 1, 2 and the REST part of 4; lane U-PRO-035-051). The same checks as
// request-trace.test.ts, over the real HTTP pipeline with PostgreSQL storage. Skips when PostgreSQL
// is not up: pwsh -NoProfile -File infra/test-env.ps1 up
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log.ts';
import type { Span } from '../../src/seams.ts';
import { skipReason, startHarness, type Harness } from './support.ts';

const skip = await skipReason('postgres');
if (skip) console.warn(`skipped: ${skip}`);

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE}-${PARENT}-01`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe.skipIf(skip !== null)(
  'REST requests on PostgreSQL: request identifier, trace and logs (PRO-044)',
  () => {
    let h: Harness;
    const spans: Span[] = [];
    const lines: string[] = [];

    beforeAll(async () => {
      h = await startHarness('postgres', {
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

    it('answers every REST response with a DEP-Request-Id, errors equal to the problem (criterion 2)', async () => {
      const ok = await h.call('GET', '/v1/documents', { token: h.apiKey });
      const noAuth = await h.call('GET', '/v1/documents');
      const unknown = await h.call('GET', '/v1/no-such-route', { token: h.apiKey });
      const pre = await h.call('OPTIONS', '/v1/documents', {
        headers: { Origin: 'https://app.example.test', 'Access-Control-Request-Method': 'POST' },
      });
      const all = [ok, noAuth, unknown, pre];
      for (const r of all)
        expect(r.headers.get('DEP-Request-Id'), `status ${r.status}`).toMatch(UUID);
      expect(new Set(all.map((r) => r.headers.get('DEP-Request-Id'))).size).toBe(all.length);
      expect(noAuth.json?.requestId).toBe(noAuth.headers.get('DEP-Request-Id'));
      expect(unknown.json?.requestId).toBe(unknown.headers.get('DEP-Request-Id'));
    });

    it('records a REST request as a span of the trace its traceparent names, errors included (criterion 1)', async () => {
      const ok = await h.call('GET', '/v1/documents', {
        token: h.apiKey,
        headers: { traceparent: TRACEPARENT },
      });
      const denied = await h.call('GET', '/v1/documents', {
        headers: { traceparent: TRACEPARENT },
      });
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
      const httpLines = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l['event'] === 'http');
      expect(httpLines.filter((l) => l['traceId'] === TRACE).length).toBe(2);
    });

    it('keeps document content, tokens and the database password out of REST logs and spans (criterion 4, REST part)', async () => {
      const secret = 'pro044 pg typed secret text';
      const bogus = 'bogus-token-pro044-pg';
      const id = await h.createDocument({ properties: { title: secret } });
      await h.call('GET', `/v1/documents/${id}`, { token: h.apiKey });
      await h.call('GET', `/v1/documents/${id}`, { token: bogus });
      await h.call('GET', `/v1/documents/${id}/content`, { token: bogus });

      const logged = lines.join('\n');
      const traced = spans.map((s) => JSON.stringify(s)).join('\n');
      // Not vacuous: the requests were logged and traced.
      expect(logged).toContain('"event":"http"');
      expect(traced).toContain('"name":"http.request"');
      const dbPassword = h.db?.serviceConfig.password;
      for (const text of [logged, traced]) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain(bogus);
        expect(text).not.toContain(h.apiKey);
        if (dbPassword) expect(text).not.toContain(dbPassword);
      }
    });
  },
);
