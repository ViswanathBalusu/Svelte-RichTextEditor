// What the client does with each error code it receives over REST (PRO-039; 05 §5.8, §6.1). A
// refused token is renewed once with `getToken`; the other codes are returned to the caller with
// their registry code and are never retried by the client. The socket-side reactions are covered
// by `src/backend.universal.test.ts`. Node.js only: the test counts every request the client sends.
import { describe, expect, it } from 'vitest';
import { isPortError } from '@docedit/protocol';
import { createDepBackend, type DepBackend } from '../src/index.ts';
import { LEGAL_GRANT, USERS, contractDocument } from './support/fixtures.ts';
import { MemoryNetwork, type HttpRequest, type HttpResponse } from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';

type Interceptor = (req: HttpRequest) => HttpResponse | null;

interface Rig {
  server: MockDepServer;
  docId: string;
  /** Every control-plane request the client sent, by method and path. */
  requests: string[];
  /** Every token the host's `getToken` minted. */
  tokens: string[];
  make(): DepBackend;
}

function rig(intercept: Interceptor = () => null): Rig {
  const server = new MockDepServer();
  const docId = server.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const requests: string[] = [];
  const tokens: string[] = [];
  const net = new MemoryNetwork({
    accept: (s) => server.accept(s),
    http: async (req) => {
      if (req.url.includes('/v1/')) requests.push(`${req.method} ${new URL(req.url).pathname}`);
      return intercept(req) ?? server.http(req);
    },
  });
  return {
    server,
    docId,
    requests,
    tokens,
    make: () =>
      createDepBackend({
        endpoint: server.endpoint,
        getToken: async () => {
          const t = server.mintToken(USERS.editor, { [docId]: 'editor' });
          tokens.push(t);
          return t;
        },
        platform: net.platform(),
      }),
  };
}

/** A problem response with a registry code, as 05 §6.1 describes it. */
function problem(status: number, code: string, extra: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/problem+json', ...extra },
    body: JSON.stringify({ type: 'about:blank', title: code, status, code, detail: code }),
  };
}

const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe('REST error codes (PRO-039; 05 §5.8)', () => {
  it('shows forbidden to the caller once and retries nothing', async () => {
    const r = rig();
    const b = r.make();
    await b.sync.loadContent(r.docId);
    const tokensBefore = r.tokens.length;
    const requestsBefore = r.requests.length;
    const dead = '0192f0c4-0000-7000-8000-00000000dead';
    const e = await failure(b.sync.loadContent(dead));
    expect(isPortError(e) && e.code).toBe('forbidden');
    expect(r.tokens.length).toBe(tokensBefore);
    expect(r.requests.length - requestsBefore).toBe(1);
    await b.close();
  });

  it('renews a token that expired once, then gives up with token_expired', async () => {
    const r = rig((req) => (req.url.includes('/v1/') ? problem(401, 'token_expired') : null));
    const b = r.make();
    const e = await failure(b.sync.loadContent(r.docId));
    expect(isPortError(e) && e.code).toBe('token_expired');
    // One original request and one renewed request, and one token from getToken for each.
    expect(r.requests).toHaveLength(2);
    expect(r.tokens).toHaveLength(2);
    await b.close();
  });

  it.each([
    ['rate_limited', 429, 3],
    ['quota_exceeded', 429, 60],
  ] as const)(
    'returns %s with its Retry-After and does not resubmit on its own',
    async (code, status, seconds) => {
      const r = rig((req) =>
        req.url.includes('/v1/') ? problem(status, code, { 'retry-after': String(seconds) }) : null,
      );
      const b = r.make();
      const e = await failure(b.sync.loadContent(r.docId));
      expect(isPortError(e) && e.code).toBe(code);
      expect(isPortError(e) && e.retryAfterMs).toBe(seconds * 1000);
      expect(r.requests).toHaveLength(1);
      await b.close();
    },
  );

  it.each([
    'validation_failed',
    'precondition_failed',
    'pending_suggestions',
    'workflow_active',
    'idempotency_mismatch',
  ])('returns %s to the caller with its code and no automatic retry', async (code) => {
    const r = rig((req) => (req.url.includes('/v1/') ? problem(409, code) : null));
    const b = r.make();
    const e = await failure(b.sync.loadContent(r.docId));
    expect(isPortError(e) && e.code).toBe(code);
    expect(r.requests).toHaveLength(1);
    expect(r.tokens).toHaveLength(1);
    await b.close();
  });
});

describe('socket error codes that end a session (PRO-039; 05 §5.8)', () => {
  it.each([
    ['unsupported_version', { versions: ['2.0'] }],
    ['unsupported_engine', { engines: ['crdt/9'] }],
    ['unsupported_cdm', { cdm: { min: 9, max: 9 } }],
  ] as const)('refuses %s without a reconnect attempt', async (code, change) => {
    const server = new MockDepServer({
      discovery: (d) => ({ ...d, ...change }),
    });
    const docId = server.service.createDocument(contractDocument(), {
      grants: [LEGAL_GRANT],
    });
    const net = new MemoryNetwork({
      accept: (s) => server.accept(s),
      http: (req) => server.http(req),
    });
    const b = createDepBackend({
      endpoint: server.endpoint,
      getToken: async () => server.mintToken(USERS.editor, { [docId]: 'editor' }),
      platform: net.platform(),
    });
    const e = await failure(b.connect());
    expect(isPortError(e) && e.code).toBe(code);
    expect(b.connection.status).toBe('offline');
    await b.close();
  });
});
