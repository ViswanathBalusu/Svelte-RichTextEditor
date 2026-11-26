// UX-086 (lane U-UX-076-090): the data-loss prevention hook. Criterion 4 (the request is signed as
// a webhook is, so the host verifies it) is shown on the sender's own HTTP round trip. Criterion 2
// (a deny is refused with the hook's reason and audited) and criterion 3 (an unanswered hook is
// refused, fail closed, and audited: a proposed default) are shown on POST /v1/documents/{id}/exports.
// Both the export path and the send path (POST /documents/{id}/workflow/send) ask the hook, through
// `askPolicyHook`; the last describe block shows the send path (criteria 1 to 3).
// The hook is a real HTTP server on 127.0.0.1 with an ephemeral port, started by this file.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { DepClient } from '../data-plane/client.ts';
import { PolicyHookClient } from '../../src/control-plane/policy-hook-client.ts';
import { verifyDelivery } from '../../src/control-plane/webhook-signing.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const SECRET = 'whsec_' + Buffer.from('ux-086-test-secret-000000000000').toString('base64');
const OTHER = 'whsec_' + Buffer.from('ux-086-another-secret-0000000000').toString('base64');

type Mode = 'allow' | 'deny' | 'slow' | 'garbage';

interface Seen {
  headers: Record<string, string | undefined>;
  body: string;
}

function hookServer() {
  const state: { mode: Mode; seen: Seen[] } = { mode: 'allow', seen: [] };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      state.seen.push({ headers: { ...req.headers } as Record<string, string | undefined>, body });
      if (state.mode === 'slow') {
        // Answers after the sender has given up. The response is dropped with the server.
        setTimeout(() => {
          if (!res.headersSent) res.end();
        }, 2000).unref();
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (state.mode === 'garbage') return void res.end('not json');
      const answer =
        state.mode === 'deny'
          ? { decision: 'deny', reason: 'The document is classified and may not leave the tenant.' }
          : { decision: 'allow' };
      res.end(JSON.stringify(answer));
    });
  });
  return {
    state,
    server,
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const { port } = server.address() as AddressInfo;
      return `http://127.0.0.1:${port}/dlp`;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('UX-086 the hook request and its sender (criterion 4, and the outcomes of criteria 2 and 3)', () => {
  const hook = hookServer();
  let url: string;

  beforeAll(async () => {
    url = await hook.listen();
  });
  afterAll(async () => {
    hook.server.closeAllConnections();
    await hook.close();
  });
  beforeEach(() => {
    hook.state.mode = 'allow';
    hook.state.seen = [];
  });

  const ask = {
    document: 'doc-ux-086',
    actor: 'user-ux-086',
    action: 'export' as const,
    target: 'pdf',
    classification: 'Confidential',
  };

  it('sends a request signed with the tenant secret, carrying the document, actor, action, target and label', async () => {
    const client = new PolicyHookClient({
      url,
      secrets: [SECRET],
      timeoutMs: 1000,
      now: () => 1_700_000_000_000,
    });
    const outcome = await client.ask(ask);
    expect(outcome).toEqual({ kind: 'decided', decision: { allow: true } });

    expect(hook.state.seen).toHaveLength(1);
    const sent = hook.state.seen[0]!;
    expect(JSON.parse(sent.body)).toEqual({
      document: 'doc-ux-086',
      actor: 'user-ux-086',
      action: 'export',
      target: 'pdf',
      classification: 'Confidential',
    });
    const now = Number(sent.headers['webhook-timestamp']);
    expect(
      verifyDelivery({ headers: sent.headers, body: sent.body, secrets: [SECRET], now }),
    ).toEqual({ ok: true });
    // The host's receiver refuses the request under another secret, and under a changed body.
    expect(
      verifyDelivery({ headers: sent.headers, body: sent.body, secrets: [OTHER], now }),
    ).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(
      verifyDelivery({
        headers: sent.headers,
        body: sent.body.replace('pdf', 'docx'),
        secrets: [SECRET],
        now,
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('returns a deny with the reason the hook gave (criterion 2, the decision)', async () => {
    hook.state.mode = 'deny';
    const client = new PolicyHookClient({ url, secrets: [SECRET], timeoutMs: 1000 });
    expect(await client.ask(ask)).toEqual({
      kind: 'decided',
      decision: {
        allow: false,
        reason: 'The document is classified and may not leave the tenant.',
      },
    });
  });

  it('reports a hook that answers too late as a timeout (criterion 3)', async () => {
    hook.state.mode = 'slow';
    const client = new PolicyHookClient({ url, secrets: [SECRET], timeoutMs: 150 });
    expect(await client.ask(ask)).toEqual({ kind: 'unanswered', cause: 'timeout' });
  });

  it('reports an answer that is not a decision as a bad answer (criterion 3)', async () => {
    hook.state.mode = 'garbage';
    const client = new PolicyHookClient({ url, secrets: [SECRET], timeoutMs: 1000 });
    expect(await client.ask(ask)).toEqual({ kind: 'unanswered', cause: 'bad_answer' });
  });

  it('reports a hook that cannot be reached as unreachable (criterion 3)', async () => {
    const closed = hookServer();
    const gone = await closed.listen();
    await closed.close();
    const client = new PolicyHookClient({ url: gone, secrets: [SECRET], timeoutMs: 1000 });
    expect(await client.ask(ask)).toEqual({ kind: 'unanswered', cause: 'unreachable' });
  });

  it('refuses a hook URL that is not http or https, a missing secret and a timeout that is not a whole number', () => {
    expect(() => new PolicyHookClient({ url: 'ftp://x', secrets: [SECRET], timeoutMs: 1 })).toThrow(
      TypeError,
    );
    expect(() => new PolicyHookClient({ url: url, secrets: [], timeoutMs: 1 })).toThrow(TypeError);
    expect(() => new PolicyHookClient({ url: url, secrets: [SECRET], timeoutMs: 0 })).toThrow(
      RangeError,
    );
  });
});

describe('UX-086 the export path asks the hook before it starts (criteria 2 and 3)', () => {
  let h: Harness;
  let hook: ReturnType<typeof hookServer>;

  beforeAll(async () => {
    hook = hookServer();
    const url = await hook.listen();
    const policyHook = new PolicyHookClient({ url, secrets: [SECRET], timeoutMs: 500 });
    h = await startHarness('memory', { parts: { policyHook } });
  });
  afterAll(async () => {
    await h?.close();
    hook.server.closeAllConnections();
    await hook.close();
  });
  beforeEach(() => {
    hook.state.mode = 'allow';
    hook.state.seen = [];
  });

  const labelled = async (doc: string, label: string) => {
    const etag = (await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey })).headers.get(
      'etag',
    )!;
    const r = await h.call('PATCH', `/v1/documents/${doc}`, {
      token: h.apiKey,
      body: { classification: label },
      headers: { 'If-Match': etag },
    });
    expect(r.status).toBe(200);
  };

  it('starts the export when the hook allows it, and asks with the label the document carries', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    await labelled(doc, 'Internal use only');
    const editor = h.userToken({ [doc]: 'editor' });
    const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: editor,
      body: { target: 'pdf' },
    });
    expect(r.status, r.text).toBe(202);

    expect(hook.state.seen).toHaveLength(1);
    expect(JSON.parse(hook.state.seen[0]!.body)).toMatchObject({
      document: doc,
      action: 'export',
      target: 'pdf',
      classification: 'Internal use only',
    });
  });

  it('refuses the export with the hook reason and audits the refusal, and starts no job (criterion 2)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    hook.state.mode = 'deny';
    const editor = h.userToken({ [doc]: 'editor' });
    const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: editor,
      body: { target: 'pdf' },
    });
    expect(r.status, r.text).toBe(403);
    expect(r.text).toContain('The document is classified and may not leave the tenant.');

    const events = await h.parts.audit!.query(h.tenant, {
      kind: 'policy_hook.refused',
      limit: 1000,
    });
    const mine = events.filter((e) => e.doc === doc);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.data).toMatchObject({ action: 'export', target: 'pdf' });
  });

  it('refuses the export when the hook does not answer in time, and audits that (criterion 3, proposed default)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    hook.state.mode = 'slow';
    const editor = h.userToken({ [doc]: 'editor' });
    const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: editor,
      body: { target: 'pdf' },
    });
    expect(r.status, r.text).toBe(503);
    expect(r.text).toContain('unavailable');

    const events = await h.parts.audit!.query(h.tenant, {
      kind: 'policy_hook.unanswered',
      limit: 1000,
    });
    const mine = events.filter((e) => e.doc === doc);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.data).toMatchObject({ action: 'export', cause: 'timeout' });
  });
});

const sendable = (): Record<string, unknown> => {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  defs.push({ type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } });
  defs.push({ type: 'role_def', attrs: { id: 'landlord', name: 'Landlord', color: '#FF7F0E' } });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pFields000000003' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: 'ff00000000000001',
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          required: true,
          value: null,
        },
      },
      { type: 'text', text: ' ' },
      {
        type: 'form_field',
        attrs: {
          id: 'ff00000000000002',
          key: 'landlord.name',
          kind: 'text',
          label: 'Landlord',
          assignee: 'landlord',
          value: null,
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
};

describe('UX-086 the send path asks the hook before the workflow is sent (criteria 1 to 3)', () => {
  let h: Harness;
  let hook: ReturnType<typeof hookServer>;
  const clients: DepClient[] = [];

  beforeAll(async () => {
    hook = hookServer();
    const url = await hook.listen();
    const policyHook = new PolicyHookClient({ url, secrets: [SECRET], timeoutMs: 500 });
    h = await startHarness('memory', { realDataPlane: true, parts: { policyHook } });
  });
  afterAll(async () => {
    for (const c of clients.splice(0)) c.terminate();
    await h?.close();
    hook.server.closeAllConnections();
    await hook.close();
  });
  beforeEach(() => {
    hook.state.mode = 'allow';
    hook.state.seen = [];
  });

  /** A labelled document with its draft workflow; the owner is connected to the room. */
  async function draft(label: string) {
    const doc = await h.createDocument({ content: sendable() });
    const etag = (await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey })).headers.get(
      'etag',
    )!;
    const patched = await h.call('PATCH', `/v1/documents/${doc}`, {
      token: h.apiKey,
      body: { classification: label },
      headers: { 'If-Match': etag },
    });
    expect(patched.status).toBe(200);
    const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-086-${uuid7()}` });
    const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
      token: owner,
      body: {
        id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9d',
        doc,
        state: 'draft',
        rev: 0,
        timeZone: 'UTC',
        participants: [
          { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1 },
          { id: 'p2', roles: ['landlord'], kind: 'signer', order: 2 },
        ],
      },
      headers: { 'if-match': '"0"' },
    });
    expect(made.status, made.text).toBe(201);
    const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
    clients.push(c);
    expect((await c.hello(owner)).t).toBe('welcome');
    expect((await c.open(1, doc)).t).toBe('ch.opened');
    return { doc, owner };
  }
  const send = (doc: string, token: string) =>
    h.call('POST', `/v1/documents/${doc}/workflow/send`, { token });
  const state = async (doc: string, token: string) =>
    (await h.call('GET', `/v1/documents/${doc}/workflow`, { token })).json.state;

  it('sends when the hook allows it, and asks with the document, the user, the action and the label (criterion 1)', async () => {
    const { doc, owner } = await draft('Internal use only');
    const r = await send(doc, owner);
    expect(r.status, r.text).toBe(200);
    expect(await state(doc, owner)).not.toBe('draft');
    expect(hook.state.seen).toHaveLength(1);
    expect(JSON.parse(hook.state.seen[0]!.body)).toMatchObject({
      document: doc,
      action: 'send',
      target: 'workflow',
      classification: 'Internal use only',
    });
  });

  it('refuses the send with the hook reason, audits it and leaves the workflow a draft (criterion 2)', async () => {
    const { doc, owner } = await draft('Confidential');
    hook.state.mode = 'deny';
    const r = await send(doc, owner);
    expect(r.status, r.text).toBe(403);
    expect(r.text).toContain('The document is classified and may not leave the tenant.');
    expect(await state(doc, owner)).toBe('draft');
    const events = await h.parts.audit!.query(h.tenant, {
      kind: 'policy_hook.refused',
      limit: 1000,
    });
    const mine = events.filter((e) => e.doc === doc);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.data).toMatchObject({ action: 'send', target: 'workflow' });
  });

  it('refuses the send when the hook does not answer, fail closed, and audits the cause (criterion 3)', async () => {
    const { doc, owner } = await draft('Confidential');
    hook.state.mode = 'slow';
    const r = await send(doc, owner);
    expect(r.status, r.text).toBe(503);
    expect(await state(doc, owner)).toBe('draft');
    const events = await h.parts.audit!.query(h.tenant, {
      kind: 'policy_hook.unanswered',
      limit: 1000,
    });
    const mine = events.filter((e) => e.doc === doc);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.data).toMatchObject({ action: 'send', cause: 'timeout' });
  });
});
