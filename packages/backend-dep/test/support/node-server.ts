/**
 * Puts a test server on a real network in Node.js: an HTTP server for discovery and REST, and a
 * WebSocket server (the `ws` package) on the same port for DEP, which selects the subprotocol
 * `dep.v1` during the upgrade (05 §4). backend-dep then uses the platform's own WebSocket and
 * `fetch`, exactly as in a browser.
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { listenOnFetchablePort } from './ports.ts';
import type { MemoryServer, ServerSocket } from './memory-network.ts';

export interface Listening {
  origin: string;
  /** Close codes the server received from clients, in order. */
  readonly closes: number[];
  /** Subprotocols the server selected, in order. */
  readonly protocols: string[];
  /** Request URLs and headers the server received. */
  readonly requests: Array<{ url: string; headers: Record<string, string> }>;
  close(): Promise<void>;
}

const read = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });

/** Listens on a free port of 127.0.0.1; `make` builds the server once the origin is known. */
export async function listen(make: (origin: string) => MemoryServer): Promise<Listening> {
  let server: MemoryServer | null = null;
  const closes: number[] = [];
  const protocols: string[] = [];
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  let origin = '';
  const http = createServer((req, res) => {
    void (async () => {
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k.toLowerCase(),
          Array.isArray(v) ? v.join(', ') : (v ?? ''),
        ]),
      );
      requests.push({ url: req.url ?? '', headers });
      const body = await read(req);
      const r = await server!.http({
        method: req.method ?? 'GET',
        url: `${origin}${req.url ?? '/'}`,
        headers,
        ...(body ? { body } : {}),
      });
      res.writeHead(r.status, { ...r.headers });
      res.end(r.body ?? '');
    })().catch((e: unknown) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) => (offered.has('dep.v1') ? 'dep.v1' : false),
  });
  let ids = 0;
  http.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      protocols.push(ws.protocol);
      const s: ServerSocket = {
        id: ++ids,
        url: `${origin}${req.url ?? ''}`,
        protocols: ws.protocol ? [ws.protocol] : [],
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
        onMessage: null,
        onClose: null,
      };
      if (server!.accept(s) === null) {
        ws.close(1002, 'no subprotocol');
        return;
      }
      ws.on('message', (data, binary) => {
        if (!binary) s.onMessage?.(String(data));
      });
      ws.on('close', (code, reason) => {
        closes.push(code);
        s.onClose?.(code, String(reason));
      });
    });
  });
  await listenOnFetchablePort(http);
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  server = make(origin);
  return {
    origin,
    closes,
    protocols,
    requests,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
