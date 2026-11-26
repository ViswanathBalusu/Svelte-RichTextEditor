// E-mail notifications of the reference host (UX-098 criterion 3): the service's own dispatcher
// signs a `dep.comment.mentioned` or `dep.task.assigned` delivery, the host's receiver verifies it,
// and the mail sink sends one message to the address the host's directory holds for the person,
// through the SMTP client to a relay that the test runs on an ephemeral port.
import { createServer, type Server } from 'node:net';
import { generateSecret } from '../../../services/document-service/src/control-plane/webhook-signing.ts';
import {
  MemoryDeliveryStore,
  WebhookDispatcher,
} from '../../../services/document-service/src/control-plane/webhook-dispatcher.ts';
import type { Transport } from '../../../services/document-service/src/control-plane/webhook-egress.ts';
import {
  MemorySubscriptionStore,
  type SubscriptionRecord,
} from '../../../services/document-service/src/control-plane/webhook-subscriptions.ts';
import type { DepEvent } from '../../../services/document-service/src/control-plane/events.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { Directory } from '../src/lib/server/directory.ts';
import { formatMessage, headerValue, sendMail } from '../src/lib/server/smtp.ts';
import { composeWebhookEndpoint } from '../src/lib/server/webhook-endpoint.ts';
import { documentLink, mailSink } from '../src/lib/server/webhook-notifications.ts';

const TENANT = 't-host';
const DOC = '0192f0a1-0000-7000-8000-000000000001';
const T0 = 1_800_000_000_000;
const PUBLIC_URL = 'http://127.0.0.1:56490';

const directory = new Directory(
  [
    {
      sub: 'u-olivia',
      name: 'Olivia Okafor',
      groups: ['g-owners'],
      email: 'olivia@demo.example.test',
      about: '',
    },
    {
      sub: 'u-ada',
      name: 'Ada Lindqvist',
      groups: ['g-finance'],
      email: 'ada@demo.example.test',
      about: '',
    },
    {
      sub: 'u-bob',
      name: 'Bob Mensah',
      groups: ['g-finance'],
      email: 'bob@demo.example.test',
      about: '',
    },
    { sub: 'u-noaddr', name: 'No Address', groups: [], about: '' },
  ],
  [
    { id: 'g-owners', name: 'Owners' },
    { id: 'g-finance', name: 'Finance' },
  ],
);

interface Received {
  from: string;
  to: string[];
  data: string;
  commands: string[];
}

/** A relay that accepts every message, or refuses the recipient `refuse` with 550. */
async function relay(
  refuse = '',
): Promise<{ port: number; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let current: Received = { from: '', to: [], data: '', commands: [] };
    socket.write('220 test relay\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(current);
          current = { from: '', to: [], data: '', commands: [] };
          socket.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        current.commands.push(line.split(' ')[0] ?? '');
        if (line.startsWith('EHLO')) socket.write('250-test relay\r\n250 8BITMIME\r\n');
        else if (line.startsWith('MAIL FROM:')) {
          current.from = line.slice(10);
          socket.write('250 ok\r\n');
        } else if (line.startsWith('RCPT TO:')) {
          const to = line.slice(8);
          if (refuse && to.includes(refuse)) socket.write('550 no such user\r\n');
          else {
            current.to.push(to);
            socket.write('250 ok\r\n');
          }
        } else if (line === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('500 what\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function newRelay(refuse = ''): ReturnType<typeof relay> {
  const r = await relay(refuse);
  open.push(r.close);
  return r;
}

/** The text of a message as the relay got it: the headers, then the base64 body decoded. */
function bodyOf(data: string): string {
  const [, body = ''] = data.split('\r\n\r\n');
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('UX-098 the SMTP client', () => {
  it('sends one message with the sender, the recipient and a UTF-8 body', async () => {
    const r = await newRelay();
    await sendMail(
      { host: '127.0.0.1', port: r.port },
      {
        from: 'a@demo.example.test',
        to: 'b@demo.example.test',
        subject: 'Prüfung',
        text: 'Line\n.\nGrüße',
      },
    );
    expect(r.received).toHaveLength(1);
    expect(r.received[0]?.from).toBe('<a@demo.example.test>');
    expect(r.received[0]?.to).toEqual(['<b@demo.example.test>']);
    expect(r.received[0]?.data).toContain('Subject: =?UTF-8?B?');
    expect(bodyOf(r.received[0]?.data ?? '')).toBe('Line\n.\nGrüße');
  });

  it('rejects with the relay reply when the recipient is refused', async () => {
    const r = await newRelay('nobody');
    await expect(
      sendMail(
        { host: '127.0.0.1', port: r.port },
        { from: 'a@demo.example.test', to: 'nobody@demo.example.test', subject: 's', text: 't' },
      ),
    ).rejects.toThrow(/refused the recipient: 550/);
    expect(r.received).toHaveLength(0);
  });

  it('refuses a line break in a header and an address that is not one plain address', () => {
    expect(() => headerValue('x\r\nBcc: someone@else.test')).toThrow(/line break/);
    expect(() =>
      formatMessage({
        from: 'a@x.test',
        to: 'b@x.test>\r\nRCPT TO:<c@x.test',
        subject: 's',
        text: 't',
      }),
    ).toThrow(/plain address/);
  });

  it('rejects when nothing listens', async () => {
    const r = await newRelay();
    const port = r.port;
    await r.close();
    open.length = 0;
    await expect(
      sendMail(
        { host: '127.0.0.1', port, timeoutMs: 2000 },
        { from: 'a@x.test', to: 'b@x.test', subject: 's', text: 't' },
      ),
    ).rejects.toThrow();
  });
});

describe('UX-098 the directory holds the addresses', () => {
  it('gives the address of a person, the members of a group, and nothing for the unknown', () => {
    expect(directory.recipients('user:u-ada').map((p) => p.email)).toEqual([
      'ada@demo.example.test',
    ]);
    expect(directory.recipients('group:g-finance').map((p) => p.sub)).toEqual(['u-ada', 'u-bob']);
    expect(directory.recipients('user:u-noaddr')).toEqual([]);
    expect(directory.recipients('user:u-nobody')).toEqual([]);
    expect(directory.recipients('group:g-none')).toEqual([]);
    expect(directory.recipients('whatever')).toEqual([]);
  });

  it('never gives an address through resolveUsers or searchPrincipals', () => {
    expect(JSON.stringify(directory.resolve(['u-ada']))).not.toContain('@');
    expect(JSON.stringify(directory.search('', ['user', 'group'], 20))).not.toContain('@');
  });
});

describe('UX-098 the mail for a mention and a task, from a signed delivery', () => {
  async function pipeline(smtpPort: number) {
    const secret = generateSecret();
    const endpoint = composeWebhookEndpoint({
      secrets: () => [secret],
      sink: mailSink({
        smtp: { host: '127.0.0.1', port: smtpPort },
        directory: () => Promise.resolve(directory),
        publicUrl: PUBLIC_URL,
        from: 'notifications@demo.example.test',
      }),
      now: () => Math.floor(T0 / 1000),
    });
    const transport: Transport = {
      deliver(req) {
        const outcome = endpoint.receiver.receive(new Headers({ ...req.headers }), req.body);
        if (outcome.status === 202 && !outcome.duplicate) endpoint.schedule();
        return Promise.resolve({ ok: true, status: outcome.status, hops: 0 });
      },
    };
    const subs = new MemorySubscriptionStore();
    const sub: SubscriptionRecord = {
      id: 'sub-1',
      tenant: TENANT,
      url: 'https://host.test/webhooks/dep',
      events: ['dep.comment.mentioned.v1', 'dep.task.assigned.v1'],
      secrets: [secret],
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    } as SubscriptionRecord;
    await subs.insert(sub);
    const dispatcher = new WebhookDispatcher({
      subscriptions: subs,
      deliveries: new MemoryDeliveryStore(),
      transport,
      source: 'https://docs.example.test/events',
      now: () => T0,
      rejectedThrottle: { windowMs: 60_000, max: 3 },
    });
    const raise = async (event: DepEvent) => {
      await dispatcher.raise(event);
      await dispatcher.drain();
      await endpoint.settled();
    };
    return { raise };
  }

  const event = (type: string, data: Record<string, unknown>): DepEvent =>
    ({ type, tenant: TENANT, subject: DOC, data, time: T0 }) as DepEvent;

  it('sends the mentioned person one e-mail with a link to the document and the comment', async () => {
    const r = await newRelay();
    const p = await pipeline(r.port);
    await p.raise(
      event('dep.comment.mentioned.v1', {
        comment: 'c-77',
        thread: 't-9',
        principal: 'user:u-ada',
        seq: 5,
      }),
    );
    expect(r.received).toHaveLength(1);
    const mail = r.received[0];
    expect(mail?.to).toEqual(['<ada@demo.example.test>']);
    const text = bodyOf(mail?.data ?? '');
    expect(text).toContain('mentioned you in a comment');
    expect(text).toContain(`${PUBLIC_URL}/as/u-ada/docs/${DOC}?thread=t-9&comment=c-77`);
    // No token, no secret, no key in the mail.
    expect(text).not.toMatch(/token|secret|whsec|bearer/i);
  });

  it('sends a task assignment to the assignee, and the address never came from the event', async () => {
    const r = await newRelay();
    const p = await pipeline(r.port);
    await p.raise(event('dep.task.assigned.v1', { thread: 't-9', assignee: 'user:u-bob', seq: 6 }));
    expect(r.received.map((m) => m.to)).toEqual([['<bob@demo.example.test>']]);
    expect(bodyOf(r.received[0]?.data ?? '')).toContain('was assigned to you');
  });

  it('sends one mail to each member of a group', async () => {
    const r = await newRelay();
    const p = await pipeline(r.port);
    const mention = event('dep.comment.mentioned.v1', {
      comment: 'c-1',
      thread: 't-1',
      principal: 'group:g-finance',
      seq: 1,
    });
    await p.raise(mention);
    expect(r.received.map((m) => m.to[0]).sort()).toEqual([
      '<ada@demo.example.test>',
      '<bob@demo.example.test>',
    ]);
  });

  it('sends nothing for a person without an address or an event that names nobody', async () => {
    const r = await newRelay();
    const p = await pipeline(r.port);
    await p.raise(
      event('dep.comment.mentioned.v1', {
        comment: 'c-1',
        thread: 't-1',
        principal: 'user:u-noaddr',
        seq: 1,
      }),
    );
    await p.raise(event('dep.comment.mentioned.v1', { seq: 2 }));
    expect(r.received).toHaveLength(0);
  });
});

describe('UX-098 the link', () => {
  it('names the document and the comment and carries nothing else', () => {
    expect(documentLink(PUBLIC_URL, 'u-ada', { document: DOC, comment: 'c 1', thread: null })).toBe(
      `${PUBLIC_URL}/as/u-ada/docs/${DOC}?comment=c+1`,
    );
    expect(documentLink(PUBLIC_URL, 'u-ada', { document: DOC, comment: null, thread: null })).toBe(
      `${PUBLIC_URL}/as/u-ada/docs/${DOC}`,
    );
  });
});
