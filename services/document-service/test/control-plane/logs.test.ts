// Structured logs without content or credentials (BE-088; 06 §11; 10 §3.7): every request is
// logged as JSON with identifiers, and canary strings put in document text, properties, filenames,
// tokens, API keys and query signatures never reach a log line.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { createLogger, errorFields, redactUrl } from '../../src/log.ts';
import { startService } from '../../src/server.ts';
import { documentWithRegions, StubDataPlane } from './support.ts';

const CANARY = 'CANARY7a1c';

describe('logs carry identifiers and never content (BE-088)', () => {
  it('writes one JSON object per line, with known members only (criterion 1)', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    log.info({
      event: 'x',
      tenant: 't',
      doc: 'd',
      session: 's',
      requestId: 'r',
      ...({ body: `${CANARY} text`, token: CANARY } as object),
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'x',
      tenant: 't',
      doc: 'd',
      session: 's',
      requestId: 'r',
      level: 'info',
    });
    expect(lines[0]).not.toContain(CANARY);
    // Errors are logged by name and stack frames, never by message (criterion 3).
    const e = new SyntaxError(`Unexpected token in "${CANARY}"`);
    expect(JSON.stringify(errorFields(e))).not.toContain(CANARY);
    expect(errorFields(e).error).toBe('SyntaxError');
  });

  it('drops query values, so signatures and tokens in URLs are never logged (criterion 4)', () => {
    expect(redactUrl(`/v1/x?X-Amz-Signature=${CANARY}&X-Amz-Credential=${CANARY}&seq=1`)).toBe(
      '/v1/x?X-Amz-Signature=[redacted]&X-Amz-Credential=[redacted]&seq=[redacted]',
    );
  });

  it('keeps canaries out of every line logged for real requests (criteria 1 to 4)', async () => {
    const recorded: string[] = [];
    const s = await startService({
      config: { ...configFromEnv({}), port: 0, workers: 1 },
      logger: createLogger((l) => recorded.push(l)),
      createDataPlane: () => new StubDataPlane(),
    });
    try {
      const tenant = randomUUID();
      await s.parts.registry.putTenant(tenant, 'log tenant');
      const key = newApiKey(tenant);
      await s.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
      const auth = {
        Authorization: `Bearer ${key.credential}`,
        'Content-Type': 'application/json',
      };
      const content = documentWithRegions() as {
        doc: { content: Array<{ content: Array<{ content?: unknown[] }> }> };
      };
      content.doc.content[1]!.content[0]!.content = [
        { type: 'text', text: `${CANARY} secret text` },
      ];
      const created = await fetch(`${s.url}/v1/documents`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          content,
          title: `${CANARY} title`,
          properties: { filename: `${CANARY}.docx`, note: CANARY },
          externalId: 'log-1',
        }),
      });
      expect(created.status).toBe(201);
      const doc = ((await created.json()) as { id: string }).id;
      await fetch(`${s.url}/v1/documents/${doc}/content?sig=${CANARY}`, { headers: auth });
      // A validation error names the position and the rule, not the text (criterion 3).
      const bad = await fetch(`${s.url}/v1/documents`, {
        method: 'POST',
        headers: auth,
        body: `{"title": "${CANARY}", "properties": "${CANARY}"}`,
      });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(await bad.json())).not.toContain(CANARY);
      const broken = await fetch(`${s.url}/v1/documents`, {
        method: 'POST',
        headers: auth,
        body: `{"title": "${CANARY}`,
      });
      expect(broken.status).toBe(400);
      expect(JSON.stringify(await broken.json())).not.toContain(CANARY);
      await fetch(`${s.url}/v1/documents/${doc}`, {
        headers: { Authorization: `Bearer ${CANARY}.${CANARY}.${CANARY}` },
      });
      const minted = await fetch(`${s.url}/v1/tokens`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ sub: CANARY, docs: { [doc]: 'viewer' } }),
      });
      const token = ((await minted.json()) as { token: string }).token;
      await fetch(`${s.url}/v1/documents/${doc}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(recorded.length).toBeGreaterThanOrEqual(7);
      for (const line of recorded) {
        for (const secret of [CANARY, key.credential, key.secret, token])
          expect(line).not.toContain(secret);
        expect(JSON.parse(line).event).toBeTypeOf('string');
      }
      const access = recorded.map((l) => JSON.parse(l)).filter((e) => e.event === 'http');
      for (const e of access) expect(e.requestId).toBeTypeOf('string');
      const forDoc = access.filter((e) => e.doc === doc);
      expect(forDoc.length).toBeGreaterThanOrEqual(3);
      for (const e of forDoc.filter((x) => x.status < 400)) expect(e.tenant).toBe(tenant);
    } finally {
      await s.close();
    }
  });
});
