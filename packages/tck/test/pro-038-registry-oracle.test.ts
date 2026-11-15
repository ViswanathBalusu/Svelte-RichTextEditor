/**
 * The registry oracle of the kit (PRO-038 criteria 2 and 3; 05 §5.8). A small defective server
 * answers REST requests and socket frames with what each test tells it to. The kit's own runner
 * (`runScenario`) runs a scenario that only makes the call and checks nothing itself, so a failure
 * comes from the oracle alone: a code outside the registry, a code on the wrong surface, or a
 * `rate_limited` or `quota_exceeded` without its retry hint. The same scenario passes when the
 * server sends a correct problem.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uuid7 } from '@docedit/model';
import type { Discovery, Welcome } from '@docedit/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { resolveConfig } from '../src/config.ts';
import type { ScenarioContext, Target } from '../src/context.ts';
import { Http, ServiceClient } from '../src/rest.ts';
import { runScenario } from '../src/runner.ts';
import type { ProfileDef, ScenarioDef } from '../src/scenario.ts';

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

const problem = (status: number, code: unknown, headers: Record<string, string> = {}): Answer => ({
  status,
  headers: { 'content-type': 'application/problem+json', ...headers },
  body: JSON.stringify({
    type: 'about:blank',
    title: 'a problem',
    status,
    ...(code === undefined ? {} : { code }),
  }),
});

describe('the kit fails a problem the error registry does not allow (PRO-038)', () => {
  let server: Server;
  let sockets: WebSocketServer;
  let target: Target;
  /** What the server answers next: one REST answer, and the frames it sends to a new socket. */
  let answer: Answer = problem(404, 'not_found');
  let frames: unknown[] = [];

  const PROFILE: ProfileDef = {
    id: 'oracle',
    title: 'the registry oracle',
    spec: '05 §5.8',
    stories: ['PRO-038'],
    requires: { kind: 'always' },
    scenarios: [],
  };
  /** A scenario that makes one REST call and judges nothing. */
  const restCall: ScenarioDef = {
    id: 'oracle.rest',
    title: 'one REST call',
    spec: '05 §5.8',
    covers: {},
    run: async (ctx: ScenarioContext) => {
      await ctx.service.call('GET', '/documents/x');
    },
  };
  /** A scenario that opens a socket, receives what the server sends and judges nothing. */
  const socketCall: ScenarioDef = {
    id: 'oracle.socket',
    title: 'one socket',
    spec: '05 §5.8',
    covers: {},
    run: async (ctx: ScenarioContext) => {
      const expected = frames.length;
      const w = await ctx.connect({ label: 'oracle' });
      for (let waited = 0; w.frames.length < expected && waited < 3000; waited += 5)
        await ctx.sleep(5);
      await w.close();
    },
  };

  const rest = async (a: Answer) => {
    answer = a;
    return runScenario(target, PROFILE, restCall);
  };
  const socket = async (f: unknown[]) => {
    frames = f;
    return runScenario(target, PROFILE, socketCall);
  };

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(answer.status, answer.headers ?? {});
      res.end(answer.body);
    });
    sockets = new WebSocketServer({ server, handleProtocols: () => 'dep.v1' });
    sockets.on('connection', (ws) => {
      for (const f of frames) ws.send(JSON.stringify(f));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const http = new Http();
    target = {
      config: resolveConfig({ discovery: base, credential: 'not-used', testMode: false }),
      discoveryUrl: `${base}/.well-known/dep`,
      discovery: { rest: `${base}/v1`, ws: `ws://127.0.0.1:${port}/dep` } as Discovery,
      features: new Set<string>(),
      http,
      service: new ServiceClient(http, `${base}/v1`, 'not-used'),
      welcome: {} as Welcome,
    };
  });
  afterAll(async () => {
    for (const c of sockets.clients) c.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('REST problems', () => {
    it('passes a problem with a registry code of the REST surface', async () => {
      expect((await rest(problem(404, 'not_found'))).outcome).toBe('passed');
    });

    it('fails a code outside the registry', async () => {
      const r = await rest(problem(409, 'made_up_code'));
      expect(r.outcome).toBe('failed');
      expect(r.failure?.received).toContain('/code is not a code of the error registry');
      expect(r.failure?.received).toContain('GET /v1/documents/x answered 409');
    });

    it('fails a problem document without a code', async () => {
      const r = await rest(problem(500, undefined));
      expect(r.outcome).toBe('failed');
      expect(r.failure?.received).toContain('/code is not a code of the error registry');
    });

    it('fails a registry code that does not appear on REST', async () => {
      const r = await rest(problem(400, 'unknown_type'));
      expect(r.outcome).toBe('failed');
      expect(r.failure?.received).toContain('unknown_type does not appear on the rest surface');
    });

    it.each(['rate_limited', 'quota_exceeded'])(
      'fails %s without Retry-After and passes it with the header',
      async (code) => {
        const without = await rest(problem(429, code));
        expect(without.outcome).toBe('failed');
        expect(without.failure?.received).toContain(`${code} needs a Retry-After header`);
        expect((await rest(problem(429, code, { 'retry-after': '2' }))).outcome).toBe('passed');
      },
    );

    it('leaves a success alone, and an error that is not a problem document', async () => {
      expect(
        (
          await rest({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: 'not-an-error' }),
          })
        ).outcome,
      ).toBe('passed');
      expect(
        (
          await rest({
            status: 502,
            headers: { 'content-type': 'text/plain' },
            body: 'bad gateway',
          })
        ).outcome,
      ).toBe('passed');
    });
  });

  describe('socket problems', () => {
    const error = (code: string, extra: Record<string, unknown> = {}) => ({
      t: 'error',
      d: { code, message: 'refused', retryable: true, fatal: false, ...extra },
    });
    const reject = (code: string, extra: Record<string, unknown> = {}) => ({
      t: 'sync.reject',
      re: 'k1',
      ch: 1,
      d: { id: uuid7(), code, message: 'refused', action: 'retry', head: 0, ...extra },
    });

    it('passes problems with registry codes and their retry hints', async () => {
      const r = await socket([
        error('rate_limited', { retryAfterMs: 500 }),
        reject('quota_exceeded', { retryAfterMs: 500 }),
        reject('stale_base', { action: 'rebase' }),
        { t: 'ch.closed', ch: 1, d: { code: 'unavailable', reason: 'the room moved' } },
      ]);
      expect(r.failure).toBeUndefined();
      expect(r.outcome).toBe('passed');
    });

    it.each([
      ['error', error('made_up_code')],
      ['sync.reject', reject('made_up_code')],
      [
        'ch.rejected',
        { t: 'ch.rejected', re: 'k1', ch: 1, d: { code: 'made_up_code', message: 'no' } },
      ],
      ['ch.closed', { t: 'ch.closed', ch: 1, d: { code: 'made_up_code', reason: 'no' } }],
    ])('fails a %s with a code outside the registry', async (_t, frame) => {
      const r = await socket([frame]);
      expect(r.outcome).toBe('failed');
      expect(r.failure?.received).toContain('/d/code');
    });

    it.each(['rate_limited', 'quota_exceeded'])(
      'fails an error and a sync.reject with %s that carry no retryAfterMs',
      async (code) => {
        const e = await socket([error(code)]);
        expect(e.outcome).toBe('failed');
        expect(e.failure?.received).toContain(`error: /retryAfterMs ${code} needs retryAfterMs`);
        const s = await socket([reject(code)]);
        expect(s.outcome).toBe('failed');
        expect(s.failure?.received).toContain(
          `sync.reject: /retryAfterMs ${code} needs retryAfterMs`,
        );
      },
    );
  });
});
