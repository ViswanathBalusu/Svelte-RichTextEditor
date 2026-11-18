// BE-037 (lane w5): the same `PUT /documents/{id}/content` sent twice stores one snapshot commit.
// The route requires `If-Match`, whose ETag carries the head, so the second PUT of the pair no
// longer matches and is refused; the data plane also derives the commit identifier from the head
// and the content (BE-039), so a delivery repeated after a crash is one commit. This is the whole
// service in one process over memory storage. It does not show `Idempotency-Key` on this route,
// which the route does not accept (docs/adr/0381-w5-BE-037-put-content-idempotency-key.md).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { startService, type Service } from '../../src/server.ts';
import { documentWithRegions } from '../control-plane/support.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
type Json = Record<string, any>;

describe('the same PUT of content twice stores one snapshot commit (BE-037)', () => {
  let s: Service;
  let apiKey: string;
  let tenant: string;
  beforeAll(async () => {
    s = await startService({ config: { ...configFromEnv({}), port: 0, workers: 1 } });
    tenant = randomUUID();
    await s.parts.registry.putTenant(tenant, 'be-037 w5');
    const key = newApiKey(tenant);
    await s.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
    apiKey = key.credential;
  });
  afterAll(async () => {
    await s?.close();
  });

  const call = async (method: string, path: string, body?: unknown, headers: object = {}) => {
    const res = await fetch(`${s.url}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: (text ? JSON.parse(text) : {}) as Json,
    };
  };

  it('answers 204 once and refuses the repeat, with one snapshot commit in the log', async () => {
    const doc = (await call('POST', '/documents', { content: documentWithRegions() })).json[
      'id'
    ] as string;
    const read = await call('GET', `/documents/${doc}/content`);
    const etag = read.headers.get('etag')!;
    const replacement = JSON.parse(
      JSON.stringify(documentWithRegions()).replace('Lease agreement', 'Lease agreement, amended'),
    );
    const first = await call('PUT', `/documents/${doc}/content`, replacement, { 'If-Match': etag });
    expect(first.status).toBe(204);
    const again = await call('PUT', `/documents/${doc}/content`, replacement, {
      'If-Match': etag,
    });
    expect(again.status).toBe(412);
    expect(again.json['code']).toBe('precondition_failed');

    // One snapshot commit: the head is seq 1, and the log holds that commit and no other.
    const head = await s.parts.logs.head({ tenant, doc });
    expect(head.seq).toBe(1);
    const [stored] = await s.parts.logs.read({ tenant, doc }, 1, 1);
    expect(stored).toMatchObject({ seq: 1, kind: 'snapshot' });
  });
});
