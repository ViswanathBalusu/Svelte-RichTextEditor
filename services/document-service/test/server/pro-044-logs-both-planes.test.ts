// Logs and traces of the whole service hold no document content and no token (PRO-044 criterion
// 4; lane V-PRO-035-051). One process, the real `startService`: REST requests with a secret title
// and a secret token, a traced WebSocket session that types a secret passage and commits it, and a
// connection that presents a bogus token. Every structured log line and every span the process
// writes is searched for the typed text, the title, the valid token, the bogus token, the API key
// and the database password. The searches are not vacuous: the test first checks that REST and
// session lines and spans exist. Runs on memory storage and on PostgreSQL in Podman
// (docedit-test-postgres); the PostgreSQL run skips when the database is not up.
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { configFromEnv } from '../../src/config.ts';
import { createLogger } from '../../src/log.ts';
import { startService, type Service } from '../../src/server.ts';
import type { Span } from '../../src/seams.ts';
import { documentWithRegions } from '../control-plane/support.ts';
import { DepClient } from '../data-plane/client.ts';
import { createTestDatabase, postgresUnavailable } from '../support/env.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
type Json = Record<string, any>;

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE}-00f067aa0ba902b7-01`;
const SECRET_TEXT = 'pro044 full service typed passage 5e21';
const SECRET_TITLE = 'pro044 full service secret title 8a0d';
const BOGUS_TOKEN = 'bogus-token-pro044-full-service-3c7e';

const pgSkip = await postgresUnavailable();

for (const storage of ['memory', 'postgres'] as const)
  describe.skipIf(storage === 'postgres' && pgSkip !== null)(
    `logs and spans of the whole service hold no content and no token (PRO-044 criterion 4; ${storage})`,
    () => {
      let s: Service;
      let apiKey: string;
      let dbPassword: string | undefined;
      let drop: (() => Promise<void>) | null = null;
      const lines: string[] = [];
      const spans: Span[] = [];

      beforeAll(async () => {
        let databaseUrl: string | null = null;
        if (storage === 'postgres') {
          const db = await createTestDatabase();
          const c = db.serviceConfig;
          dbPassword = typeof c.password === 'string' ? c.password : undefined;
          databaseUrl = `postgres://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`;
          await db.service.end();
          drop = () => db.drop();
        }
        s = await startService({
          config: { ...configFromEnv({}), port: 0, workers: 1, databaseUrl },
          logger: createLogger((line) => void lines.push(line)),
          onSpan: (span) => void spans.push(span),
        });
        const tenant = randomUUID();
        await s.parts.registry.putTenant(tenant, 'pro044 logs');
        const key = newApiKey(tenant);
        await s.parts.registry.addApiKey(tenant, {
          id: key.id,
          secretHash: hashSecret(key.secret),
        });
        apiKey = key.credential;
      });
      afterAll(async () => {
        await s?.close();
        await drop?.();
      });

      const rest = async (method: string, path: string, body?: unknown, token = apiKey) => {
        const res = await fetch(`${s.url}/v1${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, json: (await res.json().catch(() => null)) as Json | null };
      };

      it('keeps the typed text, the title, the tokens and the database password out of logs and spans', async () => {
        const created = await rest('POST', '/documents', {
          content: documentWithRegions(),
          properties: { title: SECRET_TITLE },
        });
        expect(created.status).toBe(201);
        const doc = created.json!['id'] as string;
        const token = (await rest('POST', '/tokens', { sub: 'ann', docs: { [doc]: 'editor' } }))
          .json!['token'] as string;
        await rest('GET', `/documents/${doc}`, undefined, apiKey);
        await rest('GET', `/documents/${doc}`, undefined, BOGUS_TOKEN);
        await rest('GET', `/documents/${doc}/content`, undefined, BOGUS_TOKEN);

        const ws = `${s.url.replace('http:', 'ws:')}/dep`;
        const c = await DepClient.connect(ws);
        try {
          expect((await c.hello(token, { traceparent: TRACEPARENT })).t).toBe('welcome');
          expect((await c.open(1, doc)).t).toBe('ch.opened');
          const content = (await rest('GET', `/documents/${doc}/content`)).json!;
          let pos = -1;
          cdmSchema()
            .nodeFromJSON(content['doc'])
            .descendants((n, p) => {
              if (n.attrs['id'] === 'pIntro0000000001') pos = p + 1;
              return pos < 0;
            });
          expect(pos).toBeGreaterThan(0);
          const ack = await c.submit(1, {
            id: uuid7(),
            base: 0,
            steps: [
              {
                stepType: 'replace',
                from: pos,
                to: pos,
                slice: { content: [{ type: 'text', text: SECRET_TEXT }] },
              },
            ],
            origin: 'input',
          });
          expect(ack.t).toBe('sync.ack');
        } finally {
          c.close();
        }

        const bad = await DepClient.connect(`${s.url.replace('http:', 'ws:')}/dep`);
        try {
          expect((await bad.hello(BOGUS_TOKEN)).t).toBe('error');
        } finally {
          bad.close();
        }

        // Let the traced session close and its spans end before the search.
        await new Promise((r) => setTimeout(r, 200));
        const logged = lines.join('\n');
        const traced = spans.map((sp) => JSON.stringify(sp)).join('\n');
        // Not vacuous: REST lines and spans exist, and the session's commit was traced.
        expect(logged).toContain('"event":"http"');
        expect(traced).toContain('"name":"dep.commit"');
        expect(traced).toContain('"name":"dep.session"');
        for (const text of [logged, traced]) {
          expect(text).not.toContain(SECRET_TEXT);
          expect(text).not.toContain(SECRET_TITLE);
          expect(text).not.toContain(token);
          expect(text).not.toContain(BOGUS_TOKEN);
          expect(text).not.toContain(apiKey);
          if (dbPassword) expect(text).not.toContain(dbPassword);
        }
      });
    },
  );
