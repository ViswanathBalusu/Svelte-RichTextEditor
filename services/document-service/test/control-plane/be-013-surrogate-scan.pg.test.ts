// BE-013 criterion 4 in PostgreSQL (lane U-BE-001-014): after a document, a grant change through
// REST, a commit and the audit rows of those writes, no stored row of the tenant holds the host's
// `sub` or its display name, except the mapping row itself (`tenant_users`, which is the one place
// that may). The scan reads every non-bytea column of every table the service role can read, so
// it covers the 06 §4.1 tables and the audit trail. Payload bytes are zstd-compressed and are not
// scanned. Skipped when PostgreSQL is not up (infra/test-env.ps1 up).
import { randomUUID } from 'node:crypto';
import type { StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTenant } from '../../src/storage/db.ts';
import type { DocRef } from '../../src/storage/types.ts';
import { documentWithRegions, skipReason, startHarness, type Harness } from './support.ts';

const skip = await skipReason('postgres');
const LEGAL = 'rLegal0000000001';
const INTRO = 'pIntro0000000001';

function insideAt(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

describe.skipIf(skip !== null)(
  'no stored row holds a host sub (PostgreSQL, BE-013 criterion 4)',
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness('postgres');
    });
    afterAll(async () => {
      await h?.close();
    });

    it('after document, grant, commit and audit writes, only the mapping row holds the sub or name', async () => {
      const sub = `sub-u-be-001-014-${randomUUID()}`;
      const name = `Name u-be-001-014 ${randomUUID()}`;
      const surrogate = (await h.parts.users.resolve(h.tenant, sub, name)).surrogate;

      // A document created with the sub as DEP-Actor (BE-033 criterion 6).
      const created = await h.call('POST', '/v1/documents', {
        token: h.apiKey,
        body: { content: documentWithRegions() },
        headers: { 'DEP-Actor': sub },
      });
      expect(created.status).toBe(201);
      const doc = created.json.id as string;

      // A user token carrying the sub and name: verification maps them (BE-013 criteria 1 and 3).
      const user = h.userToken({ [doc]: 'owner' }, { sub, name });
      const read = await h.call('GET', `/v1/documents/${doc}`, { token: user });
      expect(read.status).toBe(200);

      // A grant change through REST, attributed to the sub (BE-010 criterion 4, PRM-051).
      const etag = (
        await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey })
      ).headers.get('etag');
      const granted = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: h.apiKey,
        headers: { 'If-Match': etag ?? '', 'DEP-Actor': sub },
        body: { grants: [{ region: LEGAL, principal: `user:${sub}`, role: 'viewer' }] },
      });
      expect(granted.status).toBe(200);

      // A commit written as the room writes it: its author is the surrogate.
      const ref: DocRef = { tenant: h.tenant, doc };
      const epoch = await h.parts.ownership.claim(ref, 'test-node');
      const head = await h.parts.logs.head(ref);
      const perms = await h.parts.grants.current(ref);
      const pos = insideAt(documentWithRegions()['doc'], INTRO);
      const commit: StoredCommit = {
        seq: head.seq + 1,
        id: uuid7(),
        kind: 'steps',
        steps: [
          {
            stepType: 'replace',
            from: pos,
            to: pos,
            slice: { content: [{ type: 'text', text: 'x' }] },
          },
        ] as StoredCommit['steps'],
        user: surrogate,
        session: 'session-u-be-001-014',
        time: h.now(),
        origin: 'input',
        scopes: ['body'],
        revision: perms.revision,
        cdm: 1,
        engine: 'pm-steps/1',
        retired: [],
        claimed: [],
      };
      const appended = await h.parts.logs.append(ref, {
        epoch,
        revision: perms.revision,
        fromSeq: head.seq + 1,
        commits: [commit],
      });
      expect(appended.status).toBe('ok');

      // Scan every readable non-bytea column of the tenant's rows for each needle.
      const columns = await inTenant(
        h.db!.service,
        h.tenant,
        async (c) =>
          (
            await c.query<{ table_name: string; column_name: string }>(
              `SELECT c.table_name, c.column_name FROM information_schema.columns c
              WHERE c.table_schema = 'public' AND c.data_type <> 'bytea'
                AND has_table_privilege(format('%I.%I', c.table_schema, c.table_name), 'SELECT')
              ORDER BY 1, 2`,
            )
          ).rows,
        { readOnly: true },
      );
      const tables = new Set(columns.map((x) => x.table_name));
      for (const t of ['documents', 'region_grants', 'doc_commits', 'audit_events', 'tenant_users'])
        expect(tables.has(t), `${t} is scanned`).toBe(true);

      const hitsFor = async (needle: string): Promise<string[]> => {
        const hits: string[] = [];
        await inTenant(
          h.db!.service,
          h.tenant,
          async (c) => {
            for (const { table_name, column_name } of columns) {
              const r = await c.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM "${table_name}" WHERE strpos("${column_name}"::text, $1) > 0`,
                [needle],
              );
              if ((r.rows[0]?.n ?? 0) > 0) hits.push(`${table_name}.${column_name}`);
            }
          },
          { readOnly: true },
        );
        return hits.sort();
      };

      // The scan finds the sub where it is stored, so an empty result elsewhere means something.
      expect(await hitsFor(sub)).toEqual(['tenant_users.sub']);
      expect(await hitsFor(name)).toEqual(['tenant_users.display_name']);
      // The surrogate is what the other tables hold.
      const bySurrogate = await hitsFor(surrogate);
      expect(bySurrogate).toEqual(expect.arrayContaining(['doc_commits.user_id']));
    });
  },
);
