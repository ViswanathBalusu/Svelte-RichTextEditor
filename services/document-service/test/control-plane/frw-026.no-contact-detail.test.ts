// FRW-026 criterion 4: the workflow and participant schemas hold no contact detail. Only `sub` and
// `name` identify a person (12 §7; PRODUCT: the host owns people). Three places are read:
// the published JSON Schema (spec/dep/dep-1.schema.json), the resource's HTTP route (a contact
// member is refused and nothing is stored), and, on PostgreSQL in Podman (infra/test-env.ps1), the
// columns of the tables that hold the resource.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTenant } from '../../src/storage/db.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

type Schema = { properties?: Record<string, Schema>; items?: Schema; [k: string]: unknown };

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/dep/dep-1.schema.json', import.meta.url)),
    'utf8',
  ),
) as { $defs: Record<string, Schema> };

/** Words that name a way to reach a person. Matched on each word of a name in camel or snake case. */
const CONTACT =
  /^(e?mails?|phones?|telephones?|tel|mobiles?|cell|msisdn|sms|whatsapp|fax|address|contact|contacts|url|handle)$/i;
const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '');
const isContact = (name: string): boolean => words(name).some((w) => CONTACT.test(w));

/** Every property name under a schema node, with its path. */
function names(node: unknown, path = ''): string[] {
  if (typeof node !== 'object' || node === null) return [];
  const out: string[] = [];
  const n = node as Schema;
  for (const [key, child] of Object.entries(n.properties ?? {})) {
    out.push(`${path}/${key}`, ...names(child, `${path}/${key}`));
  }
  if (n.items) out.push(...names(n.items, `${path}/[]`));
  return out;
}

describe('the published schema holds no contact detail (FRW-026 criterion 4)', () => {
  const workflow = schema.$defs['Workflow']!;
  const participant = workflow.properties!['participants']!.items!;

  it('names exactly the identifying members of a participant: id, roles, kind, order, sub, name and the rest of the resource', () => {
    expect(Object.keys(participant.properties!).sort()).toEqual(
      [
        'auth',
        'completedSeq',
        'firstViewedAt',
        'id',
        'kind',
        'name',
        'order',
        'roles',
        'state',
        'sub',
      ].sort(),
    );
  });

  it('has no property anywhere in the workflow that names a way to reach a person', () => {
    const all = names(workflow);
    expect(all.length).toBeGreaterThan(15);
    expect(all.filter((p) => isContact(p.split('/').pop()!))).toEqual([]);
  });

  it('would notice one (control)', () => {
    for (const bad of ['email', 'eMail', 'phone_number', 'telephone', 'mobile', 'contactDetails'])
      expect(isContact(bad), bad).toBe(true);
    for (const fine of [
      'sub',
      'name',
      'order',
      'roles',
      'timeZone',
      'completedSeq',
      'firstViewedAt',
    ])
      expect(isContact(fine), fine).toBe(false);
  });
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the resource refuses and stores no contact detail (${storage}; FRW-026 criterion 4)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    const body = (doc: string, participants: unknown[]) => ({
      id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9d',
      doc,
      state: 'draft',
      rev: 0,
      timeZone: 'Europe/Berlin',
      participants,
    });

    it.skipIf(skip)(
      'refuses every contact member of a participant and of the workflow, and keeps a name and a sub',
      async () => {
        const doc = await h.createDocument();
        const owner = h.userToken({ [doc]: 'owner' });
        const put = (etag: string, b: unknown) =>
          h.call('PUT', `/v1/documents/${doc}/workflow`, {
            token: owner,
            body: b,
            headers: { 'if-match': etag },
          });
        const person = { id: 'p1', roles: ['role_tenant'], kind: 'signer', order: 1 };

        for (const member of ['email', 'phone', 'telephone', 'mobile', 'contact', 'address']) {
          const refused = await put('"0"', body(doc, [{ ...person, [member]: 'x@example.org' }]));
          expect(refused.status, member).toBe(400);
          expect(refused.json.violations, member).toEqual(
            expect.arrayContaining([{ path: `/participants/0/${member}`, rule: 'unknown_member' }]),
          );
        }
        // A contact member of the workflow itself is refused too.
        const top = await put('"0"', { ...body(doc, [person]), notifyEmail: 'x@example.org' });
        expect(top.status).toBe(400);

        // Nothing was stored by any refusal: the workflow does not exist yet.
        expect(
          (await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner })).status,
        ).toBe(404);

        // A person is identified by `sub` and `name`, and both are kept.
        const ok = await put(
          '"0"',
          body(doc, [{ ...person, sub: 'host-user-17', name: 'Jane Doe' }]),
        );
        expect(ok.status, ok.text).toBe(201);
        const read = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        expect(read.json.participants[0]).toEqual({
          ...person,
          sub: 'host-user-17',
          name: 'Jane Doe',
        });
      },
    );

    it.skipIf(skip || storage !== 'postgres')(
      'has no column that holds a contact detail in the tables of the resource',
      async () => {
        const rows = await inTenant(h.db!.service, h.tenant, (c) =>
          c.query<{ table_name: string; column_name: string }>(
            `SELECT table_name, column_name FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name LIKE 'workflow%'`,
          ),
        );
        const columns = rows.rows.map((r) => `${r.table_name}.${r.column_name}`);
        expect(columns.length).toBeGreaterThan(8);
        expect(columns.some((c) => c.startsWith('workflow_resource.'))).toBe(true);
        expect(columns.filter((c) => isContact(c.split('.')[1]!))).toEqual([]);
      },
    );
  });
}
