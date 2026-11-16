/**
 * SEC-032 criterion 4 (lane SEC-027-039), through the route: a pinned content read by a user
 * below the history visibility gate is refused by the running service, although a reader above the
 * gate has already put a copy of that very state in the cache (10 §3.3; 06 §7; 07 §8; BE-075;
 * ADR 0019 SR-C4).
 *
 * The service is the real one, started in process with in-memory storage and the pinned cache
 * switched on. The check under test is the content route's own (`check()` and `gateFor` in
 * control-plane/handlers.ts `getContent`); nothing here supplies it. Every reader is in the full
 * visibility class, so the cache key cannot tell them apart: only the per-request check can.
 * Commits are appended to the log as a room would store them, with times the test chooses, so the
 * `since_access` gate has known answers. Only test keys generated here are used.
 */
import { randomUUID } from 'node:crypto';
import {
  configFromEnv,
  hashSecret,
  memoryParts,
  newApiKey,
  startService,
  type Service,
} from '@docedit/document-service';
import type { StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DocRef,
  DocumentStore,
} from '../../../services/document-service/src/storage/types.ts';
import { FULL_VIEWS } from '../../../services/document-service/src/control-plane/visibility.ts';
import { startOnFetchablePort } from '../../../services/document-service/test/support/ports.ts';
import { keyPair, signJws } from './support/jws.ts';
import { documentWithRegions, insertText, posInside } from './support/harness.ts';

/** Commit 1 and commit 2 are stored at these times (ms); `access_since` falls between or before. */
const T1 = 1_000_000;
const T2 = 2_000_000;

interface Rig {
  service: Service;
  tenant: string;
  /** A host-signed user token for `sub` with `role` on `doc`, plus extra claims. */
  token(sub: string, doc: string, role: string, claims?: Record<string, unknown>): string;
  get(path: string, token: string): Promise<{ status: number; text: string; json: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
  /** A document with two commits after its initial state: seq 0, 1 and 2 exist, 2 is the head. */
  documentWithHistory(): Promise<string>;
  /** Makes the stored record of `doc` report `since_access` (the store keeps `editors`). */
  sinceAccess(doc: string): void;
}

let open: Service | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

async function rig(): Promise<Rig> {
  const parts = memoryParts();
  const inner = parts.documents;
  const sinceAccess = new Set<string>();
  // The document store as the service reads it, with the history setting the test chooses.
  parts.documents = new Proxy(inner, {
    get(target, key) {
      if (key === 'get')
        return async (...args: Parameters<DocumentStore['get']>) => {
          const r = await target.get(...args);
          return r && sinceAccess.has(r.id) ? { ...r, historyVisibility: 'since_access' } : r;
        };
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as DocumentStore;
  // A port the system chooses can be one fetch refuses ("bad port"); choose again then.
  const service = await startOnFetchablePort(
    () =>
      startService({
        config: { ...configFromEnv({}), port: 0, workers: 1 },
        parts,
        // Full views: no read restriction, so a copy is kept (the default views restrict every
        // read, and a restricted read is never cached, SR-C4). Every reader is in the full class,
        // as above.
        views: FULL_VIEWS,
        pinnedCache: { enabled: () => true, maxEntries: 100 },
      }),
    (s) => s.url,
    (s) => s.close(),
  );
  open = service;
  const tenant = randomUUID();
  await parts.registry.putTenant(tenant, 'Test tenant');
  const host = keyPair('EdDSA');
  await parts.registry.addKey(tenant, {
    kid: `host-${tenant}`,
    use: 'user',
    alg: 'EdDSA',
    jwk: host.jwk,
  });
  const api = newApiKey(tenant);
  await parts.registry.addApiKey(tenant, { id: api.id, secretHash: hashSecret(api.secret) });

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${service.url}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON.
    }
    return { status: res.status, text, json: json as any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
  };

  return {
    service,
    tenant,
    token(sub, doc, role, claims = {}) {
      const iat = Math.floor(Date.now() / 1000);
      return signJws(
        { alg: host.alg, typ: 'JWT', kid: `host-${tenant}` },
        {
          iss: 'https://host.example.test',
          aud: service.url,
          iat,
          exp: iat + 600,
          jti: uuid7(),
          tid: tenant,
          sub,
          docs: { [doc]: role },
          ...claims,
        },
        { key: host.privateKey },
      );
    },
    get: (path, token) => call('GET', path, token),
    async documentWithHistory() {
      const created = await call('POST', '/v1/documents', api.credential, {
        content: documentWithRegions(),
      });
      if (created.status !== 201) throw new Error(`create failed: ${created.status}`);
      const doc = created.json.id as string;
      const head = await call('GET', `/v1/documents/${doc}/content`, api.credential);
      const at = posInside(head.json.doc, 'pIntro0000000001');
      const ref: DocRef = { tenant, doc };
      const epoch = await parts.ownership.claim(ref, 'test-node');
      const perms = await parts.grants.current(ref);
      const commits = [T1, T2].map((time, i): StoredCommit => ({
        seq: i + 1,
        id: uuid7(),
        kind: 'steps',
        steps: [insertText(at, `${i}`)] as unknown as StoredCommit['steps'],
        user: 'u-test',
        session: 'session-test',
        time,
        origin: 'input',
        scopes: ['body'],
        revision: perms.revision,
        cdm: 1,
        engine: 'pm-steps/1',
        retired: [],
        claimed: [],
      }));
      const r = await parts.logs.append(ref, {
        epoch,
        revision: perms.revision,
        fromSeq: 1,
        commits,
      });
      expect(r.status).toBe('ok');
      return doc;
    },
    sinceAccess: (doc) => void sinceAccess.add(doc),
  };
}

const at = (ms: number) => new Date(ms).toISOString();

describe('SEC-032 criterion 4: the content route refuses a pinned read below the gate, cached or not', () => {
  it('under `editors`: an editor caches seq 1; a viewer and a commenter asking for it get 403, and the home region is not read', async () => {
    const r = await rig();
    const cache = r.service.pinnedCache!;
    const doc = await r.documentWithHistory();
    const editor = r.token('eddie', doc, 'editor');
    const viewer = r.token('vera', doc, 'viewer');
    const commenter = r.token('cora', doc, 'commenter');

    const warm = await r.get(`/v1/documents/${doc}/content?seq=1`, editor);
    expect(warm.status).toBe(200);
    expect(warm.json.seq).toBe(1);
    expect(cache.entries(r.tenant)).toBe(1);

    for (const below of [viewer, commenter]) {
      const before = { ...cache.stats };
      const refused = await r.get(`/v1/documents/${doc}/content?seq=1`, below);
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe('forbidden');
      expect(refused.text).not.toContain('0Hello');
      expect(cache.stats.refused).toBe(before.refused + 1);
      expect(cache.stats.homeReads).toBe(before.homeReads);
      expect(cache.stats.hits).toBe(before.hits);
    }

    // The copy is still held: the editor's next read is a hit with the same bytes.
    const hits = cache.stats.hits;
    const again = await r.get(`/v1/documents/${doc}/content?seq=1`, editor);
    expect(again.status).toBe(200);
    expect(again.text).toBe(warm.text);
    expect(cache.stats.hits).toBe(hits + 1);

    // The viewer may make a pinned read (the guard passes): the head, which is always visible.
    const head = await r.get(`/v1/documents/${doc}/content?seq=2`, viewer);
    expect(head.status).toBe(200);
    expect(head.json.seq).toBe(2);
  });

  it('under `since_access`: an editor with early access caches seq 0; a viewer whose access starts later gets 403', async () => {
    const r = await rig();
    const cache = r.service.pinnedCache!;
    const doc = await r.documentWithHistory();
    r.sinceAccess(doc);
    const editor = r.token('eddie', doc, 'editor', { access_since: at(0) });
    // Access from between the two commits: the gate is seq 1 (the state current at that time).
    const late = r.token('vera', doc, 'viewer', { access_since: at((T1 + T2) / 2) });
    // No access time at all: the gate fails closed to the head.
    const unknown = r.token('vic', doc, 'viewer');

    const warm0 = await r.get(`/v1/documents/${doc}/content?seq=0`, editor);
    expect(warm0.status).toBe(200);
    const warm1 = await r.get(`/v1/documents/${doc}/content?seq=1`, editor);
    expect(warm1.status).toBe(200);
    expect(cache.entries(r.tenant)).toBe(2);

    const asks: Array<[string, number]> = [
      [late, 0],
      [unknown, 0],
      [unknown, 1],
    ];
    for (const [token, seq] of asks) {
      const before = { ...cache.stats };
      const refused = await r.get(`/v1/documents/${doc}/content?seq=${seq}`, token);
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe('forbidden');
      expect(cache.stats.refused).toBe(before.refused + 1);
      expect(cache.stats.homeReads).toBe(before.homeReads);
      expect(cache.stats.hits).toBe(before.hits);
    }

    // At or above their gate the late viewer is served, from the copy the editor made.
    const hits = cache.stats.hits;
    const allowed = await r.get(`/v1/documents/${doc}/content?seq=1`, late);
    expect(allowed.status).toBe(200);
    expect(allowed.text).toBe(warm1.text);
    expect(cache.stats.hits).toBe(hits + 1);
  });
});
