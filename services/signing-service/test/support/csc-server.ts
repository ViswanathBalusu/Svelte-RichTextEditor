/**
 * A Cloud Signature Consortium API v2 server for the tests of FRW-059: the three calls the adapter
 * makes (`credentials/info`, `credentials/authorize`, `signatures/signHash`) over a key held in this
 * process. It records every request it receives, so that a test can show what the provider was
 * sent. It is a test double of the provider, not a copy of any one provider.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { KeyService } from '../../src/keyservice.ts';

export interface CscRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

export type CscFault = 'none' | 'down' | 'refuse' | 'wrong_key' | 'garbage' | 'key_disabled';

export interface CscServer {
  readonly url: string;
  readonly requests: CscRequest[];
  fault: CscFault;
  readonly authMode: 'implicit' | 'explicit' | 'oauth2code';
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export async function startCscServer(opts: {
  /** The key the provider holds, and the key it signs with when asked to fail with `wrong_key`. */
  readonly key: KeyService;
  readonly otherKey: KeyService;
  /** The credential's certificate chain, the signing certificate first (DER). */
  readonly chain: readonly Uint8Array[];
  readonly credentialId: string;
  readonly token: string;
  readonly subjectDN: string;
  readonly description?: string;
  readonly authMode?: 'implicit' | 'explicit' | 'oauth2code';
}): Promise<CscServer> {
  const authMode = opts.authMode ?? 'implicit';
  const requests: CscRequest[] = [];
  const state = { fault: 'none' as CscFault };
  const sad = 'sad-for-one-signature';
  const server: Server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      try {
        const body = await readBody(req);
        const path = (req.url ?? '').replace(/^\/csc\/v2\//, '');
        requests.push({ path, authorization: req.headers.authorization, body });
        if (req.headers.authorization !== `Bearer ${opts.token}`)
          return send(401, { error: 'invalid_request', error_description: 'bad token' });
        if (state.fault === 'down') return send(503, { error: 'server_error' });
        if (state.fault === 'refuse') return send(403, { error: 'access_denied' });
        if (state.fault === 'garbage') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end('not json');
        }
        if (body['credentialID'] !== opts.credentialId)
          return send(400, { error: 'invalid_request', error_description: 'credential' });
        if (path === 'credentials/info')
          return send(200, {
            description: opts.description,
            key: {
              status: state.fault === 'key_disabled' ? 'disabled' : 'enabled',
              algo: ['1.2.840.113549.1.1.11'],
              len: 3072,
            },
            cert: {
              status: 'valid',
              certificates: opts.chain.map((c) => Buffer.from(c).toString('base64')),
              subjectDN: opts.subjectDN,
            },
            authMode,
          });
        if (path === 'credentials/authorize') {
          const hashes = body['hash'];
          if (!Array.isArray(hashes) || hashes.length !== 1)
            return send(400, { error: 'invalid_request' });
          return send(200, { SAD: sad });
        }
        if (path === 'signatures/signHash') {
          const hashes = body['hash'];
          if (authMode === 'explicit' && body['SAD'] !== sad)
            return send(401, { error: 'invalid_request', error_description: 'SAD' });
          if (!Array.isArray(hashes) || hashes.length !== 1 || typeof hashes[0] !== 'string')
            return send(400, { error: 'invalid_request' });
          const digest = new Uint8Array(Buffer.from(hashes[0], 'base64'));
          const signer = state.fault === 'wrong_key' ? opts.otherKey : opts.key;
          const sig = await signer.signDigest('SHA-256', digest);
          return send(200, { signatures: [Buffer.from(sig).toString('base64')] });
        }
        return send(404, { error: 'not_found' });
      } catch {
        send(500, { error: 'server_error' });
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${addr.port}/csc/v2`,
    requests,
    get fault() {
      return state.fault;
    },
    set fault(f: CscFault) {
      state.fault = f;
    },
    authMode,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
