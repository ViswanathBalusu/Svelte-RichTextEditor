/**
 * A small SMTP client for the reference host's notifications (UX-098). It speaks plain SMTP
 * (RFC 5321) to a relay on the local machine: the development mail sink of the demo stack. There
 * is no TLS and no authentication, so it is not a way to send real mail; a real host uses its own
 * mail service. One message per connection, text only, UTF-8 (the body is sent as base64).
 */
import { createConnection, type Socket } from 'node:net';

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Sent as `Message-ID` (without angle brackets); a random one is made when absent. */
  messageId?: string;
}

export interface SmtpTarget {
  host: string;
  port: number;
  /** Gives up after this many milliseconds; default 10 000. */
  timeoutMs?: number;
  /** The name sent in EHLO; default `localhost`. */
  clientName?: string;
}

/** An address as this client accepts it: no whitespace, no angle brackets, one `@`. */
export function isSendableAddress(value: string): boolean {
  return /^[^\s<>@"]+@[^\s<>@"]+$/.test(value);
}

/** A header value with no line break; non-ASCII text becomes an RFC 2047 encoded word. */
export function headerValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('a header value cannot hold a line break');
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** The message as sent in DATA, with CRLF line ends. */
export function formatMessage(m: MailMessage, now: Date = new Date()): string {
  if (!isSendableAddress(m.from) || !isSendableAddress(m.to))
    throw new Error('the sender and the recipient must each be one plain address');
  const id = m.messageId ?? `${crypto.randomUUID()}@${m.from.split('@')[1] ?? 'localhost'}`;
  const body = Buffer.from(m.text, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${headerValue(m.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${headerValue(id)}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

/** Reads SMTP replies (possibly several lines each) from a socket, one at a time. */
class Replies {
  #buffer = '';
  #waiting: {
    resolve: (r: { code: number; text: string }) => void;
    reject: (e: Error) => void;
  } | null = null;
  #failure: Error | null = null;

  constructor(socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.#buffer += chunk;
      this.#settle();
    });
    const fail = (e: Error) => {
      this.#failure = e;
      this.#waiting?.reject(e);
      this.#waiting = null;
    };
    socket.on('error', fail);
    socket.on('close', () => {
      fail(new Error('the mail relay closed the connection'));
    });
  }

  next(): Promise<{ code: number; text: string }> {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
      this.#settle();
    });
  }

  #settle(): void {
    if (!this.#waiting) return;
    const lines = this.#buffer.split('\r\n');
    // A reply ends with a line `ddd text` (a space after the code); `ddd-text` continues it.
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} |^\d{3}$/.test(lines[i] ?? '')) {
        const text = lines.slice(0, i + 1).join('\n');
        this.#buffer = lines.slice(i + 1).join('\r\n');
        const w = this.#waiting;
        this.#waiting = null;
        w.resolve({ code: Number(text.slice(0, 3)), text });
        return;
      }
    }
  }
}

/** Sends one message. Rejects with the relay's reply text when it refuses any step. */
export async function sendMail(target: SmtpTarget, message: MailMessage): Promise<void> {
  const data = formatMessage(message);
  const socket = createConnection({ host: target.host, port: target.port });
  const timer = setTimeout(() => {
    socket.destroy(new Error('the mail relay did not answer in time'));
  }, target.timeoutMs ?? 10_000);
  const replies = new Replies(socket);
  const expect = async (codes: readonly number[], what: string): Promise<void> => {
    const r = await replies.next();
    if (!codes.includes(r.code)) throw new Error(`the mail relay refused ${what}: ${r.text}`);
  };
  const command = async (line: string, codes: readonly number[], what: string): Promise<void> => {
    socket.write(`${line}\r\n`);
    await expect(codes, what);
  };
  try {
    await expect([220], 'the connection');
    await command(`EHLO ${target.clientName ?? 'localhost'}`, [250], 'EHLO');
    await command(`MAIL FROM:<${message.from}>`, [250], 'the sender');
    await command(`RCPT TO:<${message.to}>`, [250, 251], 'the recipient');
    await command('DATA', [354], 'DATA');
    // Dot-stuffing: a line that starts with a dot gets another (RFC 5321 section 4.5.2).
    socket.write(`${data.replace(/^\./gm, '..')}\r\n.\r\n`);
    await expect([250], 'the message');
    socket.write('QUIT\r\n');
  } finally {
    clearTimeout(timer);
    socket.end();
  }
}
