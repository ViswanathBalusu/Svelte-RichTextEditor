// backend-dep's assets, exports and fonts ports over REST (PRO-096; 05 §6.2, §3.1): which ports
// exist for which features, the upload path and its outcome, the export job calls, the manifest,
// the problem codes, and what happens to an upload when the backend closes. The wire is recorded by
// the in-memory network; the assets, exports and fonts routes are answered by FileServer, because
// the mock service offers none of them. Universal: Node.js and browsers.
import { describe, expect, it } from 'vitest';
import { isPortError, type SyncChannel, type UploadSource } from '@docedit/protocol';
import { createDepBackend, type DepBackend } from './index.ts';
import { LEGAL_GRANT, USERS, contractDocument } from '../test/support/fixtures.ts';
import { MemoryNetwork } from '../test/support/memory-network.ts';
import { MockDepServer } from '../test/support/mock-server.ts';
import { FileServer, REFUSED_MIME, SILENT_MIME, STORAGE } from '../test/support/file-server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The features this client asks for in these tests: the defaults and the file ports. */
const FEATURES = ['presence', 'regions', 'suggest-enforced', 'assets', 'exports'];

interface Setup {
  dep: MockDepServer;
  files: FileServer;
  net: MemoryNetwork;
  docId: string;
  make(features?: readonly string[]): DepBackend;
}

/**
 * A DEP server that announces `assets` and `exports` in `welcome` when `announce` says so. The
 * server answers their routes through FileServer; the client negotiates the intersection (05 §1
 * rule 4), so the announcement alone decides whether the ports appear.
 */
function setup(announce: readonly string[] = ['assets', 'exports']): Setup {
  const dep = new MockDepServer({
    welcome: (d) => ({
      ...d,
      features: [...new Set([...((d['features'] as string[] | undefined) ?? []), ...announce])],
    }),
  });
  const files = new FileServer(dep);
  const net = new MemoryNetwork(files);
  const docId = dep.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  return {
    dep,
    files,
    net,
    docId,
    make: (features = FEATURES) =>
      createDepBackend({
        endpoint: dep.endpoint,
        getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'editor' }),
        features: [...features],
        platform: { random: () => 0, ...net.platform() },
      }),
  };
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

/** Connects and opens a sync channel: the session an `asset.ready` event arrives on. */
async function connected(s: Setup, b: DepBackend): Promise<SyncChannel> {
  await b.connect();
  const c = await b.sync.loadContent(s.docId);
  const ch = await b.sync.open(s.docId, { resume: { seq: c.seq, incarnation: c.incarnation } });
  return ch;
}

describe('the ports exist only when their features are announced (PRO-096, PRO-092)', () => {
  it('offers assets and exports when the server announces them and the client asked for them; fonts always', async () => {
    const s = setup(['assets', 'exports']);
    const b = s.make();
    expect(b.assets).toBeUndefined();
    expect(b.exports).toBeUndefined();
    await b.connect();
    expect(b.features.has('assets')).toBe(true);
    expect(b.assets).toBeDefined();
    expect(b.exports).toBeDefined();
    expect(b.fonts).toBeDefined();
    await b.close();
  });

  it('leaves assets and exports absent when the server does not announce them', async () => {
    const s = setup([]);
    const b = s.make();
    await b.connect();
    expect(b.features.has('assets')).toBe(false);
    expect(b.features.has('exports')).toBe(false);
    expect(b.assets).toBeUndefined();
    expect(b.exports).toBeUndefined();
    // Fonts have no feature name (G06): the port is present whether or not the server says so.
    expect(b.fonts).toBeDefined();
    await b.close();
  });

  it('leaves assets and exports absent when the client did not ask for them, even if announced', async () => {
    const s = setup(['assets', 'exports']);
    const b = s.make(['presence', 'regions', 'suggest-enforced']);
    await b.connect();
    expect(b.assets).toBeUndefined();
    expect(b.exports).toBeUndefined();
    await b.close();
  });
});

describe('the upload (PRO-096: assets)', () => {
  it('creates the asset, sends the bytes to the pre-signed address without a token, completes it and resolves after asset.ready', async () => {
    const s = setup();
    const b = s.make();
    await connected(s, b);
    const up = await b.assets!.upload(s.docId, {
      filename: 'logo.png',
      source: fileOf('pixels', 'image/png'),
    });
    expect(up.asset).toMatch(/^[0-9a-f-]{36}$/);
    const stored = s.files.stored.filter((x) => x.url === `${STORAGE}/up/${up.asset}`);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.body).toBe('pixels');
    // The bearer token is for the control plane only (05 §3.1).
    expect(stored[0]!.bearer).toBe(false);
    expect(s.files.assets.get(up.asset)?.mime).toBe('image/png');
    await b.close();
  });

  it('rejects with validation_failed when the asset worker answers asset.failed', async () => {
    const s = setup();
    const b = s.make();
    await connected(s, b);
    const err = await b
      .assets!.upload(s.docId, { filename: 'x.bin', source: fileOf('bad', REFUSED_MIME) })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isPortError(err) && err.code).toBe('validation_failed');
    await b.close();
  });

  it('rejects with unavailable when the backend closes while an upload waits for its outcome', async () => {
    const s = setup();
    const b = s.make();
    await connected(s, b);
    const pending = b
      .assets!.upload(s.docId, { filename: 'x.bin', source: fileOf('quiet', SILENT_MIME) })
      .then(
        () => null,
        (e: unknown) => e,
      );
    await sleep(20);
    await b.close();
    const err = await pending;
    expect(isPortError(err) && err.code).toBe('unavailable');
  });
});

describe('the asset calls and the export calls (PRO-096)', () => {
  it('reads a resolved asset list and sends the idempotency key on a create', async () => {
    const s = setup();
    const b = s.make();
    await connected(s, b);
    const made = await b.assets!.create(
      s.docId,
      { filename: 'a.png', mime: 'image/png', size: 3 },
      { idempotencyKey: 'key-asset-1' },
    );
    const resolved = await b.assets!.resolve(s.docId, [made.asset]);
    expect(JSON.stringify(resolved)).toContain(made.asset);
    const create = s.files.answered.find((a) => a.method === 'POST' && a.path.endsWith('/assets'));
    expect(create?.headers['idempotency-key']).toBe('key-asset-1');
    await b.close();
  });

  it('requests an export as a job, reads its state, and cancels it', async () => {
    const s = setup();
    const b = s.make();
    await connected(s, b);
    const job = await b.exports!.request(s.docId, { target: 'pdf' }, { idempotencyKey: 'exp-1' });
    expect(job.state).toBe('queued');
    expect(job.doc).toBe(s.docId);
    const read = await b.exports!.get(job.id);
    expect(read.value.id).toBe(job.id);
    expect(read.etag).not.toBe('');
    await b.exports!.cancel(job.id);
    const after = await b.exports!.get(job.id);
    expect(after.value.state).toBe('cancelled');
    const post = s.files.answered.find((a) => a.method === 'POST' && a.path.endsWith('/exports'));
    expect(post?.headers['idempotency-key']).toBe('exp-1');
    await b.close();
  });

  it('reads the font manifest from GET /fonts', async () => {
    const s = setup([]);
    const b = s.make();
    await b.connect();
    const m = await b.fonts.manifest();
    expect(m).toEqual({ version: '1', families: [] });
    await b.close();
  });
});

describe('REST failures (PRO-096, PRO-039)', () => {
  it('surfaces the registry code of the problem document', async () => {
    const s = setup();
    const b = s.make();
    await connected(s, b);
    const err = await b.exports!.get('no-such-export').then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPortError(err) && err.code).toBe('not_found');
    await b.close();
  });
});
