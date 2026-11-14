// The CDM canonical form and its hash (03 §2). Runs in Node.js and every browser engine, so the
// pinned hash shows that all of them produce the same bytes for the example of 03 §12.
import { describe, expect, it } from 'vitest';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
import {
  canonicalEnvelope,
  canonicalNode,
  canonicalText,
  documentHash,
  nodeHash,
  type JsonEnvelope,
  type JsonNode,
} from './canonical-form.ts';

const EXPECTED =
  '{"cdm":1,"doc":{"content":[{"content":[{"attrs":{"lang":"en-GB"},"type":"settings"},{"attrs":{"builtIn":true,"fontFamily":"Noto Serif","fontSize":220,"id":"Normal","lineRule":"multiple","lineSpacing":1150,"name":"Normal","spaceAfter":160},"type":"style_def"},{"attrs":{"basedOn":"Normal","bold":true,"builtIn":true,"fontSize":320,"id":"Heading1","keepNext":true,"name":"Heading 1","next":"Normal","outlineLevel":1},"type":"style_def"},{"attrs":{"id":"ps1"},"type":"page_setup"}],"type":"defs"},{"attrs":{"pageSetup":"ps1"},"content":[{"attrs":{"id":"p3Jq8sLw0aZx1VbN","style":"Heading1"},"content":[{"text":"Scope","type":"text"}],"type":"paragraph"},{"attrs":{"id":"rG7mK2pQ9xYt4HcD","policy":"restricted","title":"Legal review"},"content":[{"attrs":{"id":"pA1b2C3d4E5f6G7h","style":"Normal"},"content":[{"text":"Liability is limited to ","type":"text"},{"marks":[{"type":"bold"}],"text":"direct","type":"text"},{"text":" damages.","type":"text"}],"type":"paragraph"}],"type":"region"},{"attrs":{"id":"pZ9y8X7w6V5u4T3s","style":"Normal"},"type":"paragraph"}],"type":"body"}],"type":"doc"},"requires":[]}';

describe('CDM canonical form', () => {
  it('omits defaults, empty members and default-valued mark attributes', () => {
    expect(canonicalText(example as JsonEnvelope)).toBe(EXPECTED);
  });

  it('pins the hash of the example (hash fixture)', async () => {
    const hash = await documentHash(example as JsonEnvelope);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await documentHash(JSON.parse(EXPECTED) as JsonEnvelope));
    expect(hash).toMatchInlineSnapshot(
      `"aaded9773d21afe7d9b76074aa316a37728bce1f8d1fabccae3f675ecd21e683"`,
    );
  });

  it('merges adjacent text with equal marks and orders marks by schema position', () => {
    const node: JsonNode = {
      type: 'paragraph',
      attrs: { id: 'pA1b2C3d4E5f6G7h', align: null },
      content: [
        {
          type: 'text',
          text: 'a',
          marks: [{ type: 'italic', attrs: { value: true } }, { type: 'bold' }],
        },
        {
          type: 'text',
          text: 'b',
          marks: [{ type: 'bold', attrs: { value: true } }, { type: 'italic' }],
        },
        { type: 'text', text: '' },
        {
          type: 'text',
          text: 'c',
          marks: [
            { type: 'del', attrs: { id: 'b', user: 'u' } },
            { type: 'del', attrs: { id: 'a', user: 'u' } },
          ],
        },
      ],
    };
    const env = canonicalEnvelope({
      cdm: 1,
      requires: ['preserve', 'fields', 'fields'],
      doc: node,
    });
    expect(env.requires).toEqual(['fields', 'preserve']);
    expect(env.doc).toEqual({
      type: 'paragraph',
      attrs: { id: 'pA1b2C3d4E5f6G7h' },
      content: [
        { type: 'text', text: 'ab', marks: [{ type: 'bold' }, { type: 'italic' }] },
        {
          type: 'text',
          text: 'c',
          marks: [
            { type: 'del', attrs: { id: 'a', user: 'u' } },
            { type: 'del', attrs: { id: 'b', user: 'u' } },
          ],
        },
      ],
    });
  });

  it('keeps object-valued attributes whole: defaults inside them are not stripped (ADR 0018)', () => {
    const table: JsonNode = {
      type: 'table',
      attrs: {
        id: 'tTable0000000001',
        grid: [1000],
        width: { type: 'auto', value: 0 },
        borders: { top: { style: 'none', width: 0 } },
        ext: {},
        headerRows: 0,
      },
    };
    // `ext` and `headerRows` equal their defaults and go; the objects are kept as written.
    expect(canonicalNode(table)).toEqual({
      type: 'table',
      attrs: {
        id: 'tTable0000000001',
        grid: [1000],
        width: { type: 'auto', value: 0 },
        borders: { top: { style: 'none', width: 0 } },
      },
    });
    // An empty `content`, `marks` or `attrs` is omitted, never written as [] or {}.
    expect(canonicalNode({ type: 'paragraph', attrs: {}, content: [], marks: [] })).toEqual({
      type: 'paragraph',
    });
  });

  it('hashes a subtree without the envelope (07 §11 approvals)', async () => {
    const region = (example as JsonEnvelope).doc.content![1]!.content![1]!;
    const a = await nodeHash(region);
    const b = await nodeHash(structuredClone(region));
    expect(a).toBe(b);
    const changed = structuredClone(region);
    changed.content![0]!.content![1]!.text = 'indirect';
    expect(await nodeHash(changed)).not.toBe(a);
  });
});
