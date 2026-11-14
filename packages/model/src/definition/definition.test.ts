// The definition as data: writer support (CDM-046), the feature registry (CDM-047), additive
// attributes in `ext` (CDM-048), citations (CDM-052) and the nodes and values of projections
// (CDM-053; FRW-088's model side).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addDefs,
  bodyOf,
  codes,
  exampleDoc,
  invariants,
  para,
  text,
  type Json,
} from '../../test/support.ts';
import { canonicalText, documentHash, type JsonEnvelope } from '../canonical/canonical-form.ts';
import { buildProjectionSchema, cdmSchema, projectionSchema } from '../prosemirror/index.ts';
import { generateDocs } from '../schema/docs.ts';
import { generateJsonSchema } from '../schema/json-schema.ts';
import { generateProjectionSpec, generateProseMirrorSpec } from '../schema/prosemirror-spec.ts';
import { generateWriterSupportDocs } from '../schema/writer-support-docs.ts';
import { readDocument, writeDocument } from '../validate/read.ts';
import { CDM1 } from './cdm1.ts';
import {
  addedFeatures,
  featureRegistry,
  mayAddFeatures,
  mayOpen,
  namespaceProblems,
  supportedFeatures,
} from './features.ts';
import type { CdmDefinition } from './grammar.ts';
import {
  HIDDEN_REGION,
  REDACTION_MARKER,
  isRedactionMarker,
  redactionMarker,
} from './projection.ts';
import {
  NODE_SUPPORT,
  PAGE_SETUP_FEATURES,
  SUPPORT_LEVELS,
  writerSupportProblems,
} from './writer-support.ts';

const root = resolve(import.meta.dirname, '../../../..');
const readJson = (p: string) => JSON.parse(readFileSync(resolve(root, p), 'utf8')) as Json;

describe('writer support as data (CDM-046)', () => {
  it('has an entry for every node type, mark, field kind and page-setup feature, and fails on a missing one', () => {
    expect(writerSupportProblems(CDM1)).toEqual([]);
    const extra: CdmDefinition = {
      ...CDM1,
      nodes: [...CDM1.nodes, { name: 'chart', attrs: {}, spec: 'x', doc: 'x' }],
    };
    expect(writerSupportProblems(extra)).toEqual(['node chart: no writer-support entry']);
    const pageSetup = CDM1.nodes.find((n) => n.name === 'page_setup')!;
    const attrs = Object.keys(pageSetup.attrs).filter(
      (a) => !['id', 'preserved', 'ext'].includes(a),
    );
    expect(Object.values(PAGE_SETUP_FEATURES).flat().sort()).toEqual(attrs.sort());
  });

  it('says no construct is unsupported by either writer (03 §1 principle 4)', () => {
    expect(SUPPORT_LEVELS).not.toContain('no');
    for (const [name, s] of Object.entries(NODE_SUPPORT)) {
      expect(SUPPORT_LEVELS, name).toContain(s.latex);
      expect(SUPPORT_LEVELS, name).toContain(s.docx);
    }
    const bad = { ...NODE_SUPPORT, toc: { latex: 'no', docx: 'supported', source: 'x' } };
    expect(Object.values(bad).some((s) => !SUPPORT_LEVELS.includes(s.latex as never))).toBe(true);
  });

  it('carries the limits of 03 §10 as notes on their rows', () => {
    const doc = generateWriterSupportDocs(CDM1);
    for (const limit of [
      'Tables inside multi-column sections, headers and footnotes cannot span pages.',
      'Orientation and margin changes force a page break in LaTeX.',
      'A `continuous` break that changes margins is reported as unsupported.',
      'decimal tabs inside justified text are approximate',
      'unsupported macros fall back to an image',
    ])
      expect(doc, limit).toContain(limit);
  });

  it('generates the published page from the same data', () => {
    expect(readFileSync(resolve(root, 'spec/cdm/cdm-1.writer-support.md'), 'utf8')).toBe(
      generateWriterSupportDocs(CDM1),
    );
    expect(readJson('spec/cdm/cdm-1.writer-support.json')['nodes']['table']).toEqual(
      JSON.parse(JSON.stringify(NODE_SUPPORT['table'])),
    );
  });
});

describe('the feature registry (CDM-047)', () => {
  it('names fields and extensions with their nodes, marks, attributes and values', () => {
    const r = Object.fromEntries(featureRegistry().map((f) => [f.name, f]));
    expect(r['fields']).toMatchObject({
      nodes: ['role_def', 'rule_def', 'form_field'],
      marks: [],
      values: ['field.kind=formValue'],
    });
    expect(r['extensions']).toMatchObject({
      nodes: ['extension_block', 'extension_inline'],
      marks: [],
    });
    expect(r['preserve']!.nodes).toEqual(['preserved_def', 'preserved_block', 'preserved_inline']);
    expect(r['preserve']!.marks).toEqual(['preserved']);
    expect(r['preserve']!.attributes).toContain('paragraph.preserved');
  });

  it('shares one namespace with the protocol: a CDM feature that names a protocol feature of another meaning fails', () => {
    const registry = readJson('spec/dep/dep-1.registry.json')['features'] as Array<{
      name: string;
      owner: string;
    }>;
    expect(namespaceProblems(registry)).toEqual([]);
    const clash: CdmDefinition = {
      ...CDM1,
      features: [...CDM1.features, { name: 'presence' as never, doc: 'x' }],
    };
    expect(namespaceProblems(registry, clash)).toEqual([
      'CDM feature "presence" is a protocol feature of PRO; protocol and CDM features share one namespace',
    ]);
  });

  it('accepts a commit that adds a feature only when every attached client announced it', () => {
    expect(addedFeatures(['fields'], ['fields', 'preserve', 'extensions'])).toEqual([
      'extensions',
      'preserve',
    ]);
    expect(mayAddFeatures([], ['fields'], [['fields'], ['fields', 'extensions']])).toEqual({
      ok: true,
    });
    expect(mayAddFeatures([], ['fields'], [['fields'], []])).toEqual({
      ok: false,
      missing: ['fields'],
    });
    expect(mayAddFeatures(['fields'], ['fields'], [[]])).toEqual({ ok: true });
  });

  it('refuses a client that lacks a feature the document requires, naming it (unsupported_feature)', () => {
    expect(mayOpen(['fields', 'preserve'], ['fields'])).toEqual({
      ok: false,
      missing: ['preserve'],
    });
    expect(mayOpen([], [])).toEqual({ ok: true });
  });

  it('reports I1 for a commit that adds a feature node without adding the feature', () => {
    const d = exampleDoc();
    bodyOf(d)[2]!.content = [
      { type: 'extension_inline', attrs: { extension: 'com.example.x', fallbackText: 'x' } },
    ];
    expect(invariants(d)).toEqual(['I1']);
  });

  it('says which features and cdm versions it supports', () => {
    expect(supportedFeatures()).toEqual(['fields', 'extensions', 'preserve']);
    const dep = readJson('spec/dep/dep-1.manifest.json')['cdm'] as { min: number; max: number };
    expect(dep).toMatchObject({ min: 1, max: 1 });
  });
});

describe('additive attributes in ext (CDM-048)', () => {
  it('declares ext with default {} on every node and mark, in the JSON Schema and the ProseMirror schema', () => {
    const json = generateJsonSchema(CDM1)['$defs'] as Record<
      string,
      { properties?: Record<string, Json> }
    >;
    for (const n of CDM1.nodes) {
      if (n.name === 'text') continue;
      expect(json[`attrs.${n.name}`]!.properties!['ext'], n.name).toMatchObject({ default: {} });
      expect(cdmSchema().nodes[n.name]!.spec.attrs!['ext'], n.name).toEqual({
        default: {},
        validate: 'object',
      });
    }
    for (const m of CDM1.marks)
      expect(json[`attrs.mark.${m.name}`]!.properties!['ext'], m.name).toMatchObject({
        default: {},
      });
  });

  it('keeps a non-empty ext through reading, writing, canonicalising and ProseMirror', () => {
    const d = exampleDoc();
    bodyOf(d)[0]!.attrs.ext = { 'vendor.example:tag': 'intro', 'vendor.example:n': 2 };
    bodyOf(d)[1]!.content[0].content[1].marks[0].attrs.ext = { 'vendor.example:why': 'emphasis' };
    const r = readDocument(d);
    if (!r.ok) throw new Error(r.message);
    const back = writeDocument(r.doc, r.requires);
    expect(canonicalText(back)).toBe(canonicalText(d as JsonEnvelope));
    expect(canonicalText(back)).toContain('"vendor.example:tag":"intro"');
  });

  it('refuses an ext key without a namespace (I11)', () => {
    for (const key of ['tag', 'Vendor:tag', 'vendor.example:', ':tag']) {
      const d = exampleDoc();
      bodyOf(d)[0]!.attrs.ext = { [key]: 1 };
      expect(codes(d), key).toEqual(['attribute_invalid']);
    }
  });

  it('omits ext {} from the canonical form and hashes a non-empty one', async () => {
    const plain = exampleDoc();
    const empty = exampleDoc();
    bodyOf(empty)[0]!.attrs.ext = {};
    expect(await documentHash(empty as JsonEnvelope)).toBe(
      await documentHash(plain as JsonEnvelope),
    );
    const full = exampleDoc();
    bodyOf(full)[0]!.attrs.ext = { 'vendor.example:tag': 'x' };
    expect(await documentHash(full as JsonEnvelope)).not.toBe(
      await documentHash(plain as JsonEnvelope),
    );
  });

  it('refuses an ext above its size bound (I11)', () => {
    const d = exampleDoc();
    bodyOf(d)[0]!.attrs.ext = { 'vendor.example:blob': 'x'.repeat(4096) };
    expect(codes(d)).toEqual(['attribute_invalid']);
  });
});

describe('sources, citations and bibliographies (CDM-052)', () => {
  const source = (attrs: Json = {}): Json => ({
    type: 'source_def',
    attrs: {
      id: 'srcKnuth1984',
      kind: 'book',
      title: 'The TeXbook',
      authors: [{ family: 'Knuth', given: 'Donald E.' }],
      issued: '1984',
      ...attrs,
    },
  });
  const cite = (items: Json[]): Json => ({ type: 'citation', attrs: { items } });

  it('is in the JSON Schema, the ProseMirror schema and the types, every attribute with a grammar and no floats', () => {
    const json = generateJsonSchema(CDM1)['$defs'] as Record<string, unknown>;
    for (const n of ['source_def', 'citation', 'bibliography']) {
      expect(json, n).toHaveProperty(`node.${n}`);
      expect(cdmSchema().nodes, n).toHaveProperty(n);
    }
    const types = readFileSync(resolve(root, 'packages/model/src/generated/types.ts'), 'utf8');
    for (const t of ['SourceDefNode', 'CitationNode', 'BibliographyNode'])
      expect(types).toContain(`export interface ${t}`);
    const d = addDefs(exampleDoc(), source());
    bodyOf(d)[2]!.content = [
      text('See '),
      cite([{ source: 'srcKnuth1984', locator: '12', label: 'page' }]),
    ];
    bodyOf(d).push({ type: 'bibliography', attrs: { id: 'bibMain000000001' } });
    expect(invariants(d)).toEqual([]);
    for (const [name, value] of [
      ['issued', 1984],
      ['issued', '06/11/2026'],
      ['doi', 'doi:10.1/x'],
      ['kind', 'blog'],
      ['volume', 3],
    ] as const)
      expect(
        invariants(addDefs(exampleDoc(), source({ [name]: value }))),
        `${name} ${value}`,
      ).toContain('I11');
  });

  it('resolves every cited source, and refuses deleting a source still cited (I4)', () => {
    const d = addDefs(exampleDoc(), source());
    bodyOf(d)[2]!.content = [cite([{ source: 'srcKnuth1984' }, { source: 'srcMissing' }])];
    expect(codes(d)).toEqual(['unresolved_reference']);
    const deleted = exampleDoc();
    bodyOf(deleted)[2]!.content = [cite([{ source: 'srcKnuth1984' }])];
    expect(codes(deleted)).toEqual(['unresolved_reference']);
    expect(codes(addDefs(exampleDoc(), source()))).toEqual([]);
  });

  it('has writer-support rows for sources, citations and bibliographies', () => {
    for (const n of ['source_def', 'citation', 'bibliography'])
      expect(NODE_SUPPORT[n], n).toMatchObject({ latex: 'supported', docx: 'partial' });
  });
});

describe('projections: the confidential policy, the placeholder and the redaction marker (CDM-053)', () => {
  it('adds confidential to the region policy in the JSON Schema, the ProseMirror schema and the types', () => {
    const json = generateJsonSchema(CDM1)['$defs'] as Record<
      string,
      { properties: Record<string, Json> }
    >;
    expect(json['attrs.region']!.properties['policy']).toMatchObject({
      enum: ['inherit', 'restricted', 'confidential'],
    });
    expect(
      cdmSchema().nodes['region']!.create({ id: 'rConfidential001', policy: 'confidential' }, [
        cdmSchema().nodes['paragraph']!.create(),
      ]).attrs['policy'],
    ).toBe('confidential');
    expect(readFileSync(resolve(root, 'packages/model/src/generated/types.ts'), 'utf8')).toContain(
      '"inherit" | "restricted" | "confidential"',
    );
    const d = exampleDoc();
    bodyOf(d)[1]!.attrs.policy = 'confidential';
    expect(invariants(d)).toEqual([]);
  });

  it('refuses a hidden_region or a redaction marker in a stored document or a commit', () => {
    const placeholder = exampleDoc();
    bodyOf(placeholder)[1] = {
      type: 'hidden_region',
      attrs: { id: 'rG7mK2pQ9xYt4HcD', title: null },
    };
    expect(codes(placeholder)).toEqual(['projection_only_node']);
    for (const marker of [REDACTION_MARKER, redactionMarker(), { redacted: true, value: 'x' }]) {
      const d = exampleDoc();
      d['requires'] = ['fields'];
      bodyOf(d)[2]!.content = [
        {
          type: 'form_field',
          attrs: { id: 'ffField000000001', key: 'k', label: 'K', value: marker },
        },
      ];
      expect(codes(d), JSON.stringify(marker)).toEqual(['redaction_marker']);
      expect(isRedactionMarker(marker as never)).toBe(true);
    }
    expect(isRedactionMarker({ redacted: false } as never)).toBe(false);
  });

  it('generates the projection schema from the definition: the placeholder is a body atom with only id and title', () => {
    const spec = generateProjectionSpec(CDM1);
    const nodes = Object.fromEntries(spec.nodes);
    expect(nodes['hidden_region']).toEqual({
      atom: true,
      selectable: true,
      attrs: {
        id: { default: null, validate: 'string|null' },
        title: { default: null, validate: 'string|null' },
      },
    });
    expect(nodes['body']!.content).toBe('(block | region | section_break | hidden_region)+');
    expect(nodes['region']!.content).toBe('block+');
    expect(Object.fromEntries(generateProseMirrorSpec(CDM1).nodes)).not.toHaveProperty(
      'hidden_region',
    );
    expect(readJson('spec/cdm/cdm-1.projection.json')).toEqual(JSON.parse(JSON.stringify(spec)));
    const schema = projectionSchema();
    const hidden = schema.nodes['hidden_region']!;
    expect(hidden.isAtom && hidden.isLeaf && hidden.spec.selectable).toBe(true);
    const doc = schema.nodeFromJSON({
      ...exampleDoc()['doc'],
      content: [
        exampleDoc()['doc'].content[0],
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            { type: 'hidden_region', attrs: { id: 'rG7mK2pQ9xYt4HcD' } },
            para('pAfter0000000001'),
          ],
        },
      ],
    });
    doc.check();
    expect(() =>
      schema
        .nodeFromJSON({
          type: 'region',
          attrs: { id: 'rRegion000000001' },
          content: [{ type: 'hidden_region', attrs: { id: 'x' } }],
        })
        .check(),
    ).toThrow();
    expect(buildProjectionSchema().nodes['hidden_region']).toBeDefined();
    expect(HIDDEN_REGION.attrs).not.toHaveProperty('ext');
  });

  it('documents sensitive as the read rule of FRW-088, no longer as reserved', () => {
    const docs = generateDocs(CDM1);
    const row = docs.split('\n').find((l) => l.startsWith('| `sensitive` |'))!;
    expect(row).toContain('readable only by the principals of the read rule');
    expect(row).toContain('FRW-088');
    expect(row).not.toMatch(/\bReserved\b/);
  });
});
