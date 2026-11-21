// The canonical form of 03 §2 against the implementation and the fixtures (CDM-003, last
// criterion): ADR 0018 was accepted by the owner (decision 7 of docs/owner-decisions-2026-11-15.md)
// and 03 §2 now lists its rules. This test reads that list and checks, rule by rule, that the code
// of CDM-010 does it and that the fixtures of CDM-011 hold a case for it, so the three cannot drift
// apart. The bytes of every fixture are checked in fixtures.test.ts.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_FORM_VERSION,
  canonicalEnvelope,
  canonicalNode,
  canonicalNodeText,
  canonicalText,
  documentHash,
  type JsonEnvelope,
  type JsonNode,
} from './canonical-form.ts';
import { CanonicalizationError } from './jcs.ts';

const root = resolve(import.meta.dirname, '../../../..');
const spec = readFileSync(resolve(root, 'docs/spec/03-document-model.md'), 'utf8');
const index = JSON.parse(
  readFileSync(resolve(root, 'packages/model/fixtures/canonical/index.json'), 'utf8'),
) as {
  canonicalFormVersion: number;
  rules: Record<string, string>;
  cases: Array<{ name: string; rules: string[] }>;
};

/** 03 §2 from "Canonical form." to "Units.". */
const prose = ((): string => {
  const start = spec.indexOf('**Canonical form.**');
  const end = spec.indexOf('**Units.**');
  if (start < 0 || end < start) throw new Error('03 §2 has no canonical form paragraph');
  return spec.slice(start, end);
})();
/** The numbered rules, by number. */
const rules = new Map(
  [...prose.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]!] as const),
);

/**
 * The fixture rules (the keys of `rules` in fixtures/canonical/index.json) behind each rule of the
 * spec. Rule 6 has none: a document with a number that is not an integer has no canonical bytes to
 * store, so the refusal is tested here and in canonical-form.test.ts.
 */
const FIXTURE_RULES: Record<string, string[]> = {
  1: ['defaults', 'ext', 'objectAttributes'],
  2: ['emptyMembers'],
  3: ['markOrder'],
  4: ['textMerge'],
  5: ['requires'],
  6: [],
  7: ['bytes'],
  subtree: ['subtree'],
};

const paragraph = (attrs: NonNullable<JsonNode['attrs']>, content?: JsonNode[]): JsonNode =>
  content ? { type: 'paragraph', attrs, content } : { type: 'paragraph', attrs };
const envelope = (doc: JsonNode, requires: string[] = []): JsonEnvelope => ({
  cdm: 1,
  requires,
  doc,
});

describe('03 §2 against the canonical form (CDM-003; ADR 0018, accepted)', () => {
  it('lists seven rules and names the decision record and the owner decision', () => {
    expect([...rules.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(prose).toContain('adr/0018-cdm-attribute-grammars.md');
    expect(prose).toContain('decision 7');
    expect(prose).toContain('RFC 8785');
  });

  it('gives the canonical form version the code and the fixtures have', () => {
    const stated = /canonical form version\. It is (\d+)\./.exec(prose);
    expect(stated).not.toBeNull();
    expect(Number(stated![1])).toBe(CANONICAL_FORM_VERSION);
    expect(index.canonicalFormVersion).toBe(CANONICAL_FORM_VERSION);
  });

  it('has a fixture for every rule that has bytes, and no fixture rule the spec lacks', () => {
    const mapped = Object.values(FIXTURE_RULES).flat().sort();
    expect(mapped).toEqual(Object.keys(index.rules).sort());
    for (const key of mapped)
      expect(
        index.cases.some((c) => c.rules.includes(key)),
        key,
      ).toBe(true);
    expect(Object.keys(FIXTURE_RULES).filter((k) => k !== 'subtree')).toEqual(
      [...rules.keys()].map(String),
    );
  });

  it('rule 1: omits a default, an empty ext and a null id, and keeps an object value whole', () => {
    expect(rules.get(1)).toMatch(/default is omitted/);
    expect(rules.get(1)).toMatch(/as a whole/);
    const node = paragraph({
      id: null,
      ext: {},
      align: null,
      keepNext: true,
      tabs: [{ position: 720, align: 'left', leader: 'none' }],
    });
    expect(canonicalNode(node)).toEqual({
      type: 'paragraph',
      attrs: { keepNext: true, tabs: [{ position: 720, align: 'left', leader: 'none' }] },
    });
  });

  it('rule 2: omits an empty attrs, content and marks', () => {
    expect(rules.get(2)).toMatch(/`attrs`, `content` or `marks` is omitted/);
    expect(canonicalNodeText({ type: 'paragraph', attrs: {}, content: [], marks: [] })).toBe(
      '{"type":"paragraph"}',
    );
  });

  it('rule 3: orders marks by the mark list, then by their attributes, and leaves suggest alone', () => {
    expect(rules.get(3)).toMatch(/mark list/);
    expect(rules.get(3)).toMatch(/`suggest` list/);
    const suggest = [
      { type: 'fmt', attrs: { id: 'sFormat000000001', user: 'u2', before: { attrs: {} } } },
      { type: 'ins', attrs: { id: 'sInsert000000001', user: 'u1' } },
    ];
    const node = paragraph({ id: 'pMarks0000000001', suggest }, [
      {
        type: 'text',
        text: 'x',
        marks: [
          { type: 'del', attrs: { id: 'sB00000000000001', user: 'u' } },
          { type: 'italic' },
          { type: 'del', attrs: { id: 'sA00000000000001', user: 'u' } },
          { type: 'bold' },
        ],
      },
    ]);
    const out = canonicalNode(node);
    expect(out.content![0]!.marks!.map((m) => `${m.type}${String(m.attrs?.['id'] ?? '')}`)).toEqual(
      ['bold', 'italic', 'delsA00000000000001', 'delsB00000000000001'],
    );
    expect(out.attrs!['suggest']).toEqual(suggest);
  });

  it('rule 4: merges adjacent text with equal marks and drops empty text', () => {
    expect(rules.get(4)).toMatch(/merged/);
    const out = canonicalNode(
      paragraph({ id: 'pMerge0000000001' }, [
        { type: 'text', text: 'a' },
        { type: 'text', text: '' },
        { type: 'text', text: 'b' },
        { type: 'text', text: 'c', marks: [{ type: 'bold' }] },
      ]),
    );
    expect(out.content).toEqual([
      { type: 'text', text: 'ab' },
      { type: 'text', text: 'c', marks: [{ type: 'bold' }] },
    ]);
  });

  it('rule 5: sorts requires by UTF-16 code units and removes duplicates', () => {
    expect(rules.get(5)).toMatch(/UTF-16 code units/);
    const out = canonicalEnvelope(
      envelope({ type: 'doc' }, ['preserve', 'fields', 'extensions', 'fields']),
    );
    expect(out.requires).toEqual(['extensions', 'fields', 'preserve']);
  });

  it('rule 6: refuses a number that is not an integer, with the path, and writes no float', () => {
    expect(rules.get(6)).toMatch(/no canonical form/);
    const float = envelope(paragraph({ id: 'pFloat0000000001', spaceAfter: 1.5 }));
    expect(() => canonicalText(float)).toThrow(CanonicalizationError);
    const huge = envelope(paragraph({ id: 'pHuge00000000001', spaceAfter: 2 ** 53 }));
    expect(() => canonicalText(huge)).toThrow(CanonicalizationError);
    try {
      canonicalText(float);
    } catch (e) {
      expect((e as CanonicalizationError).path).toBe('/doc/attrs/spaceAfter');
    }
  });

  it('rule 7: hashes the UTF-8 bytes of the RFC 8785 text with SHA-256', async () => {
    expect(rules.get(7)).toMatch(/UTF-8/);
    expect(rules.get(7)).toMatch(/SHA-256/);
    const doc = envelope(paragraph({ id: 'pBytes0000000001' }, [{ type: 'text', text: 'é €' }]));
    const text = canonicalText(doc);
    expect(text).toBe(
      '{"cdm":1,"doc":{"attrs":{"id":"pBytes0000000001"},"content":[{"text":"é €","type":"text"}],"type":"paragraph"},"requires":[]}',
    );
    // Node.js hashes the bytes here, so the comparison does not go through the model's own hash.
    expect(await documentHash(doc)).toBe(
      createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
    );
  });

  it('gives a subtree the canonical form of the node alone, without the envelope', () => {
    expect(prose).toMatch(/subtree is the canonical form of that node alone, without the envelope/);
    const region: JsonNode = {
      type: 'region',
      attrs: { id: 'rRegion000000001', policy: 'inherit', title: null },
      content: [paragraph({ id: 'pInRegion0000001' })],
    };
    expect(canonicalNodeText(region)).toBe(
      '{"attrs":{"id":"rRegion000000001"},"content":[{"attrs":{"id":"pInRegion0000001"},"type":"paragraph"}],"type":"region"}',
    );
  });
});
