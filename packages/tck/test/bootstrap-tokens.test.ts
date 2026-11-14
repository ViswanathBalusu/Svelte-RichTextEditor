// PRO-011 criterion 5 (05 §3.1, §11; PRO-108 criterion 1): a server that does not offer
// `POST /tokens` is reported non-conforming when the kit bootstraps. The server here answers
// discovery and `POST /v1/documents` like a conforming one, and 404 for everything else, so the
// only missing bootstrap call is the token mint.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';

const DOCUMENT_ID = '0192f0c4-0000-7000-8000-0000000000aa';
let server: Server;
let base: string;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  const port = (server.address() as AddressInfo).port;
  const path = req.url ?? '';
  if (req.method === 'GET' && path === '/.well-known/dep') {
    sendJson(res, 200, {
      versions: ['1.0'],
      ws: `ws://127.0.0.1:${port}/v1/ws`,
      rest: `http://127.0.0.1:${port}/v1`,
      engines: ['pm-steps/1'],
      cdm: { min: 1, max: 1 },
      features: [],
      mode: 'authority',
      jwks_uri: `http://127.0.0.1:${port}/v1/jwks`,
    });
    return;
  }
  if (req.method === 'POST' && path === '/v1/documents') {
    sendJson(res, 201, { id: DOCUMENT_ID });
    return;
  }
  // No `POST /tokens` here: the mint of the bootstrap is refused like any unknown route.
  sendJson(res, 404, { type: 'about:blank', title: 'not found', status: 404, code: 'not_found' });
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a server without POST /tokens (PRO-011 criterion 5)', () => {
  it('is reported non-conforming at bootstrap, and no profile runs against it', async () => {
    const report = await runKit({
      discovery: base,
      credential: 'dep_svc_test_credential_not_a_secret',
      testMode: false,
      origin: 'http://127.0.0.1',
      fuzz: { budgetMs: 100, maxRuns: 1 },
      property: { runs: 1 },
    });
    expect(report.bootstrap.ok).toBe(false);
    expect(report.bootstrap.failure?.message).toContain('POST /tokens');
    expect(report.ok).toBe(false);
    expect(report.totals.passed).toBe(0);
    expect(report.profiles.length).toBeGreaterThan(0);
    for (const p of report.profiles) expect(p.outcome).toBe('skipped');
  }, 60_000);
});
