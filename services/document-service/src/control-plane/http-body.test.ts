/**
 * A body above the limit is answered with 413 and the client can read the answer, also while it is
 * still uploading (SEC-017). The server discards the rest of the body instead of resetting.
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isApiError } from './problems.ts';
import { readJsonBody, sendProblem } from './http.ts';

let server: Server | undefined;

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

async function listen(limit: number): Promise<number> {
  server = createServer((req, res) => {
    readJsonBody(req, limit).then(
      () => res.end('ok'),
      (e: unknown) => {
        if (!isApiError(e)) throw e;
        sendProblem(res, e, 'req-1');
      },
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function post(port: number, body: Buffer, chunked: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      Connection: 'close',
    };
    if (!chunked) headers['Content-Length'] = body.length;
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    // Written in pieces, so the server answers while the upload is still going.
    for (let i = 0; i < body.length; i += 65_536) req.write(body.subarray(i, i + 65_536));
    req.end();
  });
}

describe('readJsonBody refusal of a large body', () => {
  it.each([
    ['with a Content-Length', false],
    ['chunked', true],
  ])('answers 413 and lets the client read it, %s', async (_name, chunked) => {
    const port = await listen(1024);
    const body = Buffer.alloc(3_000_000, 0x20);
    for (let i = 0; i < 5; i++) expect(await post(port, body, chunked)).toBe(413);
  });
});
