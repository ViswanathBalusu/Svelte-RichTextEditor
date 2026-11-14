// Service calls on behalf of a user (UX-097 criteria 1 and 2), run against the real document
// service in memory. The host calls the service with its service credential and names the acting
// person in `DEP-Actor`. A prefill is a content-changing, server-authored commit (12 §9): its commit
// in the log must name the person's surrogate and carry origin `prefill`. Without `DEP-Actor` the
// same call is attributed to `system`. The audit entry is not checked here: the audit store records
// only rejections (services/document-service/src/data-plane/audit.ts), so criterion 1 stays open.
import { afterEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './support.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

interface Envelope {
  doc: { content: Array<{ content: unknown[] }> };
  requires?: string[];
}

/** A document with one text form field the host may prefill (12 §3.2, §9). */
async function documentWithField(harness: Harness, externalId: string): Promise<string> {
  const template = harness.host.seed.templates.find((t) => t.key === 'two-regions')!;
  const { templateContent } = await import('../src/lib/server/documents.ts');
  const content = (await templateContent(
    harness.host.config.seedDir,
    template,
  )) as unknown as Envelope;
  content.requires = [...(content.requires ?? []), 'fields'];
  content.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  content.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pAttr00000000001', style: 'Normal' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: 'fAttr00000000001',
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          value: null,
        },
      },
    ],
  });
  const created = await harness.host.service.createDocument(
    { content, externalId, title: 'Attribution' } as never,
    externalId,
    'u-olivia',
  );
  return created.id;
}

async function rest(
  harness: Harness,
  method: string,
  path: string,
  opts: { actor?: string; body?: unknown; ifMatch?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${harness.apiKey}` };
  if (opts.actor !== undefined) headers['DEP-Actor'] = opts.actor;
  if (opts.ifMatch !== undefined) headers['If-Match'] = opts.ifMatch;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${harness.rest}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

interface CommitItem {
  seq: number;
  author: { user: string; session: string | null; agent: string | null };
  origin?: string;
  [k: string]: unknown;
}

async function prefillCommits(harness: Harness, doc: string): Promise<CommitItem[]> {
  const res = await rest(harness, 'GET', `/documents/${doc}/commits?after=0&limit=200`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: CommitItem[] };
  return body.items.filter((c) => c.origin === 'prefill');
}

describe('service calls on behalf of a user (UX-097)', () => {
  it('a prefill with DEP-Actor is attributed to the named person surrogate, with origin prefill (criterion 1, commit part)', async () => {
    h = await startHarness();
    const doc = await documentWithField(h, 'attr-prefill-1');

    const fields = await rest(h, 'GET', `/documents/${doc}/field-values`);
    expect(fields.status).toBe(200);
    const etag = fields.headers.get('etag');
    expect(etag).toBeTruthy();

    const patched = await rest(h, 'PATCH', `/documents/${doc}/field-values`, {
      actor: 'u-olivia',
      ifMatch: etag!,
      body: { values: { 'tenant.name': 'Grace' } },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);

    // The wire names the person by sub: the service maps surrogates back to subs (kit.ts `subsOf`).
    const commits = await prefillCommits(h, doc);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.author.user).toBe('u-olivia');
    expect(commits[0]!.author.session).toBeNull();
    // Storage holds the surrogate, not the sub: the log's own record names the bare surrogate.
    const surrogate = (await h.service.parts.users.resolve(h.tenant, 'u-olivia')).surrogate;
    expect(surrogate).not.toBe('u-olivia');
    const stored = await h.service.parts.logs.read({ tenant: h.tenant, doc }, 1, 1);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.user).toBe(surrogate);
    expect(stored[0]!.origin).toBe('prefill');
  });

  it('a prefill with no DEP-Actor is attributed to system, not to a person (criterion 2)', async () => {
    h = await startHarness();
    const doc = await documentWithField(h, 'attr-prefill-2');

    const fields = await rest(h, 'GET', `/documents/${doc}/field-values`);
    const patched = await rest(h, 'PATCH', `/documents/${doc}/field-values`, {
      ifMatch: fields.headers.get('etag')!,
      body: { values: { 'tenant.name': 'Grace' } },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);

    const commits = await prefillCommits(h, doc);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.author.user).toBe('system');
    const stored = await h.service.parts.logs.read({ tenant: h.tenant, doc }, 1, 1);
    expect(stored[0]!.user).toBe('system');
  });
});
