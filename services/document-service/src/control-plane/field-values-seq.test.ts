// Field values as they were at an earlier `seq` (FRW-060 criterion 3): a pinned read of
// `GET /documents/{id}/field-values?seq=N` returns the values at N, not the head, and it is
// immutable and cacheable like a pinned content read. A commit that changes a value is appended to
// the log store as the data plane's commit path does (see export-jobs.test.ts); the steps are the
// prefill steps of FRW-061 for the value. Runs over HTTP with the harness of test/control-plane,
// in memory and on PostgreSQL.
import type { StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';
import { prefillSteps } from './fields.ts';
import type { DocRef } from '../storage/types.ts';

const FIELD = 'ff00000000000001';

/** The regions fixture with one text field, `tenant.name`, in the intro paragraph. */
function fieldDocument(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pFields000000001', style: 'Normal' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: FIELD,
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          value: 'Ada',
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`field values at an earlier seq (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, {});
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'returns the values at a pinned seq after a change, not the head, and keeps them immutable (FRW-060 criterion 3)',
      async () => {
        const fixture = fieldDocument();
        const doc = await h.createDocument({ content: fixture });
        const editor = h.userToken({ [doc]: 'editor' });
        const values = (query = '') =>
          h.call('GET', `/v1/documents/${doc}/field-values${query}`, { token: editor });

        const before = await values();
        expect(before.json.values).toEqual({ 'tenant.name': 'Ada' });
        const earlier: number = before.json.seq;
        const earlierEtag = (await values(`?seq=${earlier}`)).headers.get('etag')!;

        // Change the value through a commit appended to the log, with the prefill steps for it.
        const ref: DocRef = { tenant: h.tenant, doc };
        const head = await h.parts.logs.head(ref);
        const perms = await h.parts.grants.current(ref);
        const epoch = await h.parts.ownership.claim(ref, 'test-node');
        const steps = prefillSteps(fixture['doc'] as Parameters<typeof prefillSteps>[0], {
          'tenant.name': 'Grace',
        });
        expect(steps).toHaveLength(1);
        const commit: StoredCommit = {
          seq: head.seq + 1,
          id: uuid7(),
          kind: 'steps',
          steps: steps as unknown as StoredCommit['steps'],
          user: 'editor',
          session: 'session-field-values-seq',
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

        // The head shows the new value and a new ETag.
        const after = await values();
        expect(after.json.values).toEqual({ 'tenant.name': 'Grace' });
        expect(after.json.seq).toBe(earlier + 1);
        expect(after.headers.get('etag')).not.toBe(before.headers.get('etag'));

        // The pinned read at the earlier seq still holds the old value, twice, identically.
        const pinned = await values(`?seq=${earlier}`);
        expect(pinned.status).toBe(200);
        expect(pinned.json.values).toEqual({ 'tenant.name': 'Ada' });
        expect(pinned.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
        expect(pinned.headers.get('etag')).toBe(earlierEtag);
        const again = await values(`?seq=${earlier}`);
        expect(again.text).toBe(pinned.text);

        // A repeat with the ETag of the pinned read is answered 304.
        const repeat = await h.call('GET', `/v1/documents/${doc}/field-values?seq=${earlier}`, {
          token: editor,
          headers: { 'if-none-match': earlierEtag },
        });
        expect(repeat.status).toBe(304);

        // The value at the new seq is the new one.
        const latest = await values(`?seq=${earlier + 1}`);
        expect(latest.json.values).toEqual({ 'tenant.name': 'Grace' });
      },
    );
  });
}
