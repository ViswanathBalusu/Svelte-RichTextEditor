// A pinned content read that a cached copy could answer is still checked against the history gate
// before the copy is served (BE-036 criterion 5; 07 §8; PRM-041; SR-C4). The service runs over HTTP
// with in-memory storage and the version-pinned content cache of BE-075 switched on. Test values only.
import { randomUUID } from 'node:crypto';
import { type StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterEach, describe, expect, it } from 'vitest';
import { StubDataPlane, documentWithRegions, hostKey } from '../../test/control-plane/support.ts';
import { configFromEnv } from '../config.ts';
import { memoryParts, startService, type Service, type ServiceParts } from '../server.ts';
import type { DocRef } from '../storage/types.ts';
import { signJws } from './jwt.ts';
import { hashSecret } from './tenants.ts';
import { newApiKey, signingKey } from './tokens.ts';
import { FULL_VIEWS } from './visibility.ts';

const INTRO = 'pIntro0000000001';

let running: Service | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

/** Appends one text insertion per entry of `texts`, as an editor's steps would. */
async function append(parts: ServiceParts, ref: DocRef, texts: string[]): Promise<void> {
  const epoch = await parts.ownership.claim(ref, 'be-036-gate-node');
  const head = await parts.logs.head(ref);
  const perms = await parts.grants.current(ref);
  let at = -1;
  cdmSchema()
    .nodeFromJSON(documentWithRegions()['doc'])
    .descendants((n, pos) => {
      if (n.attrs['id'] === INTRO) at = pos + 1;
      return at < 0;
    });
  const commits = texts.map((t, i): StoredCommit => ({
    seq: head.seq + 1 + i,
    id: uuid7(),
    kind: 'steps',
    steps: [
      { stepType: 'replace', from: at, to: at, slice: { content: [{ type: 'text', text: t }] } },
    ] as StoredCommit['steps'],
    user: 'u-test',
    session: 'session-test',
    time: 0,
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
    fromSeq: head.seq + 1,
    commits,
  });
  if (r.status !== 'ok') throw new Error(`append refused: ${r.status}`);
}

async function start() {
  const parts = memoryParts();
  const service = await startService({
    config: { ...configFromEnv({}), port: 0, workers: 1 },
    parts,
    signing: signingKey(undefined, 'be-036-pinned-gate'),
    createDataPlane: () => new StubDataPlane(),
    // Full views: no read restriction, so the copy is kept (the default views restrict every read).
    views: FULL_VIEWS,
    pinnedCache: { enabled: () => true, maxEntries: 10 },
  });
  running = service;
  const tenant = randomUUID();
  await parts.registry.putTenant(tenant, 'Test tenant');
  const host = hostKey('EdDSA');
  await parts.registry.addKey(tenant, { kid: host.kid, use: 'user', alg: host.alg, jwk: host.jwk });
  const key = newApiKey(tenant);
  await parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
  const userToken = (docs: Record<string, string>, sub: string): string => {
    const iat = Math.floor(Date.now() / 1000);
    return signJws(
      { alg: host.alg, typ: 'JWT', kid: host.kid },
      {
        iss: 'https://host.example.test',
        aud: service.url,
        iat,
        exp: iat + 600,
        jti: uuid7(),
        tid: tenant,
        sub,
        docs,
      },
      host.privateKey,
    );
  };
  const call = async (method: string, path: string, token: string) => {
    const res = await fetch(`${service.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON.
    }
    return { status: res.status, text, json };
  };
  const create = async (): Promise<string> => {
    const res = await fetch(`${service.url}/v1/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: documentWithRegions() }),
    });
    if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
    return ((await res.json()) as { id: string }).id;
  };
  return { service, parts, tenant, userToken, call, create };
}

describe('a cached pinned copy is not served past the history gate (BE-036 criterion 5)', () => {
  it('refuses a viewer below the gate even when the owner has put that seq in the cache', async () => {
    const r = await start();
    const cache = r.service.pinnedCache!;
    const doc = await r.create();
    await append(r.parts, { tenant: r.tenant, doc }, ['a', 'b']);

    // The owner's pinned read at seq 0 fills the cache.
    const owner = r.userToken({ [doc]: 'owner' }, 'alice');
    const warm = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, owner);
    expect(warm.status).toBe(200);
    expect(cache.entries(r.tenant)).toBe(1);

    // Under the default `editors` setting a viewer sees the head only: seq 0 is below the gate. The
    // copy is held, yet it is refused and nothing from it is served.
    const viewer = r.userToken({ [doc]: 'viewer' }, 'bob');
    const below = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, viewer);
    expect(below.status).toBe(403);
    expect(below.json.code).toBe('forbidden');
    expect(below.text).not.toContain('Hello');
    expect(cache.stats.hits).toBe(0);

    // The head is above the gate and is served to the viewer.
    const head = await r.call('GET', `/v1/documents/${doc}/content?seq=2`, viewer);
    expect(head.status).toBe(200);
    expect(head.json).toMatchObject({ seq: 2 });
  });
});
