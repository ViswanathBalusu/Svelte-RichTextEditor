// Service calls on behalf of a user (UX-097 criterion 1, commit part), run against the demo stack
// (lane V-UX-091-104). The host's service credential calls the document service of the running
// stack, which keeps its commit log in PostgreSQL in a Podman container. A prefill named with
// `DEP-Actor` must leave a commit whose stored user is the person's surrogate (not the sub, not
// the service) with origin `prefill`. The audit half of criterion 1 is not checked here: the audit
// store records only rejections (services/document-service/src/data-plane/audit.ts, 07 section 14),
// so criterion 1 stays open. Run the stack first, then:
//
//   $env:DOCEDIT_DEMO_REUSE = '1'   (and the lane's DOCEDIT_DEMO_* ports and project, see the notes)
//   pnpm exec vitest run apps/reference-host/test/v-ux-097-attribution.stack.test.ts
//
// The test skips, with the reason, when DOCEDIT_DEMO_REUSE is not set. It creates one document whose
// title carries the lane's name, and deletes it afterwards.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_DIR, dataDir, endpoints, readSecrets, stackSettings } from '../scripts/lib/stack.ts';
import { templateContent } from '../src/lib/server/documents.ts';

const run = promisify(execFile);
const RUN = Date.now().toString(36);
const ENABLED = process.env['DOCEDIT_DEMO_REUSE'] === '1';

interface Envelope {
  requires?: string[];
  doc: { content: Array<{ content: unknown[] }> };
}

interface CommitItem {
  seq: number;
  author: { user: string; session: string | null; agent: string | null };
  origin?: string;
}

describe.skipIf(!ENABLED)(
  'service calls on behalf of a user, against the demo stack (UX-097 criterion 1, commit part)',
  () => {
    const settings = stackSettings();
    const ends = endpoints(settings);
    const rest = `${ends.serviceUrl}/v1`;
    const created: string[] = [];
    let apiKey = '';

    async function call(
      method: string,
      path: string,
      opts: { actor?: string; ifMatch?: string; body?: unknown; key?: string } = {},
    ): Promise<Response> {
      const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
      if (opts.actor !== undefined) headers['DEP-Actor'] = opts.actor;
      if (opts.ifMatch !== undefined) headers['If-Match'] = opts.ifMatch;
      if (opts.key !== undefined) headers['Idempotency-Key'] = opts.key;
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      return fetch(`${rest}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    }

    /** The stored commits of a document, read by the psql client inside the PostgreSQL container. */
    async function storedCommits(
      doc: string,
    ): Promise<Array<{ seq: string; userId: string; origin: string }>> {
      const container = `${settings['DOCEDIT_DEMO_PROJECT'] ?? 'docedit-demo'}-postgres`;
      const sql = `select seq, user_id, origin from doc_commits where doc_id = '${doc}' order by seq`;
      const { stdout } = await run(
        'podman',
        [
          'exec',
          container,
          'bash',
          '-c',
          `PGPASSWORD='${settings['DOCEDIT_DEMO_PG_ADMIN_PASSWORD']}' psql -h 127.0.0.1 -p ${settings['DOCEDIT_DEMO_PG_PORT']} -U ${settings['DOCEDIT_DEMO_PG_ADMIN_USER']} -d ${settings['DOCEDIT_DEMO_PG_DATABASE']} -At -F '|' -c "${sql}"`,
        ],
        { maxBuffer: 1_000_000 },
      );
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [seq, userId, origin] = line.split('|');
          return { seq: seq!, userId: userId!, origin: origin! };
        });
    }

    async function documentWithField(externalId: string): Promise<string> {
      const template = { key: 'two-regions', content: 'two-regions.cdm.json' } as never;
      const content = (await templateContent(
        join(APP_DIR, 'seed'),
        template,
      )) as unknown as Envelope;
      content.requires = [...(content.requires ?? []), 'fields'];
      content.doc.content[0]!.content.push({
        type: 'role_def',
        attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
      });
      content.doc.content[1]!.content.push({
        type: 'paragraph',
        attrs: { id: 'pAttr00000000002', style: 'Normal' },
        content: [
          {
            type: 'form_field',
            attrs: {
              id: 'fAttr00000000002',
              key: 'tenant.name',
              kind: 'text',
              label: 'Name',
              assignee: 'tenant',
              value: null,
            },
          },
        ],
      });
      const res = await call('POST', '/documents', {
        key: externalId,
        body: { content, externalId, title: `V-UX-091-104 attribution ${RUN}` },
      });
      expect(res.status, await res.clone().text()).toBeLessThan(300);
      const body = (await res.json()) as { id: string };
      created.push(body.id);
      return body.id;
    }

    afterAll(async () => {
      for (const id of created) {
        const etag = await call('GET', `/documents/${id}`).then((r) => r.headers.get('etag'));
        if (etag)
          await call('DELETE', `/documents/${id}`, { ifMatch: etag }).catch(() => undefined);
      }
    });

    it('a prefill with DEP-Actor is stored with the person surrogate and origin prefill; without it, system', async () => {
      apiKey = (await readSecrets(dataDir())).apiKey.credential;

      const withActor = await documentWithField(`v-ux-091-104-attr-a-${RUN}`);
      const fields = await call('GET', `/documents/${withActor}/field-values`);
      expect(fields.status).toBe(200);
      const patched = await call('PATCH', `/documents/${withActor}/field-values`, {
        actor: 'u-olivia',
        ifMatch: fields.headers.get('etag')!,
        body: { values: { 'tenant.name': 'Grace' } },
      });
      expect(patched.status, await patched.clone().text()).toBe(200);

      const wire = (await (
        await call('GET', `/documents/${withActor}/commits?after=0&limit=200`)
      ).json()) as {
        items: CommitItem[];
      };
      const prefills = wire.items.filter((c) => c.origin === 'prefill');
      expect(prefills).toHaveLength(1);
      expect(prefills[0]!.author.user).toBe('u-olivia');

      const stored = (await storedCommits(withActor)).filter((c) => c.origin === 'prefill');
      expect(stored).toHaveLength(1);
      expect(stored[0]!.userId).not.toBe('u-olivia');
      expect(stored[0]!.userId).not.toBe('system');
      expect(stored[0]!.userId.length).toBeGreaterThan(0);

      const without = await documentWithField(`v-ux-091-104-attr-b-${RUN}`);
      const fields2 = await call('GET', `/documents/${without}/field-values`);
      const patched2 = await call('PATCH', `/documents/${without}/field-values`, {
        ifMatch: fields2.headers.get('etag')!,
        body: { values: { 'tenant.name': 'Grace' } },
      });
      expect(patched2.status, await patched2.clone().text()).toBe(200);
      const storedNoActor = (await storedCommits(without)).filter((c) => c.origin === 'prefill');
      expect(storedNoActor).toHaveLength(1);
      expect(storedNoActor[0]!.userId).toBe('system');
    });
  },
);
