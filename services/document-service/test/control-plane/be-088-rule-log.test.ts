/**
 * BE-088 criterion 3 (lane V-BE-085-098): a validation or parse error is logged with its position
 * and its rule, and never with the offending text. Run against the real service over HTTP.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { createLogger, violationSummary } from '../../src/log.ts';
import { startService } from '../../src/server.ts';
import { StubDataPlane } from './support.ts';

const CANARY = 'RULELOG9d2e';

describe('validation and parse errors are logged by position and rule (BE-088 criterion 3)', () => {
  it('names the path and the rule of each violation, and of a body that is not JSON', () => {
    expect(violationSummary([{ path: '/title', rule: 'a string' }])).toBe('/title: a string');
    expect(violationSummary([{ path: '', rule: 'valid JSON (RFC 8259)' }])).toBe(
      '(body): valid JSON (RFC 8259)',
    );
    // A key the client chose is not written; its place is marked instead.
    expect(violationSummary([{ path: `key=${CANARY}`, rule: 'a key of the document' }])).toBe(
      `(key): a key of the document`,
    );
    expect(
      violationSummary([
        { path: '/a', rule: 'r' },
        { path: '/b', rule: 'r' },
        { path: '/c', rule: 'r' },
        { path: '/d', rule: 'r' },
      ]),
    ).toBe('/a: r; /b: r; /c: r; and 1 more');
    expect(violationSummary(undefined)).toBeUndefined();
  });

  it('writes the summary on the access line of a refused request, and no canary', async () => {
    const recorded: string[] = [];
    const s = await startService({
      config: { ...configFromEnv({}), port: 0, workers: 1 },
      logger: createLogger((l) => recorded.push(l)),
      createDataPlane: () => new StubDataPlane(),
    });
    try {
      const tenant = randomUUID();
      await s.parts.registry.putTenant(tenant, 'rule log tenant');
      const key = newApiKey(tenant);
      await s.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
      const auth = {
        Authorization: `Bearer ${key.credential}`,
        'Content-Type': 'application/json',
      };

      const bad = await fetch(`${s.url}/v1/documents`, {
        method: 'POST',
        headers: auth,
        body: `{"title": "${CANARY}", "properties": "${CANARY}"}`,
      });
      expect(bad.status).toBe(400);
      const broken = await fetch(`${s.url}/v1/documents`, {
        method: 'POST',
        headers: auth,
        body: `{"title": "${CANARY}`,
      });
      expect(broken.status).toBe(400);

      const lines = recorded.map((l) => JSON.parse(l) as Record<string, unknown>);
      const access = lines.filter((e) => e['event'] === 'http' && e['status'] === 400);
      expect(access.length).toBeGreaterThanOrEqual(2);
      for (const e of access) expect(typeof e['message']).toBe('string');
      expect(access.some((e) => e['message'] === '(body): valid JSON (RFC 8259)')).toBe(true);
      expect(access.some((e) => String(e['message']).includes('/properties'))).toBe(true);
      for (const l of recorded) expect(l).not.toContain(CANARY);
    } finally {
      await s.close();
    }
  });
});
