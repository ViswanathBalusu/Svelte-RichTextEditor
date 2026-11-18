// FRW-035 criterion 6, the client's half: the workflow port of backend-dep reports the workflow
// object of `ch.opened` and each `wf.changed` to its listeners, in order, and reads and acts through
// the workflow routes. The in-memory network records the wire; the server adds the workflow object
// to `ch.opened` and the test pushes `wf.changed` frames. Universal: Node.js and browsers.
import { describe, expect, it } from 'vitest';
import type { WorkflowPort } from '@docedit/protocol';
import { createDepBackend, type DepBackend } from './index.ts';
import { LEGAL_GRANT, USERS, contractDocument } from '../test/support/fixtures.ts';
import { MemoryNetwork, type MemoryServer } from '../test/support/memory-network.ts';
import { MockDepServer } from '../test/support/mock-server.ts';

type Status = Parameters<Parameters<WorkflowPort['onChange']>[1]>[0];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 3000): Promise<void> {
  for (let waited = 0; !pred(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const WORKFLOW = (doc: string, state: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9f',
  doc,
  state,
  rev: 1,
  timeZone: 'UTC',
  participants: [{ id: 'p1', roles: ['tenant'], kind: 'signer', order: 1 }],
});

/** A DEP server that announces `workflow`, puts a workflow object in `ch.opened` and serves the routes. */
function workflowServer(opts: { features?: boolean } = {}) {
  const base = new MockDepServer({
    welcome: (d) =>
      opts.features === false
        ? d
        : { ...d, features: [...(d['features'] as string[]), 'workflow'] },
  });
  let opened: Status = { state: 'in_progress', participant: { id: 'p1', state: 'waiting' } };
  const calls: string[] = [];
  const server: MemoryServer = {
    accept(socket) {
      const send = socket.send.bind(socket);
      socket.send = (text: string) => {
        const m = JSON.parse(text) as { t: string; d?: Record<string, unknown> };
        if (m.t === 'ch.opened') m.d = { ...m.d, workflow: opened };
        send(JSON.stringify(m));
      };
      return base.accept(socket);
    },
    async http(req) {
      const url = new URL(req.url);
      const m = /^\/v1\/documents\/([^/]+)\/workflow(\/.*)?$/.exec(url.pathname);
      if (m === null) return base.http(req);
      calls.push(`${req.method} ${url.pathname} ${req.headers['authorization'] ?? ''}`);
      const body = JSON.stringify(WORKFLOW(decodeURIComponent(m[1]!), 'sent'));
      return {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"3"' },
        body,
      };
    },
  };
  return {
    base,
    server,
    calls,
    setOpened: (s: Status) => {
      opened = s;
    },
  };
}

function backendFor(
  w: ReturnType<typeof workflowServer>,
  docId: string,
): {
  b: DepBackend;
  net: MemoryNetwork;
} {
  const net = new MemoryNetwork(w.server);
  const b = createDepBackend({
    endpoint: w.base.endpoint,
    getToken: async () => w.base.mintToken(USERS.editor, { [docId]: 'editor' }),
    features: ['presence', 'regions', 'suggest-enforced', 'workflow'],
    platform: { random: () => 0, ...net.platform() },
  });
  return { b, net };
}

async function open(b: DepBackend, docId: string) {
  await b.connect();
  const content = await b.sync.loadContent(docId);
  return b.sync.open(docId, { resume: { seq: content.seq, incarnation: content.incarnation } });
}

describe('the workflow port of backend-dep (FRW-035 criterion 6)', () => {
  it('is present only while `workflow` is negotiated', async () => {
    const off = workflowServer({ features: false });
    const docId = off.base.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
    const a = backendFor(off, docId);
    await a.b.connect();
    expect(a.b.workflow).toBeUndefined();
    await a.b.close();

    const on = workflowServer();
    const doc2 = on.base.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
    const c = backendFor(on, doc2);
    await c.b.connect();
    expect(c.b.workflow).toBeDefined();
    await c.b.close();
  });

  it('reports the object of ch.opened and then each wf.changed, in order', async () => {
    const w = workflowServer();
    const docId = w.base.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
    const { b, net } = backendFor(w, docId);
    const seen: Status[] = [];
    await b.connect();
    // The listener is added before the channel opens, as the editor's services are made first.
    const stop = b.workflow!.onChange(docId, (s) => seen.push(s));
    const content = await b.sync.loadContent(docId);
    await b.sync.open(docId, { resume: { seq: content.seq, incarnation: content.incarnation } });
    await until(() => seen.length === 1, 'the object of ch.opened');
    expect(seen[0]).toEqual({ state: 'in_progress', participant: { id: 'p1', state: 'waiting' } });

    const ch = net.decoded('s2c').find((f) => f['t'] === 'ch.opened')!['ch'];
    w.base.sessions[0]!.push({
      t: 'wf.changed',
      ch,
      d: { state: 'correcting', participant: { id: 'p1', state: 'paused' } },
    });
    await until(() => seen.length === 2, 'wf.changed');
    expect(seen[1]).toEqual({ state: 'correcting', participant: { id: 'p1', state: 'paused' } });

    // After stop, nothing more arrives.
    stop();
    w.base.sessions[0]!.push({ t: 'wf.changed', ch, d: { state: 'in_progress' } });
    await sleep(30);
    expect(seen).toHaveLength(2);
    await b.close();
  });

  it('tells a listener added after the channel opened the latest status, once', async () => {
    const w = workflowServer();
    const docId = w.base.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
    const { b, net } = backendFor(w, docId);
    const first: Status[] = [];
    await b.connect();
    b.workflow!.onChange(docId, (s) => first.push(s));
    const content = await b.sync.loadContent(docId);
    await b.sync.open(docId, { resume: { seq: content.seq, incarnation: content.incarnation } });
    await until(() => first.length === 1, 'the object of ch.opened');
    const ch = net.decoded('s2c').find((f) => f['t'] === 'ch.opened')!['ch'];
    w.base.sessions[0]!.push({ t: 'wf.changed', ch, d: { state: 'voided' } });
    await until(() => first.length === 2, 'wf.changed');

    const late: Status[] = [];
    b.workflow!.onChange(docId, (s) => late.push(s));
    await until(() => late.length === 1, 'the latest status');
    expect(late[0]).toEqual({ state: 'voided' });
    await sleep(30);
    expect(late).toHaveLength(1);
    expect(first).toHaveLength(2);
    await b.close();
  });

  it('keeps a status that arrives before anyone listens for the first listener', async () => {
    const w = workflowServer();
    const docId = w.base.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
    const { b } = backendFor(w, docId);
    await open(b, docId);
    const seen: Status[] = [];
    b.workflow!.onChange(docId, (s) => seen.push(s));
    await until(() => seen.length === 1, 'the kept status');
    expect(seen[0]?.state).toBe('in_progress');
    await b.close();
  });

  it('reads and acts through the workflow routes with the bearer token', async () => {
    const w = workflowServer();
    const docId = w.base.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
    const { b } = backendFor(w, docId);
    await b.connect();
    const got = await b.workflow!.get(docId);
    expect(got.value.state).toBe('sent');
    expect(got.etag).toBe('"3"');
    await b.workflow!.act(docId, 'correct');
    await b.workflow!.participant(docId, 'p 1', 'decline', { reason: 'No' });
    expect(w.calls.map((c) => c.replace(/Bearer .*/, 'Bearer ...'))).toEqual([
      `GET /v1/documents/${docId}/workflow Bearer ...`,
      `POST /v1/documents/${docId}/workflow/correct Bearer ...`,
      `POST /v1/documents/${docId}/workflow/participants/p%201/decline Bearer ...`,
    ]);
    await b.close();
  });
});
