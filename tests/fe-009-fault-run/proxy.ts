/**
 * The network between the browser tabs and the document service in the fault run (FE-009 criterion
 * 7): a small HTTP and WebSocket relay on a loopback port of its own.
 *
 * - The tabs' `endpoint` is the relay, so it stays the same when the service process is killed and
 *   started again on another port (`setTarget`).
 * - `dropAll()` destroys every open socket, on both sides, with no close handshake: a dropped
 *   connection as a tab sees it (WebSocket close code 1006).
 * - REST answers get the CORS headers a page on another origin needs; the service itself is not
 *   changed (as tests/V-FE-113-128 does with Playwright's routing).
 *
 * Nothing here is part of the product.
 */
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type Socket } from 'node:net';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization,content-type,if-match,if-none-match,idempotency-key,traceparent',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-expose-headers': 'etag,location,content-type,retry-after',
  'access-control-max-age': '600',
};

export interface Relay {
  /** `http://127.0.0.1:<port>`: what the tabs use as `endpoint`. */
  readonly url: string;
  /** Where requests go from now on: the service's own URL, or null while no service runs. */
  setTarget(url: string | null): void;
  /** Destroys every open connection, HTTP and WebSocket; returns how many WebSockets were open. */
  dropAll(): number;
  /** The WebSockets relayed so far, and how many of them the relay dropped. */
  counts(): { sockets: number; dropped: number; open: number };
  close(): Promise<void>;
}

export async function startRelay(): Promise<Relay> {
  let target: URL | null = null;
  /** Every socket the relay holds: the tab's side and the service's side of each connection. */
  const sockets = new Set<Socket>();
  /** The tab's side of each open WebSocket. */
  const webSockets = new Set<Socket>();
  let relayed = 0;
  let dropped = 0;

  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }
    const to = target;
    if (to === null) {
      // No service: the connection is cut, as it is when nothing listens.
      req.socket.destroy();
      return;
    }
    const upstream = request(
      {
        host: to.hostname,
        port: to.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: to.host, connection: 'close' },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, { ...answer.headers, ...CORS });
        answer.pipe(res);
      },
    );
    upstream.on('socket', (s) => track(s));
    upstream.on('error', () => {
      // The service went away under the request: the tab sees a failed request.
      res.destroy();
    });
    req.pipe(upstream);
  });
  server.on('connection', (socket) => track(socket));

  server.on('upgrade', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const to = target;
    if (to === null) {
      client.destroy();
      return;
    }
    const upstream = connect(Number(to.port), to.hostname);
    track(upstream);
    relayed++;
    webSockets.add(client);
    const end = (): void => {
      webSockets.delete(client);
      client.destroy();
      upstream.destroy();
    };
    client.once('close', end);
    upstream.once('close', end);
    client.on('error', end);
    upstream.on('error', end);
    upstream.once('connect', () => {
      // The request as it arrived, with the service's own host; the handshake's answer and every
      // frame after it pass through unchanged.
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        const value = name.toLowerCase() === 'host' ? to.host : req.rawHeaders[i + 1]!;
        lines.push(`${name}: ${value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0: the system picks a free port (the run never uses a fixed one).
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the relay has no port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    setTarget(url) {
      target = url === null ? null : new URL(url);
    },
    dropAll() {
      const open = webSockets.size;
      dropped += open;
      for (const socket of [...sockets]) socket.destroy();
      return open;
    },
    counts: () => ({ sockets: relayed, dropped, open: webSockets.size }),
    async close() {
      for (const socket of [...sockets]) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
