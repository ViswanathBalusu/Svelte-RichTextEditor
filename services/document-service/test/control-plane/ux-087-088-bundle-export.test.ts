// UX-087 (discovery export) and UX-088 (tenant export) through the real service: `POST
// /bundle-exports` queues a job that writes a bundle in parts, `GET /bundle-exports/{bid}` reports
// it, and `verifyExportBundle` of @docedit/history checks what the job wrote, as the offline tool
// does. In-memory storage; the job runs in the service's own runner. The formats are in
// docs/export-bundle-formats.md, the decisions in docs/adr/0433-w3-UX-087-bundle-container-and-routes.md
// (proposed) and docs/adr/0373-w3-UX-087-export-bundle-format.md (accepted, owner decision 175).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BundleReport, decodeUtf8, unpackFiles, verifyExportBundle } from '@docedit/history';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { objectKeys } from '../../src/objects/store.ts';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
} from '../../src/control-plane/webhook-subscriptions.ts';
import type { DocRef } from '../../src/storage/types.ts';
import { DepClient } from '../data-plane/client.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const comment = { body: [{ type: 'text', text: 'Please check the rent.' }] };

function firstTextPosition(doc: unknown): number {
  const root = cdmSchema().nodeFromJSON(doc);
  let found = -1;
  root.descendants((n, pos) => {
    if (found < 0 && n.isTextblock) found = pos + 1;
  });
  return found;
}

/** A document with one role and one required field, for a workflow with one participant. */
function workflowDocument(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pFinal0000000087' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: 'ff00000000000087',
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          required: true,
          value: 'Ada',
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

describe('discovery and tenant export bundles (UX-087, UX-088)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory', {
      realDataPlane: true,
      config: { jobIdleMs: 20 },
      parts: {
        webhooks: new WebhookSubscriptions({
          store: new MemorySubscriptionStore(),
          now: () => Date.now(),
        }),
      },
    });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  const service = () => h.serviceJwt();
  const call = (method: string, path: string, body?: unknown, token = service()) =>
    h.call(method, `/v1${path}`, { token, ...(body !== undefined ? { body } : {}) });

  /** A commit that types `text` at `pos`, appended as a room would. */
  async function typeAt(doc: string, pos: number, text: string): Promise<void> {
    const ref: DocRef = { tenant: h.tenant, doc };
    const epoch = await h.parts.ownership.claim(ref, 'test-node');
    const head = await h.parts.logs.head(ref);
    const perms = await h.parts.grants.current(ref);
    const r = await h.parts.logs.append(ref, {
      epoch,
      revision: perms.revision,
      fromSeq: head.seq + 1,
      commits: [
        {
          seq: head.seq + 1,
          id: uuid7(),
          kind: 'steps' as const,
          steps: [
            {
              stepType: 'replace',
              from: pos,
              to: pos,
              slice: { content: [{ type: 'text', text }] },
            },
          ] as never,
          user: 'test-author',
          session: 'session-test',
          time: h.now(),
          origin: 'input',
          scopes: ['body'],
          revision: perms.revision,
          cdm: 1,
          engine: 'pm-steps/1',
          retired: [],
          claimed: [],
        },
      ],
    });
    if (r.status !== 'ok') throw new Error(`append refused: ${r.status}`);
  }

  /** A document with a label, two commits, a comment thread, a named version and a hold. */
  async function richDocument(label: string): Promise<string> {
    const doc = await h.createDocument({ content: documentWithRegions(), classification: label });
    const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const pos = firstTextPosition(content.json.doc);
    await typeAt(doc, pos, 'first ');
    await typeAt(doc, pos, 'second ');
    const editor = h.userToken({ [doc]: 'editor' }, { sub: `ed-${uuid7()}` });
    const head = (await h.parts.logs.head({ tenant: h.tenant, doc })).seq;
    const thread = await h.call('POST', `/v1/documents/${doc}/threads`, {
      token: editor,
      body: { target: { range: { from: pos, to: pos + 3, baseSeq: head } }, comment },
    });
    expect(thread.status, thread.text).toBe(201);
    const version = await h.call('POST', `/v1/documents/${doc}/versions`, {
      token: editor,
      body: { name: 'Sent to legal', note: 'after review' },
    });
    expect(version.status, version.text).toBe(201);
    const hold = await h.call('POST', `/v1/documents/${doc}/holds`, {
      token: h.apiKey,
      body: { reason: 'Matter 2026-41' },
    });
    expect(hold.status, hold.text).toBe(201);
    return doc;
  }

  interface Finished {
    id: string;
    state: string;
    progress: number;
    result?: {
      documents: number;
      counts: Record<string, number>;
      index: { name: string; sha256: string; size: number; url: string };
      parts: Array<{ name: string; sha256: string; size: number; documents: number; url: string }>;
    };
    error?: { code: string; message: string };
  }

  async function runExport(body: Record<string, unknown>): Promise<Finished> {
    const started = await call('POST', '/bundle-exports', body);
    expect(started.status, started.text).toBe(202);
    let last = started.json as Finished;
    for (let i = 0; i < 400 && last.state !== 'completed' && last.state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      last = (await call('GET', `/bundle-exports/${started.json.id}`)).json as Finished;
    }
    return last;
  }

  /** The files of a finished job as the store holds them. */
  async function download(job: Finished) {
    const get = async (name: string): Promise<Uint8Array> => {
      const bytes = await h.parts.objects.get(objectKeys.exportFile(h.tenant, job.id, name));
      if (!bytes) throw new Error(`${name} is not in the store`);
      return bytes;
    };
    const parts = new Map<string, Uint8Array>();
    for (const p of job.result!.parts) parts.set(p.name, await get(p.name));
    return { parts, index: await get('parts.json') };
  }

  const filesOf = (archive: Uint8Array) =>
    new Map(unpackFiles(archive)!.map((f) => [f.path, f.bytes] as const));
  const json = (bytes: Uint8Array | undefined) => JSON.parse(decodeUtf8(bytes!));

  it('writes a discovery bundle of one document that verifies offline (UX-087 criteria 1 and 3)', async () => {
    const doc = await richDocument('Confidential');
    const job = await runExport({ kind: 'discovery', documents: [doc] });
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    expect(job.result!.parts).toHaveLength(1);
    expect(job.result!.parts[0]!.url).toContain(job.id);

    const bundle = await download(job);
    const report: BundleReport = await verifyExportBundle(bundle);
    expect(report.problems).toEqual([]);
    expect(report.status).toBe('intact');
    expect(report.kind).toBe('discovery');
    // Content, history with its chain, comments with their ranges and the manifest.
    const files = filesOf(bundle.parts.get('part-0001.tar')!);
    const base = `documents/${doc}`;
    expect([...files.keys()].sort()).toEqual(
      [
        'manifest.json',
        `${base}/comments.ndjson`,
        `${base}/content.json`,
        `${base}/document.json`,
        `${base}/history.json`,
        `${base}/inclusion.json`,
        `${base}/versions.ndjson`,
      ].sort(),
    );
    expect(json(files.get(`${base}/document.json`))).toMatchObject({
      id: doc,
      classification: 'Confidential',
    });
    const history = json(files.get(`${base}/history.json`));
    expect(history.commits).toHaveLength(2);
    expect(history.head).toEqual({ seq: 2, chainHead: history.commits[1].hash });
    const threads = decodeUtf8(files.get(`${base}/comments.ndjson`)!)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(threads).toHaveLength(1);
    expect(threads[0].target.range).toMatchObject({
      from: expect.any(Number),
      to: expect.any(Number),
    });
    expect(threads[0].comments).toHaveLength(1);
    const manifest = json(files.get('manifest.json'));
    expect(manifest.chainHeads[doc]).toEqual(history.head);
    expect(manifest.counts).toMatchObject({
      documents: 1,
      commits: 2,
      threads: 1,
      comments: 1,
      versions: 1,
    });
    expect(job.result!.counts).toEqual(manifest.counts);
  });

  it('carries the workflow evidence of a completed workflow, and says when there is none yet (UX-087 criterion 1)', async () => {
    const doc = await h.createDocument({ content: workflowDocument() });
    const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-087-${doc}` });
    const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
      token: owner,
      body: {
        id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c87',
        doc,
        state: 'draft',
        rev: 0,
        timeZone: 'UTC',
        participants: [{ id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' }],
      },
      headers: { 'if-match': '"0"' },
    });
    expect(made.status, made.text).toBe(201);
    const before = await runExport({ kind: 'discovery', documents: [doc] });
    expect(
      json(
        filesOf((await download(before)).parts.get('part-0001.tar')!).get(
          `documents/${doc}/inclusion.json`,
        ),
      ).evidence,
    ).toBe('not-finished');

    expect(
      (await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner })).status,
    ).toBe(200);
    const tok = h.userToken({ [doc]: 'filler' }, { sub: 'sub-p1', wfp: 'p1' });
    const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
    try {
      expect((await c.hello(tok)).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      for (let i = 0; i < 100; i++) {
        const w = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        if (w.json.state === 'in_progress') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const done = await h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/complete`, {
        token: tok,
        body: {},
      });
      expect(done.status, done.text).toBe(200);
    } finally {
      c.terminate();
    }

    const job = await runExport({ kind: 'discovery', documents: [doc] });
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    const bundle = await download(job);
    const files = filesOf(bundle.parts.get('part-0001.tar')!);
    expect(json(files.get(`documents/${doc}/inclusion.json`)).evidence).toBe('included');
    expect(json(files.get(`documents/${doc}/evidence.json`))).toMatchObject({
      format: 'docedit-workflow-evidence/1',
    });
    const report = await verifyExportBundle(bundle);
    expect(report.problems).toEqual([]);
    expect(report.status).toBe('intact');
  });

  it('states what is included, held and thinned (UX-087 criterion 2)', async () => {
    const doc = await richDocument('Internal use only');
    const job = await runExport({ kind: 'discovery', documents: [doc] });
    expect(job.state).toBe('completed');
    const files = filesOf((await download(job)).parts.get('part-0001.tar')!);
    const inclusion = json(files.get(`documents/${doc}/inclusion.json`));
    expect(inclusion).toMatchObject({
      format: 'docedit-inclusion/1',
      document: doc,
      content: { seq: 2 },
      history: { commits: 2, payloads: 'hash-only' },
      retention: { source: 'default' },
      evidence: 'none',
    });
    expect(inclusion.holds).toHaveLength(1);
    expect(inclusion.holds[0]).toMatchObject({ reason: 'Matter 2026-41' });
    expect(Array.isArray(inclusion.thinned)).toBe(true);
  });

  it('needs the administrator, which is the service credential, and audits the request (UX-087 criterion 4)', async () => {
    const doc = await richDocument('Internal use only');
    const editor = h.userToken({ [doc]: 'owner' }, { sub: `own-${uuid7()}` });
    const refused = await call(
      'POST',
      '/bundle-exports',
      { kind: 'discovery', documents: [doc] },
      editor,
    );
    expect(refused.status, refused.text).toBe(403);
    const refusedGet = await call('GET', `/bundle-exports/${uuid7()}`, undefined, editor);
    expect(refusedGet.status).toBe(403);

    const job = await runExport({ kind: 'discovery', documents: [doc] });
    expect(job.state).toBe('completed');
    const events = await h.parts.audit!.query(h.tenant, {
      kind: 'export.discovery.requested',
      limit: 1000,
    });
    const mine = events.filter((e) => e.doc === doc);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.data).toMatchObject({ documents: 1 });
    // The user's refused request left no event.
    expect(events.every((e) => e.actor !== editor)).toBe(true);
  });

  it('produces a tenant-wide export in parts, with counts that match the stored data (UX-087 criterion 5, UX-088 criterion 3)', async () => {
    const docs = [await richDocument('A'), await richDocument('B'), await richDocument('C')];
    const stored = await h.parts.documents.list(h.tenant, { limit: 1000 });
    const job = await runExport({ kind: 'tenant', maxDocumentsPerPart: 2 });
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    expect(job.result!.parts.length).toBe(Math.ceil(stored.length / 2));
    expect(job.result!.parts.length).toBeGreaterThan(1);
    expect(job.result!.documents).toBe(stored.length);

    const bundle = await download(job);
    const report = await verifyExportBundle(bundle);
    expect(report.problems).toEqual([]);
    expect(report.status).toBe('intact');
    expect(report.kind).toBe('tenant');

    // The manifest counts against the stored data.
    let commits = 0;
    let threads = 0;
    let versions = 0;
    let grants = 0;
    for (const d of stored) {
      const ref = { tenant: h.tenant, doc: d.id };
      commits += (await h.parts.logs.head(ref)).seq;
      threads += (await h.parts.threads!.list(ref, { limit: 1000 })).length;
      versions += (await h.parts.versions!.list(ref)).length;
      grants += (await h.parts.grants.history(ref)).length;
    }
    expect(report.counts).toMatchObject({
      documents: stored.length,
      commits,
      threads,
      versions,
      grants,
    });
    expect(job.result!.counts).toEqual(report.counts);
    // The command-line tool reads the same files from a directory and finds them intact.
    const dir = mkdtempSync(join(tmpdir(), 'ux-088-'));
    try {
      writeFileSync(join(dir, 'parts.json'), bundle.index);
      for (const [name, bytes] of bundle.parts) writeFileSync(join(dir, name), bytes);
      const tool = join(
        import.meta.dirname,
        '../../../../packages/history/scripts/verify-bundle.ts',
      );
      const run = spawnSync(process.execPath, [tool, dir], { encoding: 'utf8' });
      expect(run.status, run.stdout).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ status: 'intact', kind: 'tenant' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Every document is in exactly one part, and the tenant files are in part 1 only.
    const seen = new Set<string>();
    for (const [name, archive] of bundle.parts) {
      const files = filesOf(archive);
      for (const path of files.keys()) {
        const id = /^documents\/([^/]+)\//.exec(path)?.[1];
        if (id && path.endsWith('document.json')) {
          expect(seen.has(id)).toBe(false);
          seen.add(id);
        }
        if (path.startsWith('tenant/')) expect(name).toBe('part-0001.tar');
      }
    }
    for (const d of docs) expect(seen.has(d)).toBe(true);
    expect(seen.size).toBe(stored.length);
  });

  it('writes the tenant files and leaves out every secret (UX-088 criteria 1 and 4)', async () => {
    const sub = await call('POST', '/webhooks', {
      url: 'https://hooks.example.test/in',
      events: ['dep.document.created.v1'],
    });
    expect(sub.status, sub.text).toBe(201);
    const secret = JSON.stringify(sub.json).match(/whsec_[A-Za-z0-9+/=_-]+/)?.[0];
    expect(secret, 'the subscription answers its secret once').toBeDefined();

    const job = await runExport({ kind: 'tenant' });
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    const bundle = await download(job);
    const part1 = filesOf(bundle.parts.get('part-0001.tar')!);
    for (const path of [
      'tenant/settings.json',
      'tenant/keys.json',
      'tenant/origins.json',
      'tenant/webhooks.json',
    ])
      expect(part1.has(path), path).toBe(true);
    expect(json(part1.get('tenant/origins.json')).origins).toContain('https://app.example.test');
    const keys = json(part1.get('tenant/keys.json')).keys as Array<{
      jwk: Record<string, unknown>;
    }>;
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k.jwk).not.toHaveProperty('d');
    const hooks = json(part1.get('tenant/webhooks.json')).webhooks as Array<
      Record<string, unknown>
    >;
    expect(hooks.some((x) => x['url'] === 'https://hooks.example.test/in')).toBe(true);

    // No secret anywhere in the bytes: the webhook secret, the API key secret, the service key's private part.
    const everything = [...bundle.parts.values()].map((b) => decodeUtf8(b)).join('\n');
    expect(everything).not.toContain(secret!);
    expect(everything).not.toContain(h.apiKey);
    const priv = (h.serviceKey as unknown as { privateJwk?: { d?: string } }).privateJwk?.d;
    if (priv) expect(everything).not.toContain(priv);
    expect((await verifyExportBundle(bundle)).problems.filter((p) => p.check === 'secret')).toEqual(
      [],
    );
  });

  it('carries the assets of a document, named by their hash, and verifies them (UX-088 criterion 1)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5]);
    const sha = createHash('sha256').update(bytes).digest('hex');
    await h.parts.objects.put(objectKeys.asset(h.tenant, sha), bytes);
    const id = uuid7();
    const now = h.now();
    await h.parts.assetRegistry.create(
      h.tenant,
      {
        id,
        doc,
        filename: 'logo.png',
        mime: 'image/png',
        declaredBytes: bytes.length,
        createdBy: 'test-author',
        uploadExpiresAt: now + 60_000,
      },
      now,
    );
    await h.parts.assetRegistry.settleReady(
      h.tenant,
      id,
      {
        sha256: sha,
        bytes: bytes.length,
        contentType: 'image/png',
        objectKey: objectKeys.asset(h.tenant, sha),
        width: null,
        height: null,
        frames: null,
        renditions: [],
      },
      now,
    );
    const job = await runExport({ kind: 'tenant' });
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    const bundle = await download(job);
    const all = new Map<string, Uint8Array>();
    for (const archive of bundle.parts.values())
      for (const [path, content] of filesOf(archive)) all.set(path, content);
    expect(all.get(`assets/${sha}`)).toEqual(bytes);
    const listed = decodeUtf8(all.get(`documents/${doc}/assets.ndjson`)!)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(listed).toEqual([
      { id, filename: 'logo.png', mime: 'image/png', sha256: sha, bytes: bytes.length },
    ]);
    const report = await verifyExportBundle(bundle);
    expect(report.problems).toEqual([]);
  });

  it('holds nothing of another tenant, and audits the request (UX-088 criterion 5)', async () => {
    const other = uuid7();
    await h.parts.registry.putTenant(other, 'Another tenant');
    const foreign = await h.parts.documents.create(other, {
      cdmVersion: 1,
      createdBy: 'someone',
      title: 'Foreign document',
    });
    await richDocument('Mine');

    const job = await runExport({ kind: 'tenant' });
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    const bundle = await download(job);
    const everything = [...bundle.parts.values()].map((b) => decodeUtf8(b)).join('\n');
    expect(everything).not.toContain(foreign.id);
    expect(everything).not.toContain('Foreign document');
    expect(everything).not.toContain(other);

    // A document of the other tenant cannot be named either.
    const named = await call('POST', '/bundle-exports', {
      kind: 'discovery',
      documents: [foreign.id],
    });
    expect(named.status).toBe(404);

    const events = await h.parts.audit!.query(h.tenant, {
      kind: 'export.tenant.requested',
      limit: 1000,
    });
    expect(events.some((e) => (e.data as { documents?: unknown }).documents === 'all')).toBe(true);
  });

  it('refuses a request that is not valid', async () => {
    for (const body of [
      { kind: 'tenant', documents: [uuid7()] },
      { kind: 'discovery', documents: [] },
      { kind: 'tenant', maxDocumentsPerPart: 0 },
    ]) {
      const r = await call('POST', '/bundle-exports', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call('GET', `/bundle-exports/${uuid7()}`)).status).toBe(404);
  });
});
