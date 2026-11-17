/**
 * BE-005 criteria 1, 2 and 5 against the running stack of `apps/reference-host/compose.json`
 * (lane w5): the document service on PostgreSQL and the S3-compatible store with one export
 * worker, the development tenant seeded from the stack's configuration, and documents with their
 * history intact after the stack is stopped and started on the same volumes.
 *
 * The stack is not started here. Start it first, then run this file with the same settings:
 *
 *   pwsh -NoProfile -File apps/reference-host/scripts/stack.ps1 up
 *   DOCEDIT_DEMO_STACK=1 pnpm exec vitest run --project node services/document-service/test/stack/be-005-stack.test.ts
 *
 * Without `DOCEDIT_DEMO_STACK=1` every test is skipped, with a warning. The restart test stops and
 * starts the stack itself (`stack.ps1 down`, then `up`), so it runs only with
 * `DOCEDIT_DEMO_STACK_RESTART=1` as well. Settings come from `apps/reference-host/stack/.env.example`,
 * then the environment (project name and ports), as for stack.ps1. The credentials are the
 * stack's demo values on 127.0.0.1; none is printed.
 *
 * On a machine where Compose cannot start the file (a WSL Podman machine), stack.ps1 starts the
 * same definitions: PostgreSQL and the store as containers, the Node.js services as processes.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PgTenantRegistry } from '../../src/control-plane/tenants.ts';
import { createPool } from '../../src/storage/db.ts';
import { documentWithRegions } from '../control-plane/support.ts';
import { DepClient, insertText } from '../data-plane/client.ts';
import { cdmSchema } from '@docedit/model/prosemirror';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
type Json = Record<string, any>;

const repoRoot = new URL('../../../../', import.meta.url);
const appDir = new URL('apps/reference-host/', repoRoot);

function settings(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of readFileSync(new URL('stack/.env.example', appDir), 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const key of Object.keys(map)) {
    const v = process.env[key];
    if (v) map[key] = v;
  }
  return map;
}

const live = process.env['DOCEDIT_DEMO_STACK'] === '1';
const restart = live && process.env['DOCEDIT_DEMO_STACK_RESTART'] === '1';
if (!live)
  console.warn(
    'BE-005 stack tests skipped: start the stack and set DOCEDIT_DEMO_STACK=1 to run them',
  );

const s = settings();
const dataDir = process.env['DOCEDIT_DEMO_DATA'] ?? fileURLToPath(new URL('.stack/', appDir));
const serviceUrl = `http://127.0.0.1:${s['DOCEDIT_DEMO_SERVICE_PORT']}`;
const cli = s['DOCEDIT_CONTAINER_CLI'] || 'podman';
const project = s['DOCEDIT_DEMO_PROJECT']!;

const readJson = (name: string): Json =>
  JSON.parse(readFileSync(`${dataDir}/${name}`, 'utf8')) as Json;
const credential = (): string => readJson('secrets.json')['apiKey']['credential'] as string;

async function rest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${serviceUrl}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${credential()}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json };
}

const containerState = (service: string): string =>
  execFileSync(cli, ['inspect', '--format', '{{.State.Status}}', `${project}-${service}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const servicePool = () =>
  createPool({
    host: '127.0.0.1',
    port: Number(s['DOCEDIT_DEMO_PG_PORT']),
    database: s['DOCEDIT_DEMO_PG_DATABASE']!,
    user: s['DOCEDIT_DEMO_PG_SERVICE_USER']!,
    password: s['DOCEDIT_DEMO_PG_SERVICE_PASSWORD']!,
    max: 2,
  });

function stack(command: string): void {
  const r = spawnSync(
    'pwsh',
    ['-NoProfile', '-File', fileURLToPath(new URL('scripts/stack.ps1', appDir)), command],
    { encoding: 'utf8', env: process.env },
  );
  if (r.status !== 0)
    throw new Error(
      `stack.ps1 ${command} failed (${r.status}): ${(r.stderr || r.stdout).slice(-600)}`,
    );
}

describe.skipIf(!live)('the stack of apps/reference-host/compose.json, running (BE-005)', () => {
  it('has the document service ready on PostgreSQL and the S3 store, and an export worker that takes a job (criterion 1)', async () => {
    expect(existsSync(`${dataDir}/secrets.json`)).toBe(true);
    // The two containers of the compose file, by the names Compose gives them.
    expect(containerState('postgres')).toBe('running');
    expect(containerState('s3')).toBe('running');
    expect((await fetch(`http://127.0.0.1:${s['DOCEDIT_DEMO_S3_PORT']}/health`)).status).toBe(200);

    // The service reports ready: its database is reachable and migrated (BE-001 criterion 5).
    const ready = await fetch(`${serviceUrl}/readyz`);
    expect(ready.status).toBe(200);
    const discovery = (await (await fetch(`${serviceUrl}/.well-known/dep`)).json()) as Json;
    expect(discovery['features']).toEqual(expect.arrayContaining(['regions', 'exports']));

    // One export worker is running: a job put in the queue is claimed, compiled and stored.
    const doc = (await rest('POST', '/documents', { content: documentWithRegions() })).json[
      'id'
    ] as string;
    const queued = await rest('POST', `/documents/${doc}/exports`, { target: 'pdf' });
    expect(queued.status).toBe(202);
    let job = queued.json;
    for (let i = 0; i < 120 && !['completed', 'failed', 'cancelled'].includes(job['state']); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      job = (await rest('GET', `/exports/${job['id']}`)).json;
    }
    expect(job['state']).toBe('completed');
    // The PDF is in the S3-compatible store: the signed URL answers with a PDF.
    const pdf = await fetch(job['result']['url'] as string);
    expect(pdf.status).toBe(200);
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .toString('latin1'),
    ).toBe('%PDF-');
  }, 180_000);

  it('has the development tenant with its key set and allowed origins from the configuration (criterion 2)', async () => {
    const configured = readJson('tenants.json')['tenants'][0] as Json;
    const tenant = readJson('setup.json')['tenant'] as string;
    expect(configured['id']).toBe(tenant);
    const pool = servicePool();
    try {
      const registry = new PgTenantRegistry(pool);
      expect(await registry.exists(tenant)).toBe(true);
      // The key set: the host's signing key for user tokens, as the configuration names it.
      const keys = await registry.keys(tenant, 'user');
      expect(keys.map((k) => k.kid).sort()).toEqual(
        (configured['keys'] as Json[]).map((k) => k['kid'] as string).sort(),
      );
      expect(keys.length).toBeGreaterThan(0);
      // The API key of the configuration is registered (its secret is stored as a hash only).
      expect(
        await registry.apiKey(tenant, configured['apiKeys'][0]['id'] as string),
      ).not.toBeNull();
      // The allowed origins are those the stack's settings give the reference host.
      const origins = (await registry.origins(tenant)).sort();
      expect(origins).toEqual([...(configured['origins'] as string[])].sort());
      expect(origins).toContain(`http://127.0.0.1:${s['DOCEDIT_DEMO_HOST_PORT']}`);
    } finally {
      await pool.end();
    }
  });

  it.skipIf(!restart)(
    'keeps documents and their history when the stack is stopped and started on the same volumes (criterion 5)',
    async () => {
      const doc = (await rest('POST', '/documents', { content: documentWithRegions() })).json[
        'id'
      ] as string;
      const token = (await rest('POST', '/tokens', { sub: 'restart', docs: { [doc]: 'editor' } }))
        .json['token'] as string;
      const before = (await rest('GET', `/documents/${doc}/content`)).json;
      let at = -1;
      cdmSchema()
        .nodeFromJSON(before['doc'])
        .descendants((n, p) => {
          if (n.attrs['id'] === 'pIntro0000000001') at = p + 1;
          return at < 0;
        });
      const c = await DepClient.connect(`${serviceUrl.replace('http:', 'ws:')}/dep`);
      try {
        expect((await c.hello(token)).t).toBe('welcome');
        expect((await c.open(1, doc)).t).toBe('ch.opened');
        for (const [base, text] of [
          [0, 'kept '],
          [1, 'after a restart '],
        ] as const)
          expect(
            (await c.submit(1, { base, steps: [insertText(at, text)], origin: 'input' })).t,
          ).toBe('sync.ack');
      } finally {
        c.close();
      }
      const read = async () => ({
        content: (await rest('GET', `/documents/${doc}/content`)).json,
        commits: (await rest('GET', `/documents/${doc}/commits?after=0`)).json,
        meta: (await rest('GET', `/documents/${doc}`)).json,
      });
      const stored = await read();
      expect(stored.content['seq']).toBe(2);
      expect(JSON.stringify(stored.content['doc'])).toContain('after a restart kept ');
      expect((stored.commits['items'] as unknown[]).length).toBe(2);

      // Stop: the containers are removed and the processes end; the volumes stay.
      stack('down');
      await expect(fetch(`${serviceUrl}/readyz`)).rejects.toThrow();
      expect(() => containerState('postgres')).toThrow();
      // Start again on the same volumes.
      stack('up');
      expect((await fetch(`${serviceUrl}/readyz`)).status).toBe(200);

      const again = await read();
      expect(again.content['doc']).toEqual(stored.content['doc']);
      expect(again.content['seq']).toBe(2);
      expect(again.content['incarnation']).toBe(stored.content['incarnation']);
      expect(again.commits['items']).toEqual(stored.commits['items']);
      expect(again.meta['id']).toBe(doc);
    },
    900_000,
  );
});
