/**
 * The fault run of FE-009 criterion 7 (11 §4, the phase 1b exit criteria): everything that is not a
 * browser tab.
 *
 * - One real document service (`services/document-service`, `src/main.ts`) in a process of its own,
 *   on a PostgreSQL database this run creates and drops. `scripts/load/lib.ts` of the service starts
 *   it; a kill is SIGKILL, and the next process uses the same database, tenant and keys.
 * - The relay the tabs reach it through (`proxy.ts`), so that connections can be dropped and the
 *   endpoint stays the same across a restart.
 * - The host: it signs the users' tokens itself with a key registered for the tenant (05 §3.1), so a
 *   token is there whether or not the service is.
 * - The document: two regions' worth of grants (Ada holds the grant on the restricted region, Grace
 *   does not) and three form fields of one role, for a participant who may only fill.
 * - The faults: dropped connections, a killed process, and a database outage. The outage is a real
 *   one by default (PostgreSQL refuses the service's database and ends its sessions); with
 *   `DOCEDIT_FAULT_RUN_OUTAGE=hook` it is the service's own test hook (BE-079), which needs test mode.
 *
 * Nothing here is part of the product. Settings of a run (duration, seed, pauses) are settings of the
 * run, named in its report; they are not figures of the specification.
 */
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startServiceProcess,
  type ServiceHandle,
  type ServiceOptions,
} from '../../services/document-service/scripts/load/lib.ts';
import { signJws } from '../../services/document-service/src/control-plane/jwt.ts';
import { hashSecret } from '../../services/document-service/src/control-plane/tenants.ts';
import { newApiKey } from '../../services/document-service/src/control-plane/tokens.ts';
import { createPool } from '../../services/document-service/src/index.ts';
import {
  ADMIN,
  createTestDatabase,
  settings,
  type TestDatabase,
} from '../../services/document-service/test/support/env.ts';
import { startRelay, type Relay } from './proxy.ts';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A small seeded generator (mulberry32), so that a run's schedule can be made again from its seed. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in `[min, max]` from a generator. */
export const between = (next: () => number, min: number, max: number): number =>
  min + Math.floor(next() * (max - min + 1));

// --- The document -------------------------------------------------------------------------------

/** The role of the participant who may only fill, and the identifiers of the run's document. */
export const ROLE = 'role_participant';
export const IDS = {
  intro: 'pIntro0000000001',
  legalRegion: 'rLegal0000000001',
  legal: 'pLegal0000000001',
  fields: 'pFields000000001',
  ada: 'pAda000000000001',
  end: 'pEnd000000000001',
  fieldA: 'fRunA00000000001',
  fieldB: 'fRunB00000000001',
  fieldC: 'fRunC00000000001',
} as const;

/**
 * Where each person types. A line of a stream starts with its marker, so that the run finds the
 * stream's last line again after a tab was closed or the document was loaded afresh.
 * `A1` is inside the restricted region, which only Ada may change.
 */
export const STREAMS = { ada: ['A1>', 'A2>'], grace: ['G1>', 'G2>'] } as const;

type Json = Record<string, unknown>;

const paragraph = (id: string, content: Json[]): Json => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content,
});
const text = (value: string): Json => ({ type: 'text', text: value });
const field = (id: string, key: string, label: string): Json => ({
  type: 'form_field',
  attrs: { id, key, kind: 'text', assignee: ROLE, value: null, label },
});

/**
 * The run's document: Grace's first stream, the restricted region with Ada's first stream, the
 * paragraph of form fields, Ada's second stream and Grace's second stream. Each person writes before
 * and after the other, so each one's changes move the positions of the other's.
 */
export function runDocument(): Json {
  return {
    cdm: 1,
    requires: ['fields'],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
              },
            },
            { type: 'role_def', attrs: { id: ROLE, name: 'Participant', color: '#1F77B4' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            paragraph(IDS.intro, [text(`${STREAMS.grace[0]} `)]),
            {
              type: 'region',
              attrs: { id: IDS.legalRegion, title: 'Legal review', policy: 'restricted' },
              content: [paragraph(IDS.legal, [text(`${STREAMS.ada[0]} `)])],
            },
            paragraph(IDS.fields, [
              text('Fields: '),
              field(IDS.fieldA, 'run.a', 'First'),
              text(' '),
              field(IDS.fieldB, 'run.b', 'Second'),
              text(' '),
              field(IDS.fieldC, 'run.c', 'Third'),
            ]),
            paragraph(IDS.ada, [text(`${STREAMS.ada[1]} `)]),
            paragraph(IDS.end, [text(`${STREAMS.grace[1]} `)]),
          ],
        },
      ],
    },
  };
}

/** All the text of a CDM document, block after block, and the values of its form fields by id. */
export function contentOf(doc: unknown): { text: string; fields: Record<string, unknown> } {
  const parts: string[] = [];
  const fields: Record<string, unknown> = {};
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as { type?: unknown; text?: unknown; attrs?: Json; content?: unknown[] };
    if (typeof node.text === 'string') parts.push(node.text);
    if (node.type === 'form_field' && typeof node.attrs?.['id'] === 'string')
      fields[node.attrs['id']] = node.attrs['value'] ?? null;
    // A separator after each block, so that the end of one line never joins the start of the next.
    if (node.type === 'paragraph') parts.push('\n');
    node.content?.forEach(walk);
  };
  walk(doc);
  return { text: parts.join(''), fields };
}

/** The text inside the region `id` of a CDM document; empty when there is no such region. */
export function regionText(doc: unknown, id: string): string {
  let found = '';
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as { type?: unknown; attrs?: Json; content?: unknown[] };
    if (node.type === 'region' && node.attrs?.['id'] === id) found += contentOf(node).text;
    else node.content?.forEach(walk);
  };
  walk(doc);
  return found;
}

export const occurrences = (haystack: string, needle: string): number =>
  needle === '' ? 0 : haystack.split(needle).length - 1;

/** JSON with the members of every object in the order of their names, to compare two documents. */
export function canonical(value: unknown): string {
  const order = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(order);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Json)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, order(x)]),
      );
    return v;
  };
  return JSON.stringify(order(value));
}

// --- The run ------------------------------------------------------------------------------------

/** Null when the object store of the test environment answers; otherwise why the run skips. */
export async function objectStoreUnavailable(): Promise<string | null> {
  const s = settings();
  const url = `http://${s['DOCEDIT_S3_HOST'] ?? '127.0.0.1'}:${s['DOCEDIT_S3_PORT'] ?? ''}/health`;
  const hint = 'start it with: pwsh -NoProfile -File infra/test-env.ps1 up -NoExport';
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.ok ? null : `the object store answered ${r.status} at ${url}; ${hint}`;
  } catch (e) {
    return `the object store is not reachable at ${url} (${e instanceof Error ? e.message : String(e)}); ${hint}`;
  }
}

export type OutageKind = 'postgres' | 'hook';

export interface RunOptions {
  /** The origin of the page the tabs load (the demo server): the service allows only this one. */
  pageOrigin: string;
  outage: OutageKind;
}

export interface FaultRun {
  /** What the tabs use as `endpoint`. */
  readonly endpoint: string;
  readonly docId: string;
  readonly tenant: string;
  /** A token the host signs for `sub` (`ada`, `grace` or `fill`), good for five minutes. */
  token(sub: string): string;
  /** Drops every open connection between the tabs and the service; returns how many WebSockets. */
  dropConnections(): number;
  /** Nothing reaches the service until `restoreNetwork`; open connections are dropped. */
  cutNetwork(): void;
  restoreNetwork(): void;
  /** SIGKILL of the service process, `downMs` with nothing listening, then a new process. */
  killService(downMs: number): Promise<void>;
  /** The database is away for `ms`, then back. */
  databaseOutage(ms: number): Promise<void>;
  /** The document as the service stores it, read with the tenant's service credential. */
  stored(): Promise<{ seq: number; doc: unknown }>;
  /** The numbers of the run so far. */
  counts(): { serviceStarts: number; sockets: number; socketsDropped: number };
  /** Everything the service processes wrote, for the report of a failure. */
  serviceOutput(): string;
  close(): Promise<void>;
}

const ROLES: Record<string, { role: string; name: string; wfr?: string[] }> = {
  ada: { role: 'editor', name: 'Ada' },
  grace: { role: 'editor', name: 'Grace' },
  fill: { role: 'filler', name: 'Vic', wfr: [ROLE] },
};

export async function startFaultRun(options: RunOptions): Promise<FaultRun> {
  const db: TestDatabase = await createTestDatabase();
  const c = db.serviceConfig;
  const databaseUrl = `postgres://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`;
  // The harness itself reads nothing through the service role.
  await db.service.end();
  // Statements about the run's database are made from the maintenance database, which stays up.
  const control = createPool({ ...ADMIN, max: 2 });
  control.on('error', () => {});

  const relay: Relay = await startRelay();

  // The tenant, with the host's key for user tokens, an API key and the page's origin (BE-012).
  const tenant = randomUUID();
  const apiKey = newApiKey(tenant);
  const hostPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const hostJwk = hostPair.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const kid = `host-${randomUUID()}`;
  const dir = await mkdtemp(join(tmpdir(), 'docedit-fault-run-'));
  const seedFile = join(dir, 'tenants.json');
  await writeFile(
    seedFile,
    JSON.stringify({
      tenants: [
        {
          id: tenant,
          name: 'FE-009 fault run',
          keys: [
            {
              kid,
              use: 'user',
              alg: 'ES256',
              jwk: { kty: 'EC', crv: 'P-256', x: hostJwk['x'], y: hostJwk['y'] },
            },
          ],
          apiKeys: [{ id: apiKey.id, secretSha256: hashSecret(apiKey.secret).toString('hex') }],
          origins: [options.pageOrigin],
        },
      ],
    }),
  );

  // What a deployment keeps across a restart of its process: its public address, its keys and its
  // object store. Checkpoints go to the S3-compatible store of the test environment, which outlives
  // the process, as in the service's own kill scenario (scripts/load/fnd-009.ts); without it a
  // killed process loses the content a room starts from.
  const serviceKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const objectStore = Object.fromEntries(
    Object.entries(settings()).filter(([k]) => k.startsWith('DOCEDIT_S3_')),
  );
  const start: ServiceOptions = {
    databaseUrl,
    testMode: options.outage === 'hook',
    tenant: { id: tenant, credential: apiKey.credential, seedFile, dir },
    env: {
      ...objectStore,
      DOCEDIT_PUBLIC_URL: relay.url,
      DOCEDIT_VIEW_KEY: randomBytes(32).toString('base64'),
      DOCEDIT_CURSOR_SECRET: randomBytes(32).toString('base64url'),
      DOCEDIT_SIGNING_JWK: JSON.stringify({ ...serviceKey, kid: 'fault-run-service' }),
      DOCEDIT_WORKERS: '1',
    },
  };
  let service: ServiceHandle = await startServiceProcess(start);
  let serviceStarts = 1;
  let output = '';
  let cut = false;
  relay.setTarget(service.url);

  const rest = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${service.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey.credential}`,
        'Content-Type': 'application/json',
        Connection: 'close',
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const created = await rest('POST', '/v1/documents', { content: runDocument() });
  if (created.status !== 201)
    throw new Error(`creating the document answered ${created.status}: ${await created.text()}`);
  const docId = ((await created.json()) as { id: string }).id;
  // The unequal grant: Ada may change the restricted region, Grace may only read it (07 §4).
  const grants = await rest('GET', `/v1/documents/${docId}/grants`);
  if (grants.status !== 200) throw new Error(`reading the grants answered ${grants.status}`);
  const patched = await rest(
    'PATCH',
    `/v1/documents/${docId}/grants`,
    { grants: [{ region: IDS.legalRegion, principal: 'user:ada', role: 'editor' }] },
    { 'If-Match': grants.headers.get('etag') ?? '' },
  );
  if (patched.status !== 200)
    throw new Error(`granting the region answered ${patched.status}: ${await patched.text()}`);

  return {
    endpoint: relay.url,
    docId,
    tenant,
    token(sub) {
      const who = ROLES[sub];
      if (!who) throw new Error(`no such user in the run: ${sub}`);
      const iat = Math.floor(Date.now() / 1000);
      return signJws(
        { alg: 'ES256', typ: 'JWT', kid },
        {
          iss: 'https://host.fault-run.test',
          // The service identifier is its public address when none is configured (server.ts).
          aud: relay.url,
          iat,
          exp: iat + 300,
          jti: randomUUID(),
          tid: tenant,
          sub,
          name: who.name,
          docs: { [docId]: who.role },
          ...(who.wfr ? { wfr: who.wfr } : {}),
        },
        hostPair.privateKey,
      );
    },
    dropConnections: () => relay.dropAll(),
    cutNetwork() {
      cut = true;
      relay.setTarget(null);
      relay.dropAll();
    },
    restoreNetwork() {
      cut = false;
      relay.setTarget(service.url);
    },
    async killService(downMs) {
      output += `${service.output()}\n== the process ${service.pid} was killed ==\n`;
      await service.kill();
      relay.setTarget(null);
      relay.dropAll();
      await sleep(downMs);
      service = await startServiceProcess(start);
      serviceStarts++;
      if (!cut) relay.setTarget(service.url);
    },
    async databaseOutage(ms) {
      if (options.outage === 'hook') {
        await rest('POST', '/_test/database', { down: true });
        await sleep(ms);
        await rest('POST', '/_test/database', { down: false });
        return;
      }
      // PostgreSQL takes the database away from the service: no new session, and the open ones end.
      await control.query(`ALTER DATABASE ${db.name} WITH ALLOW_CONNECTIONS false`);
      try {
        await control.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [db.name],
        );
        await sleep(ms);
      } finally {
        await control.query(`ALTER DATABASE ${db.name} WITH ALLOW_CONNECTIONS true`);
      }
    },
    async stored() {
      const r = await rest('GET', `/v1/documents/${docId}/content`);
      if (r.status !== 200) throw new Error(`reading the content answered ${r.status}`);
      const json = (await r.json()) as { seq: number; doc: unknown };
      return { seq: json.seq, doc: json.doc };
    },
    counts: () => {
      const n = relay.counts();
      return { serviceStarts, sockets: n.sockets, socketsDropped: n.dropped };
    },
    serviceOutput: () => output + service.output(),
    async close() {
      await service.stop().catch(() => {});
      await relay.close();
      await control.query(`ALTER DATABASE ${db.name} WITH ALLOW_CONNECTIONS true`).catch(() => {});
      await control.end().catch(() => {});
      await db.drop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}
