// PRO-096 criterion 1 against the real object store (lane V-PRO-086-102; fixed in V4 group 1).
// The fixture server answers `POST /documents/{d}/assets` with a pre-signed PUT address of the
// S3-compatible store of the test environment (Versity S3 Gateway, infra/containers; FND-010),
// signed by the asset worker's own S3 code for the declared size. backend-dep's PUT goes to that
// address unchanged, with the headers backend-dep itself chose, and the bytes are read back from
// the store. Only the control plane is answered by FileServer and the mock DEP server.
// Node.js only: it needs the container (`pwsh -NoProfile -File infra/test-env.ps1 up -NoExport`).
// Every object lives under a key prefix that this run creates, and the run deletes it afterwards.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SyncChannel, type UploadSource } from '@docedit/protocol';
import { S3AssetObjects } from '../../../services/asset-worker/src/s3.ts';
import { createDepBackend, type DepBackend } from '../src/index.ts';
import type { FetchLike, ResponseLike } from '../src/platform.ts';
import { LEGAL_GRANT, USERS, contractDocument } from './support/fixtures.ts';
import {
  MemoryNetwork,
  type HttpRequest,
  type HttpResponse,
  type MemoryServer,
  type ServerSocket,
} from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';
import { FileServer } from './support/file-server.ts';

const CONTAINERS = fileURLToPath(new URL('../../../infra/containers/', import.meta.url));

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const ENV: Record<string, string> = {
  ...readEnvFile(`${CONTAINERS}.env.example`),
  ...readEnvFile(`${CONTAINERS}.env`),
};
for (const k of Object.keys(ENV)) if (process.env[k]) ENV[k] = process.env[k]!;

const STORE_ORIGIN = `http://${ENV['DOCEDIT_S3_HOST']}:${ENV['DOCEDIT_S3_PORT']}`;
const store = new S3AssetObjects({
  endpoint: STORE_ORIGIN,
  region: ENV['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: ENV['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: ENV['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: ENV['DOCEDIT_S3_SECRET_KEY'] ?? '',
});

/** Unique to this run, so no other object is touched. */
const PREFIX = `V-PRO-086-102-${randomBytes(6).toString('hex')}/`;
const written: string[] = [];

/**
 * The fixture server that hands out the store's own pre-signed address: it passes every request to
 * FileServer and, on a created asset, replaces FileServer's placeholder upload address with a
 * pre-signed PUT of the declared size, under a key of this run. Nothing else is changed.
 */
class StoreUploadServer implements MemoryServer {
  /** The pre-signed addresses handed out, by asset identifier. */
  readonly handedOut = new Map<string, string>();
  readonly #inner: FileServer;

  constructor(inner: FileServer) {
    this.#inner = inner;
  }

  accept(socket: ServerSocket): string | null {
    return this.#inner.accept(socket);
  }

  async http(req: HttpRequest): Promise<HttpResponse> {
    const res = await this.#inner.http(req);
    const path = new URL(req.url).pathname;
    if (
      req.method !== 'POST' ||
      !/^\/v1\/documents\/[^/]+\/assets$/.test(path) ||
      res.status !== 201
    )
      return res;
    const asked = JSON.parse(req.body ?? '{}') as { size: number };
    const made = JSON.parse(res.body ?? '{}') as { asset: string; upload: { url: string } };
    const key = `${PREFIX}${made.asset}`;
    const signed = store.presignUpload(key, asked.size, 300);
    written.push(key);
    this.handedOut.set(made.asset, signed.url);
    return { ...res, body: JSON.stringify({ ...made, upload: { url: signed.url } }) };
  }
}

/** A small file of text, as an upload source (structurally a Blob). */
function fileOf(text: string, type: string): UploadSource {
  const bytes = new TextEncoder().encode(text);
  return {
    size: bytes.byteLength,
    type,
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  };
}

describe('PRO-096 criterion 1 against the test object store (V-PRO-086-102)', () => {
  beforeAll(async () => {
    // Fail early with a clear message when the container is not up (no silent skip).
    const probe = await fetch(`http://${ENV['DOCEDIT_S3_HOST']}:${ENV['DOCEDIT_S3_PORT']}`).catch(
      (e: unknown) => e,
    );
    if (probe instanceof Error)
      throw new Error(`the S3 test store is not reachable: ${probe.message}`);
  });

  afterAll(async () => {
    for (const key of written) await store.delete(key).catch(() => undefined);
  });

  it('sends the bytes to a real pre-signed address, completes the asset and resolves after asset.ready', async () => {
    const dep = new MockDepServer({
      welcome: (d) => ({
        ...d,
        features: [
          ...new Set([...((d['features'] as string[] | undefined) ?? []), 'assets', 'exports']),
        ],
      }),
    });
    const files = new FileServer(dep);
    const server = new StoreUploadServer(files);
    const net = new MemoryNetwork(server);
    const docId = dep.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });

    // The control plane (REST and the channel) goes through the in-memory network. A request to
    // the store's origin goes over the real network exactly as backend-dep made it: same address,
    // same method, headers and body. Nothing is rewritten or signed here.
    const memFetch = net.platform().fetch as FetchLike;
    const toStore: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const storeFetch: FetchLike = async (url, init) => {
      if (!url.startsWith(`${STORE_ORIGIN}/`)) return memFetch(url, init);
      toStore.push({ url, method: init.method, headers: { ...init.headers } });
      const res = await globalThis.fetch(url, init as RequestInit);
      return res as unknown as ResponseLike;
    };

    const b: DepBackend = createDepBackend({
      endpoint: dep.endpoint,
      getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'editor' }),
      features: ['presence', 'regions', 'suggest-enforced', 'assets', 'exports'],
      platform: { random: () => 0, ...net.platform(), fetch: storeFetch },
    });

    await b.connect();
    const c = await b.sync.loadContent(docId);
    const ch: SyncChannel = await b.sync.open(docId, {
      resume: { seq: c.seq, incarnation: c.incarnation },
    });
    expect(ch).toBeDefined();

    const payload = `pixels ${PREFIX}`;
    const up = await b.assets!.upload(docId, {
      filename: 'logo.png',
      source: fileOf(payload, 'image/png'),
    });
    expect(up.asset).toMatch(/^[0-9a-f-]{36}$/);

    // backend-dep sent one PUT, to the very address the server handed out, with no bearer token.
    const handedOut = server.handedOut.get(up.asset);
    expect(handedOut).toMatch(/X-Amz-Signature=/);
    expect(toStore).toEqual([
      {
        url: handedOut,
        method: 'PUT',
        headers: expect.not.objectContaining({ authorization: expect.anything() }),
      },
    ]);

    // The bytes are in the store under the key of this asset, and nowhere else.
    const key = `${PREFIX}${up.asset}`;
    const stored = await store.get(key, 1024);
    expect(stored).not.toBeNull();
    expect(new TextDecoder().decode(stored!)).toBe(payload);

    // The asset is ready on the server: the outcome arrived before upload() resolved.
    expect(files.assets.get(up.asset)?.mime).toBe('image/png');

    // The URL of the asset is resolved through the port, after asset.ready.
    // The shape read here is ResolvedAssets (05 §6.2), the one FileServer answers.
    const resolved = (await b.assets!.resolve(docId, [up.asset])) as {
      assets: Array<{ asset: string; url: string }>;
    };
    expect(resolved.assets[0]?.asset).toBe(up.asset);
    expect(resolved.assets[0]?.url).toBeTruthy();

    await b.close();
  });
});
