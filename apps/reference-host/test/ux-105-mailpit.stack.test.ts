// UX-105 criteria 1, 2, 4 and 5 against the running demo stack (the pattern of
// ux-098-mailpit.stack.test.ts): the owner uses "send for completion" in the real reference host;
// the real document service raises `participant_activated`, its dispatcher signs and sends it
// through the egress proxy to the host's receiver, and the host mails the first participant's
// invitation to the real Mailpit container. Nothing is called by hand between the form and the mail.
//
//   pwsh -NoProfile -File apps/reference-host/scripts/stack.ps1 up -NoExport
//   $env:DOCEDIT_DEMO_REUSE = '1'   (and the stack's DOCEDIT_DEMO_* ports, project and data directory)
//   pnpm exec vitest run --project node apps/reference-host/test/ux-105-mailpit.stack.test.ts
//
// It skips, with the reason, when DOCEDIT_DEMO_REUSE is not set. It deletes the messages and the
// document it made. The same flow with the exception removed is refused (no mail, and the
// dispatcher's delivery row says `loopback`): ux-105-webhook-delivery.test.ts, in the Node.js run,
// because the stack's service cannot be restarted from inside a test. Here the exception's limit is
// checked on the real service: a second loopback target is refused and the log says so.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  dataDir,
  endpoints,
  readSecrets,
  setting,
  stackSettings,
  WEBHOOK_EVENTS,
} from '../scripts/lib/stack.ts';

const ENABLED = process.env['DOCEDIT_DEMO_REUSE'] === '1';
const RUN = Date.now().toString(36);
const OWNER = 'u-olivia';

interface Summary {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

describe.skipIf(!ENABLED)('the invitation reaches the mail sink (UX-105)', () => {
  const s = stackSettings();
  const ends = endpoints(s);
  const mailApi = `http://127.0.0.1:${setting(s, 'DOCEDIT_DEMO_MAIL_UI_PORT')}/api/v1`;
  const sentIds: string[] = [];
  const docs: string[] = [];
  const subscriptions: string[] = [];
  const servers: Server[] = [];
  let cookie = '';

  /** A form post to the host, as the browser makes it: the origin is the host's own. */
  async function post(
    path: string,
    fields: Array<[string, string]>,
    as: string = cookie,
  ): Promise<Response> {
    return fetch(`${ends.hostUrl}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Origin: ends.hostUrl,
        // A browser form asks for a page; without this SvelteKit answers actions in JSON.
        Accept: 'text/html',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(as ? { Cookie: as } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  async function service(method: string, path: string, body?: unknown): Promise<Response> {
    const secrets = await readSecrets(dataDir());
    return fetch(`${ends.serviceUrl}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secrets.apiKey.credential}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method === 'DELETE' ? { 'If-Match': '*' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function find(query: string): Promise<Summary[]> {
    for (let i = 0; i < 80; i++) {
      const res = await fetch(`${mailApi}/search?query=${encodeURIComponent(query)}`);
      const body = (await res.json()) as { messages: Summary[] };
      if (body.messages.length > 0) return body.messages;
      await new Promise((r) => setTimeout(r, 250));
    }
    return [];
  }

  afterAll(async () => {
    for (const id of sentIds)
      await fetch(`${mailApi}/messages`, { method: 'DELETE', body: JSON.stringify({ IDs: [id] }) });
    for (const id of subscriptions) await service('DELETE', `/webhooks/${id}`);
    for (const id of docs) await post(`/as/${OWNER}?/delete`, [['id', id]]);
    await Promise.all(servers.map((v) => new Promise<void>((r) => v.close(() => r()))));
  });

  it('holds a subscription for the host with the workflow, comment and task events', async () => {
    const res = await service('GET', '/webhooks');
    const items = ((await res.json()) as { items: Array<{ url: string; events: string[] }> }).items;
    const mine = items.filter((i) => i.url === `${ends.hostUrl}/webhooks/dep`);
    expect(mine).toHaveLength(1);
    expect([...(mine[0]?.events ?? [])].sort()).toEqual([...WEBHOOK_EVENTS].sort());
  });

  it('mails the first participant an invitation when the owner sends a form document', async () => {
    const signin = await post('/?/signin', [['sub', OWNER]]);
    expect(signin.status).toBe(303);
    cookie = (signin.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ');
    expect(cookie).not.toBe('');

    const catalogue = JSON.parse(await readFile(join(dataDir(), 'catalogue.json'), 'utf8')) as {
      templates: Array<{ id: string; key: string }>;
    };
    const lease = catalogue.templates.find((t) => t.key === 'lease');
    expect(lease, 'the seeded lease template').toBeDefined();
    const created = await post(`/as/${OWNER}/templates?/use`, [
      ['template', lease!.id],
      ['title', `Lease (UX-105 ${RUN})`],
    ]);
    expect(created.status).toBe(303);
    const doc = /\/docs\/([0-9a-f-]{36})/.exec(created.headers.get('location') ?? '')?.[1];
    expect(doc, 'the new document').toBeDefined();
    docs.push(doc!);

    const tess = `tess-${RUN}@people.example.test`;
    const sent = await post(`/as/${OWNER}/docs/${doc}/send?/send`, [
      ['role', 'tenant'],
      ['name', 'Tess Tenant'],
      ['email', tess],
      ['kind', 'filler'],
      ['order', '1'],
      ['role', 'landlord'],
      ['name', 'Larry Landlord'],
      ['email', `larry-${RUN}@people.example.test`],
      ['kind', 'signer'],
      ['order', '2'],
    ]);
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain('Sent.');

    const mails = await find(`to:${tess}`);
    expect(mails, 'the invitation arrives in Mailpit').toHaveLength(1);
    sentIds.push(...mails.map((m) => m.ID));
    expect(mails[0]?.Subject).toContain('You are asked to complete');
    const full = (await (await fetch(`${mailApi}/message/${mails[0]?.ID}`)).json()) as {
      Text: string;
    };
    expect(full.Text).toMatch(new RegExp(`${ends.hostUrl}/fill/[A-Za-z0-9_-]{20,}`));
    expect(full.Text).not.toMatch(/token|bearer|eyJ/i);
    // The second participant is not invited until the first has finished.
    await new Promise((r) => setTimeout(r, 1000));
    const larry = await fetch(
      `${mailApi}/search?query=${encodeURIComponent(`to:larry-${RUN}@people.example.test`)}`,
    );
    expect(((await larry.json()) as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it('mails the person a comment mentions (criterion 6, the gap named in UX-098)', async () => {
    // Ada signs in, makes a lease from the gallery and comments on it, mentioning Bob. The host's
    // own token route gives her token; the thread is saved through the real service.
    const signin = await post('/?/signin', [['sub', 'u-ada']]);
    expect(signin.status).toBe(303);
    const adaCookie = (signin.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ');
    const catalogue = JSON.parse(await readFile(join(dataDir(), 'catalogue.json'), 'utf8')) as {
      templates: Array<{ id: string; key: string }>;
    };
    const created = await post(
      '/as/u-ada/templates?/use',
      [
        ['template', catalogue.templates.find((t) => t.key === 'lease')!.id],
        ['title', `Lease (UX-105 mention ${RUN})`],
      ],
      adaCookie,
    );
    expect(created.status).toBe(303);
    const doc = /\/docs\/([0-9a-f-]{36})/.exec(created.headers.get('location') ?? '')?.[1];
    expect(doc).toBeDefined();
    const tokenRes = await fetch(`${ends.hostUrl}/as/u-ada/api/token`, {
      method: 'POST',
      headers: { Origin: ends.hostUrl, 'Content-Type': 'application/json', Cookie: adaCookie },
      body: JSON.stringify({ docId: doc }),
    });
    expect(tokenRes.status).toBe(200);
    const token = ((await tokenRes.json()) as { token: string }).token;
    const thread = await fetch(`${ends.serviceUrl}/v1/documents/${doc}/threads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: { block: 'pLeaseTitle00001' },
        comment: {
          body: [
            { type: 'text', text: `Please check this (${RUN}), ` },
            { type: 'mention', principal: 'user:u-bob' },
          ],
        },
      }),
    });
    expect(thread.status, await thread.clone().text()).toBe(201);
    const threadId = ((await thread.json()) as { id: string }).id;
    const mails = await find(`to:bob@demo.example.test ${threadId}`);
    expect(mails, 'the mention e-mail arrives in Mailpit').toHaveLength(1);
    sentIds.push(...mails.map((m) => m.ID));
    expect(mails[0]?.Subject).toBe('You were mentioned in a comment');
    const full = (await (await fetch(`${mailApi}/message/${mails[0]?.ID}`)).json()) as {
      Text: string;
    };
    expect(full.Text).toContain(`/as/u-bob/docs/${doc}?thread=${threadId}`);
    expect(full.Text).not.toMatch(/token|bearer|eyJ/i);
    await post('/as/u-ada?/delete', [['id', doc!]], adaCookie);
  });

  it('reaches the host and no other loopback target: a second subscription is refused', async () => {
    let hits = 0;
    const other = createServer((req, res) => {
      hits += 1;
      req.resume();
      res.writeHead(204).end();
    });
    servers.push(other);
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    const port = (other.address() as AddressInfo).port;
    const created = await service('POST', '/webhooks', {
      url: `http://127.0.0.1:${port}/hook`,
      events: ['dep.workflow.completed.v1'],
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    subscriptions.push(id);
    const ping = await service('POST', `/webhooks/${id}/ping`);
    expect(ping.status).toBe(202);
    const log = join(dataDir(), 'logs', 'document-service.log');
    let refused = false;
    for (let i = 0; i < 40 && !refused; i++) {
      const lines = (await readFile(log, 'utf8')).split('\n');
      refused = lines.some(
        (l) => l.includes('webhook.attempt.failed') && l.includes('"code":"loopback"'),
      );
      if (!refused) await new Promise((r) => setTimeout(r, 250));
    }
    expect(refused, 'the service logged the refusal').toBe(true);
    expect(hits).toBe(0);
  });
});
