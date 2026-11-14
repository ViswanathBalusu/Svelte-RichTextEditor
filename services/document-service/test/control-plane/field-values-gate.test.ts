// Field values for a reader of a restricted class, and the history gate on a pinned read of them
// (FRW-060 criteria 4 and 6; ADR 0019; 07 §8). Over real HTTP against an in-process service, with
// in-memory storage and with PostgreSQL (the PostgreSQL run skips without a database).
import type { HiddenSet } from '@docedit/authority';
import { NOTHING_HIDDEN, type Visibility } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

/** A 16-character identifier of the shape the CDM fixtures use. */
const fid = (n: number) => `ff${String(n).padStart(14, '0')}`;
const PARA = 'pFields000000002';

/** The regions fixture with one paragraph of two fields: a text field and a number field. */
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
    attrs: { id: PARA, style: 'Normal' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: fid(1),
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          value: 'Ada',
        },
      },
      { type: 'text', text: ' ' },
      {
        type: 'form_field',
        attrs: {
          id: fid(2),
          key: 'fee.amount',
          kind: 'number',
          label: 'Fee',
          assignee: 'tenant',
          value: '12.50',
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

/**
 * A reader who is not an owner may not read the value of the first field (ADR 0019); owners read
 * everything. The rest of the projection is the same for every reader.
 */
const hideFirstValue: Visibility = (conn): HiddenSet =>
  conn.role === 'owner'
    ? NOTHING_HIDDEN
    : { regions: new Set(), values: new Set([fid(1)]), titles: false };

/** Position inside the start of the node with `id`, in the content of `doc`. */
function insideOf(doc: unknown, id: string): number {
  const root = cdmSchema().nodeFromJSON(doc);
  let at = -1;
  root.descendants((n, pos) => {
    if (n.attrs['id'] === id) at = pos + 1;
    return at < 0;
  });
  if (at < 0) throw new Error(`no node ${id}`);
  return at;
}

/** Appends one typing commit to the document as a room would (head and grants checked). */
async function typeOnce(h: Harness, doc: string, base: unknown): Promise<number> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const pos = insideOf(base, PARA);
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits: [
      {
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
        ] as never,
        user: 'u-test',
        session: 'session-test',
        time: h.now(),
        origin: 'input',
        scopes: ['body'],
        revision: perms.revision,
        cdm: 1,
        engine: 'pm-steps/1',
        retired: [],
        claimed: [],
      },
    ],
  });
  expect(r.status).toBe('ok');
  return head.seq + 1;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`field values for restricted readers (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, { views: { ...FULL_VIEWS, visibility: hideFirstValue } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'redacts a value the caller may not read and returns every other value (FRW-060 criterion 6, the redaction part)',
      async () => {
        const doc = await h.createDocument({ content: fieldDocument() });
        const viewer = h.userToken({ [doc]: 'viewer' });
        const owner = h.userToken({ [doc]: 'owner' });
        const hidden = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: viewer });
        expect(hidden.status).toBe(200);
        expect(hidden.json.values).toEqual({
          'tenant.name': { redacted: true },
          'fee.amount': '12.50',
        });
        expect(hidden.text).not.toContain('Ada');
        const full = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: owner });
        expect(full.json.values).toEqual({ 'tenant.name': 'Ada', 'fee.amount': '12.50' });
        // The redacted value stays redacted on a key read too.
        const one = await h.call('GET', `/v1/documents/${doc}/field-values?key=tenant.name`, {
          token: viewer,
        });
        expect(one.json.values).toEqual({ 'tenant.name': { redacted: true } });
      },
    );

    it.skipIf(skip)(
      'refuses a seq below the caller gate as forbidden, and serves the head and the gate above it (FRW-060 criterion 4)',
      async () => {
        const base = fieldDocument();
        const doc = await h.createDocument({ content: base });
        // One commit after the creation: the head is 1 and a viewer of an editors-only document
        // has its gate at the head (ADR 0034; 07 §8), so seq 0 is below it.
        const head = await typeOnce(h, doc, base.doc);
        expect(head).toBe(1);
        const viewer = h.userToken({ [doc]: 'viewer' });
        const owner = h.userToken({ [doc]: 'owner' });
        const below = await h.call('GET', `/v1/documents/${doc}/field-values?seq=0`, {
          token: viewer,
        });
        expect(below.status).toBe(403);
        expect(below.json.code).toBe('forbidden');
        // The head is always visible; an owner reads every seq at or above its gate.
        const atHead = await h.call('GET', `/v1/documents/${doc}/field-values?seq=1`, {
          token: viewer,
        });
        expect(atHead.status).toBe(200);
        expect(atHead.json.seq).toBe(1);
        const ownerBelow = await h.call('GET', `/v1/documents/${doc}/field-values?seq=0`, {
          token: owner,
        });
        expect(ownerBelow.status).toBe(200);
        expect(ownerBelow.json.seq).toBe(0);
      },
    );
  });
}
