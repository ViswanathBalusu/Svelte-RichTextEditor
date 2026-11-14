/**
 * The reference host's HTTP server over its SvelteKit build (`vite build` writes `dist/host/` with
 * adapter-node's request handler). It listens on the IPv4 and the IPv6 loopback address, so that
 * the page (http://127.0.0.1:PORT) and the PDF viewer's frame (http://localhost:PORT) are two
 * origins of one server: the viewer must not share the page's origin (FE-071; 09 §9.3 rule 7).
 *
 * Run through `scripts/run.ts host`, which sets the host's environment.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

const port = Number(process.env['DOCEDIT_DEMO_HOST_PORT'] ?? process.env['PORT'] ?? 56490);
const handlerFile = join(import.meta.dirname, '..', 'dist', 'host', 'handler.js');
if (!existsSync(handlerFile)) {
  console.error(
    `${handlerFile} is missing: build the host first (pnpm --filter @docedit/reference-host build)`,
  );
  process.exit(3);
}
// adapter-node takes the request's origin from the Host header and, without a protocol header,
// assumes https. This server is the front and speaks plain HTTP on loopback, so it says so on every
// request (replacing whatever a client sent); SvelteKit's same-origin check of form posts then
// compares like with like.
const PROTOCOL_HEADER = 'x-docedit-protocol';
process.env['PROTOCOL_HEADER'] = PROTOCOL_HEADER;
const { handler } = (await import(pathToFileURL(handlerFile).href)) as { handler: Handler };

const servers = ['127.0.0.1', '::1'].map((address) => {
  const server = createServer((req, res) => {
    req.headers[PROTOCOL_HEADER] = 'http';
    handler(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  return new Promise<ReturnType<typeof createServer> | null>((resolve) => {
    server.once('error', (e) => {
      // A machine without IPv6 loopback still serves the page on 127.0.0.1.
      console.warn(`reference host: not listening on ${address}: ${(e as Error).message}`);
      resolve(null);
    });
    server.listen(port, address, () => {
      console.log(
        `reference host: http://${address.includes(':') ? `[${address}]` : address}:${port}/`,
      );
      resolve(server);
    });
  });
});
const listening = (await Promise.all(servers)).filter((s) => s !== null);
if (listening.length === 0) process.exit(1);

const stop = () => {
  for (const s of listening) {
    s.closeAllConnections();
    s.close();
  }
  setTimeout(() => process.exit(0), 2000).unref();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
