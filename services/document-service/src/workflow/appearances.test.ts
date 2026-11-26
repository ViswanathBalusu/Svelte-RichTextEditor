// FRW-057: what the signing service is asked to draw (appearances.ts). Stubs stand for the content,
// the evidence and the object store: the fields of the document at the job's `seq`, the lines from
// the signing evidence, and a layout that is used only when it is in twips and of the job's `seq`.
import type { JsonNode } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../control-plane/jobs/queue.ts';
import { appearanceRequestFor, signatureFieldsOf } from './appearances.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';

const field = (id: string, key: string, kind: string): JsonNode => ({
  type: 'paragraph',
  attrs: { id: `p${id.slice(1)}` },
  content: [{ type: 'form_field', attrs: { id, key, kind, label: kind } }],
});
const doc: JsonNode = {
  type: 'doc',
  content: [
    field('fSign00000000001', 'tenant.sign', 'signature'),
    field('fText00000000002', 'tenant.name', 'text'),
    {
      type: 'region',
      content: [field('fInit00000000003', 'tenant.initials', 'initials')],
    },
  ],
};
const T = '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c02';
const ref = { tenant: T, doc: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c03' };
const workflow = {
  id: 'wf',
  participants: [{ id: 'p1', name: 'Ada Lovelace' }, { id: 'p2' }],
} as unknown as WorkflowResourceView;
const job = (over: Partial<JobRecord> = {}): JobRecord =>
  ({
    id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c01',
    tenant: T,
    payload: { seq: 9, incarnation: 'inc' },
    result: { layout: 'layout.json' },
    ...over,
  }) as JobRecord;
const layoutBytes = (o: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(o));
const good = {
  seq: 9,
  classVersion: '1.0.0',
  granularity: 'block',
  unit: 'twip',
  pages: [{ n: 1, setup: null, starts: null, opensWith: 'text' }],
  blocks: {},
  fields: { fSign00000000001: { page: 1, rect: [400, 3000, 2400, 3600] } },
};
const deps = (layout: Uint8Array | null, rows: unknown[] = []) => ({
  objects: { get: () => Promise.resolve(layout) },
  content: { rebuild: () => Promise.resolve({ doc }) },
  evidence: { list: () => Promise.resolve(rows) },
});
const signed = (participant: string, fieldKey: string, atMs: number) => ({
  participant,
  item: 'signed',
  evidence: { items: { signings: [{ fieldKey, atMs }] } },
});

describe('the appearances asked of the signing service (FRW-057)', () => {
  it('finds the signature and initials fields, in document order, and no other', () => {
    expect(signatureFieldsOf(doc).map((f) => [f.id, f.kind])).toEqual([
      ['fSign00000000001', 'signature'],
      ['fInit00000000003', 'initials'],
    ]);
  });

  it('says who signed and when from the evidence, by name when there is one, and nothing about identity', async () => {
    const at = Date.UTC(2026, 10, 18, 9, 30);
    const req = await appearanceRequestFor(
      deps(layoutBytes(good), [
        signed('p1', 'tenant.sign', at),
        signed('p2', 'tenant.initials', at),
      ]) as never,
      ref,
      workflow,
      job(),
    );
    expect(req!.targets).toEqual([
      expect.objectContaining({
        id: 'fSign00000000001',
        lines: ['Electronically signed', 'Ada Lovelace', '2026-11-18'],
      }),
      expect.objectContaining({
        id: 'fInit00000000003',
        lines: ['Electronically signed', 'p2', '2026-11-18'],
      }),
    ]);
    expect(JSON.stringify(req).toLowerCase()).not.toMatch(/verified|qualified|legally binding/);
    expect(req!.layout).toEqual(good.fields);
  });

  it('writes "Not signed" for a field with no signing', async () => {
    const req = await appearanceRequestFor(deps(layoutBytes(good)) as never, ref, workflow, job());
    expect(req!.targets.map((t) => t.lines)).toEqual([['Not signed'], ['Not signed']]);
  });

  it('uses no rectangle from a layout in another unit, of another seq, not JSON, missing or with no fields', async () => {
    for (const layout of [
      layoutBytes({ ...good, unit: 'pt' }),
      layoutBytes({ ...good, seq: 8 }),
      layoutBytes({ seq: 9, unit: 'twip' }),
      new TextEncoder().encode(JSON.stringify([good])),
      new TextEncoder().encode('not json'),
      null,
    ]) {
      const req = await appearanceRequestFor(deps(layout) as never, ref, workflow, job());
      expect(req!.layout).toEqual({});
    }
    // A job with no layout file named gives none either.
    const none = await appearanceRequestFor(
      deps(layoutBytes(good)) as never,
      ref,
      workflow,
      job({ result: {} }),
    );
    expect(none!.layout).toEqual({});
  });

  it('validates the whole file against its schema before use, and uses nothing from one that fails (criterion 3)', async () => {
    const field = good.fields.fSign00000000001;
    const bad: Array<[string, Record<string, unknown>]> = [
      ['a member the schema does not list', { ...good, extra: 1 }],
      ['a class version that is not one', { ...good, classVersion: 'one' }],
      ['a granularity that is not one', { ...good, granularity: 'word' }],
      ['a page that is out of order', { ...good, pages: [{ ...good.pages[0], n: 2 }] }],
      ['a block with a bad identifier', { ...good, blocks: { short: { page: 1, y: 0 } } }],
      [
        'a field on a page the file does not have',
        { ...good, fields: { fSign00000000001: { ...field, page: 2 } } },
      ],
      [
        'a field rectangle with its corners swapped',
        { ...good, fields: { fSign00000000001: { page: 1, rect: [2400, 3600, 400, 3000] } } },
      ],
      [
        'a field rectangle of three numbers',
        { ...good, fields: { fSign00000000001: { page: 1, rect: [1, 2, 3] } } },
      ],
    ];
    for (const [what, layout] of bad) {
      const req = await appearanceRequestFor(
        deps(layoutBytes(layout)) as never,
        ref,
        workflow,
        job(),
      );
      expect(req!.layout, what).toEqual({});
    }
    // A file that holds a good rectangle beside a block that fails gives none of them: the file as a
    // whole is not trusted.
    const mixed = { ...good, blocks: { short: { page: 1, y: 0 } } };
    expect(
      (await appearanceRequestFor(deps(layoutBytes(mixed)) as never, ref, workflow, job()))!.layout,
    ).toEqual({});
    // The good file is used.
    expect(
      (await appearanceRequestFor(deps(layoutBytes(good)) as never, ref, workflow, job()))!.layout,
    ).toEqual(good.fields);
  });

  it('asks for nothing when the document has no signature or initials field', async () => {
    const plain = {
      ...deps(layoutBytes(good)),
      content: {
        rebuild: () =>
          Promise.resolve({
            doc: { type: 'doc', content: [field('fText00000000002', 'k', 'text')] } as JsonNode,
          }),
      },
    };
    expect(await appearanceRequestFor(plain as never, ref, workflow, job())).toBeUndefined();
  });
});
