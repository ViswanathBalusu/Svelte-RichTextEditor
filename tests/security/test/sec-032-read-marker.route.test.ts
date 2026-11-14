/**
 * SEC-032 criterion 5 (lane V-SEC-017-032), through the route: a read marker update that would
 * lower the marker is refused. The marker only moves forward (05 §6.2; 08 §10; HIS-027 criterion 2),
 * so a `PUT /v1/documents/{id}/read-marker` with a lower `seq` does not change the stored marker,
 * and the answer is the marker in force (no error), which is the refusal the spec gives: the value
 * is not applied. The reading that a lower update must answer with an error code is an open point,
 * recorded in docs/adr/0345-lane-V-SEC-017-032.md.
 *
 * The service is the real one, started in process with in-memory storage. The route, its guard and
 * the store are the product's own code; only test keys generated here are used.
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
import type { DocRef } from '../../../services/document-service/src/storage/types.ts';
import { keyPair, signJws } from './support/jws.ts';
import { documentWithRegions, insertText, posInside } from './support/harness.ts';

const T1 = 1_000_000;
const T2 = 2_000_000;

let open: Service | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

async function rig() {
  const parts = memoryParts();
  const service = await startService({
    config: { ...configFromEnv({}), port: 0, workers: 1 },
    parts,
  });
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
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON.
    }
    return { status: res.status, text, json };
  };

  return {
    service,
    tenant,
    token(sub: string, doc: string, role: string): string {
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
        },
        { key: host.privateKey },
      );
    },
    call,
    api,
    async documentWithHistory(): Promise<string> {
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
  };
}

describe('SEC-032 criterion 5: a read marker update that would lower it is refused', () => {
  it('a lower seq leaves the marker where it is; a higher seq moves it forward', async () => {
    const r = await rig();
    const doc = await r.documentWithHistory();
    const eddie = r.token('eddie', doc, 'editor');

    const up = await r.call('PUT', `/v1/documents/${doc}/read-marker`, eddie, { seq: 2 });
    expect(up.status).toBe(200);
    expect(up.json.seq).toBe(2);

    // Lowering the marker to 1 is not applied: the marker in force stays at 2.
    const lower = await r.call('PUT', `/v1/documents/${doc}/read-marker`, eddie, { seq: 1 });
    expect(lower.json.seq).toBe(2);
    expect(lower.text).not.toContain('"seq":1');

    // Equal is not a move either, and the same answer comes back.
    const same = await r.call('PUT', `/v1/documents/${doc}/read-marker`, eddie, { seq: 2 });
    expect(same.json.seq).toBe(2);
  });

  it('a lower update after a fresh marker at 0 keeps the higher one; a second user has an independent marker', async () => {
    const r = await rig();
    const doc = await r.documentWithHistory();
    const eddie = r.token('eddie', doc, 'editor');
    const vera = r.token('vera', doc, 'viewer');

    await r.call('PUT', `/v1/documents/${doc}/read-marker`, eddie, { seq: 1 });
    const back = await r.call('PUT', `/v1/documents/${doc}/read-marker`, eddie, { seq: 0 });
    expect(back.json.seq).toBe(1);

    // Another user's marker starts at what she sends and is not tied to eddie's.
    const hers = await r.call('PUT', `/v1/documents/${doc}/read-marker`, vera, { seq: 0 });
    expect(hers.status).toBe(200);
    expect(hers.json.seq).toBe(0);
  });
});
