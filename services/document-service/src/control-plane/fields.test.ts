// Fields over the control plane: the derived list and the values by key (FRW-060) and prefill by
// key (FRW-061). Runs over the HTTP surface of the test harness. Refusals are checked before the
// commit reaches the outbox, so they need no room; the accepted prefill path needs a room or a
// transient authority to apply it and is not run here (see the Notes of FRW-061).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';

/** A 16-character identifier of the shape the CDM fixtures use. */
const fid = (n: number) => `ff${String(n).padStart(14, '0')}`;

/**
 * The regions fixture with one paragraph of five fields: text, decimal number, signature, choice
 * and date. `requires` names `fields` and the role `tenant` is defined in `defs`.
 */
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
  const ff = (
    n: number,
    key: string,
    kind: string,
    label: string,
    value: unknown,
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'form_field',
    attrs: { id: fid(n), key, kind, label, assignee: 'tenant', value, ...extra },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pFields000000001', style: 'Normal' },
    content: [
      ff(1, 'tenant.name', 'text', 'Name', 'Ada'),
      { type: 'text', text: ' ' },
      ff(2, 'fee.amount', 'number', 'Fee', '12.50'),
      { type: 'text', text: ' ' },
      ff(3, 'sig.tenant', 'signature', 'Signature', null),
      { type: 'text', text: ' ' },
      ff(4, 'plan.choice', 'choice', 'Plan', null, {
        options: [
          { id: 'basic', label: 'Basic' },
          { id: 'pro', label: 'Pro' },
        ],
      }),
      { type: 'text', text: ' ' },
      ff(5, 'start.date', 'date', 'Start', null),
      { type: 'text', text: ' ' },
      ff(6, 'initials.tenant', 'initials', 'Initials', null),
      { type: 'text', text: ' ' },
      ff(7, 'signed.date', 'dateSigned', 'Signed', null),
      { type: 'text', text: ' ' },
      ff(8, 'total.sum', 'formula', 'Total', null),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`fields on the control plane (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, {});
    });
    afterAll(async () => {
      await h?.close();
    });

    /** A document with the fields above, and an editor token for it. */
    async function setup() {
      const doc = await h.createDocument({ content: fieldDocument() });
      const editor = h.userToken({ [doc]: 'editor' });
      return { doc, editor };
    }

    const values = (doc: string, token: string, query = '') =>
      h.call('GET', `/v1/documents/${doc}/field-values${query}`, { token });

    it.skipIf(skip)(
      'lists the derived fields as a cursor list with an ETag, at most 200 a page (FRW-060 criterion 1)',
      async () => {
        const { doc, editor } = await setup();
        const first = await h.call('GET', `/v1/documents/${doc}/fields`, { token: editor });
        expect(first.status).toBe(200);
        expect(first.headers.get('etag')).toBeTruthy();
        expect(first.json.items).toHaveLength(8);
        expect(first.json.items[0]).toEqual({
          id: fid(1),
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          required: false,
          readOnly: false,
        });
        // Two a page until the cursor ends: every field once.
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const q = cursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
          const page = await h.call('GET', `/v1/documents/${doc}/fields${q}`, { token: editor });
          expect(page.status).toBe(200);
          seen.push(...(page.json.items as Array<{ id: string }>).map((f) => f.id));
          cursor = page.json.nextCursor;
        } while (cursor !== null);
        expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(fid));
        const tooMany = await h.call('GET', `/v1/documents/${doc}/fields?limit=201`, {
          token: editor,
        });
        expect(tooMany.status).toBe(400);
        expect(tooMany.json.code).toBe('validation_failed');
      },
    );

    it.skipIf(skip)(
      'returns the values by key as stored, decimal strings unchanged, and filters by key (FRW-060 criterion 2)',
      async () => {
        const { doc, editor } = await setup();
        const all = await values(doc, editor);
        expect(all.status).toBe(200);
        expect(all.json.values).toEqual({
          'tenant.name': 'Ada',
          'fee.amount': '12.50',
          'sig.tenant': null,
          'plan.choice': null,
          'start.date': null,
          'initials.tenant': null,
          'signed.date': null,
          'total.sum': null,
        });
        const one = await values(doc, editor, '?key=fee.amount');
        expect(one.json.values).toEqual({ 'fee.amount': '12.50' });
      },
    );

    it.skipIf(skip)(
      'answers not_found for a key that does not exist (FRW-060 criterion 5)',
      async () => {
        const { doc, editor } = await setup();
        const r = await values(doc, editor, '?key=no.such.key');
        expect(r.status).toBe(404);
        expect(r.json.code).toBe('not_found');
        expect(r.json.violations).toEqual([
          { path: 'key=no.such.key', rule: 'a key of the document' },
        ]);
      },
    );

    it.skipIf(skip)(
      'serves a pinned read at the head as immutable, answers 304 to a repeat, and refuses a seq above the head (FRW-060 criteria 3, 4)',
      async () => {
        const { doc, editor } = await setup();
        const head = await values(doc, editor);
        const etag = head.headers.get('etag')!;
        expect((await values(doc, editor)).headers.get('cache-control')).toBe('private, no-cache');
        const repeat = await h.call('GET', `/v1/documents/${doc}/field-values`, {
          token: editor,
          headers: { 'if-none-match': etag },
        });
        expect(repeat.status).toBe(304);
        const pinned = await values(doc, editor, '?seq=0');
        expect(pinned.status).toBe(200);
        expect(pinned.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
        expect(pinned.json.values).toEqual(head.json.values);
        const above = await values(doc, editor, '?seq=99');
        expect(above.status).toBe(404);
        expect(above.json.code).toBe('not_found');
      },
    );

    it.skipIf(skip)(
      'refuses a caller who cannot view the document with forbidden (FRW-060 criterion 6, the refusal part)',
      async () => {
        const { doc } = await setup();
        const other = await h.createDocument({ content: fieldDocument() });
        const stranger = h.userToken({ [other]: 'editor' });
        const r = await values(doc, stranger);
        expect(r.status).toBe(403);
        expect(r.json.code).toBe('forbidden');
        const list = await h.call('GET', `/v1/documents/${doc}/fields`, { token: stranger });
        expect(list.json.code).toBe('forbidden');
      },
    );

    it.skipIf(skip)(
      'refuses a prefill of a signature field, and of a field the document does not have, and applies nothing (FRW-061 criteria 2, 3)',
      async () => {
        const { doc, editor } = await setup();
        const service = h.serviceJwt();
        const before = await values(doc, editor);
        const etag = before.headers.get('etag')!;
        const patch = (body: unknown, ifMatch: string | undefined = etag) =>
          h.call('PATCH', `/v1/documents/${doc}/field-values`, {
            token: service,
            body,
            ...(ifMatch === undefined ? {} : { headers: { 'if-match': ifMatch } }),
          });

        // Every server-set kind is refused by key, one request each (12 §9).
        for (const key of ['sig.tenant', 'initials.tenant', 'signed.date', 'total.sum']) {
          const r = await patch({ values: { [key]: 'Ada' } });
          expect(r.status, key).toBe(422);
          expect(r.json.code, key).toBe('field_invalid');
          expect(r.json.violations[0].path, key).toBe(`/values/${key}`);
        }

        // A valid key next to a bad one: the request is atomic, so the valid key is not applied.
        const mixed = await patch({ values: { 'tenant.name': 'Grace', 'fee.amount': 'a lot' } });
        expect(mixed.status).toBe(422);
        expect(mixed.json.code).toBe('field_invalid');
        expect(mixed.json.detail).toContain('fee.amount');
        expect(mixed.json.violations.map((v: { path: string }) => v.path)).toEqual([
          '/values/fee.amount',
        ]);

        const unknown = await patch({ values: { 'tenant.name': 'Grace', 'missing.key': 'x' } });
        expect(unknown.status).toBe(422);
        expect(unknown.json.code).toBe('field_invalid');
        expect(unknown.json.violations[0].path).toBe('/values/missing.key');

        const choice = await patch({ values: { 'plan.choice': 'enterprise' } });
        expect(choice.json.code).toBe('field_invalid');

        const after = await values(doc, editor);
        expect(after.json.values).toEqual(before.json.values);
      },
    );

    it.skipIf(skip)(
      'requires If-Match on a prefill and refuses an empty prefill (FRW-061 guard rails)',
      async () => {
        const { doc, editor } = await setup();
        const service = h.serviceJwt();
        const noMatch = await h.call('PATCH', `/v1/documents/${doc}/field-values`, {
          token: service,
          body: { values: { 'tenant.name': 'Grace' } },
        });
        expect(noMatch.status).toBe(428);
        expect(noMatch.json.code).toBe('precondition_failed');
        const etag = (await values(doc, editor)).headers.get('etag')!;
        const empty = await h.call('PATCH', `/v1/documents/${doc}/field-values`, {
          token: service,
          body: { values: {} },
          headers: { 'if-match': etag },
        });
        expect(empty.status).toBe(400);
        expect(empty.json.code).toBe('validation_failed');
      },
    );
  });
}
