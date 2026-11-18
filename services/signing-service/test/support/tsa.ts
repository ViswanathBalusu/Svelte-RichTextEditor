/**
 * A local RFC 3161 time-stamp authority for tests (spike S8; owner decision 223). It is an HTTP
 * server on the loopback interface that answers `application/timestamp-query` with the response of
 * `openssl ts -reply`, using the test authority certificate from `pki.ts`. The responder is
 * OpenSSL's, not the code under test, so the tokens are made by a separate implementation.
 *
 * It listens on 127.0.0.1 only and has no connection to anything outside the machine. Time comes
 * from the machine's clock.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openssl, type TestPki } from './pki.ts';

const fwd = (p: string): string => p.replace(/\\/g, '/');

export interface TestTsa {
  url: string;
  /** How many requests it answered. */
  count(): number;
  stop(): Promise<void>;
}

export async function startTestTsa(pki: TestPki): Promise<TestTsa> {
  const work = mkdtempSync(join(tmpdir(), 'docedit-spk021-tsa-'));
  const d = fwd(pki.tsaDir);
  writeFileSync(join(work, 'tsa.serial'), '0001\n');
  const cnf = `
[tsa]
default_tsa = tsa_config1
[tsa_config1]
serial = ${fwd(work)}/tsa.serial
crypto_device = builtin
signer_cert = ${d}/tsa.crt
certs = ${d}/tsa-chain.pem
signer_key = ${d}/tsa.key
signer_digest = sha256
default_policy = 2.999.1
digests = sha256, sha384, sha512
accuracy = secs:1
ordering = no
tsa_name = yes
ess_cert_id_chain = yes
ess_cert_id_alg = sha256
`;
  writeFileSync(join(work, 'tsa.cnf'), cnf);
  let answered = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      // OpenSSL keeps a serial file, so requests are answered one at a time.
      queue = queue.then(() => {
        try {
          if (req.method !== 'POST') throw new Error('POST only');
          writeFileSync(join(work, 'q.tsq'), Buffer.concat(chunks));
          openssl(work, [
            'ts',
            '-reply',
            '-config',
            'tsa.cnf',
            '-section',
            'tsa_config1',
            '-queryfile',
            'q.tsq',
            '-out',
            'r.tsr',
          ]);
          answered++;
          res.writeHead(200, {
            'content-type': 'application/timestamp-reply',
            connection: 'close',
          });
          res.end(readFileSync(join(work, 'r.tsr')));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(String(e));
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${addr.port}/tsa`,
    count: () => answered,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(work, { recursive: true, force: true });
    },
  };
}
