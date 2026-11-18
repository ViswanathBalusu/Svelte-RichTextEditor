// The fields port of the mock backend (FRW-067 criterion 2): the derived list, values by key and
// prefill. The mock runs the real authority, so the invariants I13 to I15 are its own.
import { contractDocument } from '@docedit/protocol/contract';
import { describe, expect, it } from 'vitest';
import { MockService } from '../src/index.ts';

type Json = { type?: string; attrs?: Record<string, unknown>; content?: Json[] };

function fieldsDocument() {
  const env = contractDocument();
  (env as unknown as { requires: string[] }).requires = ['fields'];
  const root = env.doc as unknown as Json;
  const defs = root.content!.find((n) => n.type === 'defs')!;
  defs.content!.push({ type: 'role_def', attrs: { id: 'role_a', name: 'A', color: '#1F77B4' } });
  const body = root.content!.find((n) => n.type === 'body')!;
  const field = (id: string, key: string, kind: string) => ({
    type: 'form_field',
    attrs: { id, key, kind, label: key, assignee: 'role_a' },
  });
  body.content!.unshift({
    type: 'paragraph',
    attrs: { id: 'pFields000000001' },
    content: [
      field('fName00000000001', 'name', 'text'),
      field('fRent00000000001', 'rent', 'number'),
      field('fSign00000000001', 'signature', 'signature'),
    ],
  });
  return env;
}

async function setup() {
  const service = new MockService();
  const doc = service.createDocument(fieldsDocument());
  const owner = service.backend({ sub: 'olga' }, { [doc]: 'owner' });
  await owner.connect();
  return { service, doc, owner, fields: owner.fields! };
}

describe('the fields port of the mock backend', () => {
  it('announces fields and lists them in document order', async () => {
    const { service, doc, owner, fields } = await setup();
    expect(service.features).toContain('fields');
    expect(owner.features.has('fields')).toBe(true);
    const page = await fields.fields(doc);
    expect(page.items.map((f) => f.key)).toEqual(['name', 'rent', 'signature']);
    const first = await fields.fields(doc, { limit: 2 });
    expect(first.items).toHaveLength(2);
    const rest = await fields.fields(doc, { limit: 2, cursor: first.nextCursor! });
    expect(rest.items.map((f) => f.key)).toEqual(['signature']);
    expect(rest.nextCursor).toBeNull();
    await service.dispose();
  });

  it('prefills by key with a server-authored commit, and reads the values back', async () => {
    const { service, doc, owner, fields } = await setup();
    const ch = await owner.sync.open(doc, {});
    const seen: Array<{ origin: string | undefined; session: unknown }> = [];
    ch.onCommits((cs) =>
      cs.forEach((c) => seen.push({ origin: c.origin, session: c.author.session })),
    );
    const before = await fields.values(doc);
    expect(before.value.values).toEqual({ name: null, rent: null, signature: null });
    const done = await fields.prefill(
      doc,
      { values: { name: 'Ada', rent: '12.50' } },
      { ifMatch: before.etag },
    );
    expect(done.value.values).toEqual({ name: 'Ada', rent: '12.50' });
    const after = await fields.values(doc);
    expect(after.etag).not.toBe(before.etag);
    expect(after.value.values['name']).toBe('Ada');
    // A pinned read still shows the earlier values (12 §10).
    expect((await fields.values(doc, 0)).value.values['name']).toBeNull();
    // The commit reached the channel with the origin `prefill` and no session (12 §9).
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([{ origin: 'prefill', session: null }]);
    await service.dispose();
  });

  it('is all or nothing: one bad key or value refuses the whole prefill with field_invalid', async () => {
    const { service, doc, fields } = await setup();
    for (const values of [
      { name: 'Ada', nobody: 'x' },
      { name: 'Ada', rent: 'twelve' },
      { signature: { asset: 'a', mode: 'typed' } },
    ])
      await expect(fields.prefill(doc, { values }, { ifMatch: '*' })).rejects.toMatchObject({
        code: 'field_invalid',
      });
    expect((await fields.values(doc)).value.values['name']).toBeNull();
    await service.dispose();
  });

  it('wants If-Match to be current, and manage', async () => {
    const { service, doc, fields } = await setup();
    await expect(
      fields.prefill(doc, { values: { name: 'x' } }, { ifMatch: '"stale"' }),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
    const editor = service.backend({ sub: 'erin' }, { [doc]: 'editor' });
    await editor.connect();
    await expect(
      editor.fields!.prefill(doc, { values: { name: 'x' } }, { ifMatch: '*' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await service.dispose();
  });
});
