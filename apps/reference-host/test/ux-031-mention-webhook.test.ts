// UX-031 criterion 4, end to end in the reference host: a comment with a mention is posted to the
// real document service, the service raises `dep.comment.mentioned`, its own dispatcher signs and
// sends it through its egress proxy to the host's receiver on a real HTTP server, and the host
// notifies the person the event names.
//
// The service runs with webhooks on and with its test-mode egress allowance for the loopback address
// of the receiver (`webhooks.testAllow`, DOCEDIT_TEST_WEBHOOK_ALLOW; ADR 0316 proposal 2, accepted
// with owner decisions 196 to 220). Nothing about the egress rules is changed for a real deployment.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenFor } from '../src/lib/server/tokens.ts';
import { composeWebhookEndpoint } from '../src/lib/server/webhook-endpoint.ts';
import { MemoryNotificationSink } from '../src/lib/server/webhook-notifications.ts';
import { serviceTemplateContent } from '../src/lib/server/documents.ts';
import { startHarness, type Harness } from './support.ts';

const BLOCK = 'pLeaseTitle00001';

async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('UX-031 criterion 4: dep.comment.mentioned reaches the host', () => {
  let h: Harness;
  let receiver: Server;
  let doc = '';
  const sink = new MemoryNotificationSink();
  const secrets: string[] = [];
  const hits: Array<{ status: number }> = [];

  beforeAll(async () => {
    h = await startHarness({
      serviceConfig: {
        environment: 'test',
        testMode: true,
        webhooks: {
          rejectedWindowMs: 1000,
          rejectedMax: 5,
          timeoutMs: 2000,
          maxRedirects: 0,
          source: null,
          testAllow: ['127.0.0.1'],
        },
      },
    });
    // The host's receiver behind a real HTTP server, as the route `POST /webhooks/dep` serves it.
    const endpoint = composeWebhookEndpoint({ secrets: () => secrets, sink });
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers))
          if (typeof v === 'string') headers.set(k, v);
        const body = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(chunks));
        const outcome = endpoint.receiver.receive(headers, body);
        hits.push({ status: outcome.status });
        if (outcome.status === 202 && !outcome.duplicate) endpoint.schedule();
        res.writeHead(outcome.status);
        res.end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    const port = (receiver.address() as AddressInfo).port;

    // The host's subscription, made with its service credential; the secret is shown once.
    const made = await fetch(`${h.rest}/webhooks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${h.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `http://127.0.0.1:${port}/webhooks/dep`,
        events: ['dep.comment.mentioned.v1'],
      }),
    });
    expect(made.status, await made.clone().text()).toBe(201);
    secrets.push(((await made.json()) as { secret: string }).secret);

    const st = h.host.seed.serviceTemplates![0]!;
    const created = await h.host.service.createDocument(
      { content: await serviceTemplateContent(h.host.seedDir, st), title: 'Lease (mention)' },
      'ux031-mention',
      'u-olivia',
    );
    doc = created.id;
    await h.host.catalogue.put({
      id: doc,
      externalId: 'ux031-mention',
      title: 'Lease (mention)',
      template: 'lease',
      createdBy: 'u-olivia',
      createdAt: new Date().toISOString(),
      roles: { 'u-olivia': 'owner', 'u-ada': 'editor', 'u-bob': 'viewer' },
      accessSince: {},
      deletedAt: null,
    });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await new Promise<void>((r) => (receiver ? receiver.close(() => r()) : r()));
  });

  /** Ada's token, as the host's token route gives it. */
  async function adaToken(): Promise<string> {
    const issued = await tokenFor(h.host, h.host.directory.user('u-ada')!, doc);
    return issued!.token;
  }

  const post = (token: string, path: string, body: unknown) =>
    fetch(`${h.rest}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('notifies the person the service names, with the comment and the thread, once', async () => {
    const token = await adaToken();
    const res = await post(token, `/documents/${doc}/threads`, {
      target: { block: BLOCK },
      comment: {
        body: [
          { type: 'text', text: 'Please check this, ' },
          { type: 'mention', principal: 'user:u-bob' },
        ],
      },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const thread = (await res.json()) as { id: string; comments?: Array<{ id: string }> };

    await until('the host to be told', () => sink.sent.length >= 1);
    const [n] = sink.sent;
    expect(n).toMatchObject({
      type: 'dep.comment.mentioned.v1',
      document: doc,
      principal: 'user:u-bob',
      thread: thread.id,
    });
    expect(n?.comment).toEqual(expect.any(String));
    // The delivery was verified with the subscription's secret and answered 202 at once.
    expect(hits.every((x) => x.status === 202)).toBe(true);
    expect(sink.sent).toHaveLength(1);
  });

  it('sends nothing for a comment without a mention', async () => {
    const before = sink.sent.length;
    const token = await adaToken();
    const res = await post(token, `/documents/${doc}/threads`, {
      target: { block: BLOCK },
      comment: { body: [{ type: 'text', text: 'No one is mentioned here.' }] },
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(sink.sent).toHaveLength(before);
  });
});
