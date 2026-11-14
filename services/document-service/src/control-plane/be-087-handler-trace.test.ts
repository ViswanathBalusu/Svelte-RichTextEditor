/**
 * BE-087 criterion 1, the handler half: a REST request with `traceparent` continues its trace in the
 * handler. The pipeline gives the handler the request span's trace (`ctx.trace`); a span the handler
 * opens with it is part of the caller's trace, with the request span as its parent. Uses a public
 * route (`getDiscovery`, security none) with a probe handler, so no token store is needed.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../log.ts';
import type { Span } from '../seams.ts';
import { Tracer, type TraceContext } from '../data-plane/tracing.ts';
import { Pipeline, type Ctx, type Handler } from './pipeline.ts';
import type { TokenService } from './tokens.ts';
import type { TenantRegistry } from './tenants.ts';
import type { UserDirectory } from './users.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const traceparent = `00-${TRACE}-${PARENT}-01`;

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

describe('a handler continues the trace of its request (BE-087 criterion 1)', () => {
  const spans: Span[] = [];
  const seen: TraceContext[] = [];
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const tracer = new Tracer((s) => spans.push(s));
    const probe: Handler = async (ctx: Ctx) => {
      seen.push(ctx.trace);
      // A span the handler opens under the request's trace (the way a handler's work is traced).
      tracer.start('handler.work', ctx.trace, { route: 'getDiscovery' }).end();
      return { status: 200, body: { ok: true } };
    };
    const pipeline = new Pipeline({
      tokens: {} as TokenService,
      registry: {} as TenantRegistry,
      users: {} as UserDirectory,
      handlers: { getDiscovery: probe },
      plain: {},
      restPath: '/v1',
      logger: quietLogger,
      maxBodyBytes: 1024,
      maxContentBodyBytes: 1024,
      now: Date.now,
      onSpan: (s) => spans.push(s),
    });
    server = createServer((req, res) => {
      void pipeline.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('gives the handler the request trace, and the handler span is a child of the request span', async () => {
    spans.length = 0;
    seen.length = 0;
    const r = await fetch(`${base}/.well-known/dep`, { headers: { traceparent } });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    const requestSpan = spans.find((s) => s.name === 'http.request');
    const handlerSpan = spans.find((s) => s.name === 'handler.work');
    expect(requestSpan).toBeDefined();
    expect(handlerSpan).toBeDefined();
    // The handler saw the request span's trace, and the caller's trace is kept end to end.
    expect(seen[0]!.traceId).toBe(TRACE);
    expect(seen[0]!.spanId).toBe(requestSpan!.spanId);
    expect(requestSpan!.traceId).toBe(TRACE);
    expect(requestSpan!.parentSpanId).toBe(PARENT);
    expect(handlerSpan!.traceId).toBe(TRACE);
    expect(handlerSpan!.parentSpanId).toBe(requestSpan!.spanId);
  });

  it('starts one trace for the request and its handler when no traceparent is sent', async () => {
    spans.length = 0;
    seen.length = 0;
    const r = await fetch(`${base}/.well-known/dep`);
    expect(r.status).toBe(200);
    const requestSpan = spans.find((s) => s.name === 'http.request');
    const handlerSpan = spans.find((s) => s.name === 'handler.work');
    expect(requestSpan!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(requestSpan!.traceId).not.toBe(TRACE);
    expect(requestSpan!.parentSpanId).toBeNull();
    expect(handlerSpan!.traceId).toBe(requestSpan!.traceId);
    expect(handlerSpan!.parentSpanId).toBe(requestSpan!.spanId);
  });
});
