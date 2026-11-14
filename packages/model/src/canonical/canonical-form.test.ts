// The canonical form and the document hash (CDM-010; 03 §2): RFC 8785 bytes, defaults omitted,
// marks ordered, text merged, no floats, and equal hashes for equal documents however they were made.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { Fragment, Slice } from 'prosemirror-model';
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { bodyOf, exampleDoc, sinkDoc, type Json } from '../../test/support.ts';
import { cdmSchema } from '../prosemirror/index.ts';
import { canonicalize, CanonicalizationError } from './jcs.ts';
import {
  canonicalEnvelope,
  canonicalNode,
  canonicalText,
  documentHash,
  type JsonEnvelope,
  type JsonNode,
} from './canonical-form.ts';

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const schema = cdmSchema();

describe('canonical bytes and the document hash (CDM-010)', () => {
  it('is the RFC 8785 serialisation of the canonical envelope in UTF-8, hashed with SHA-256', async () => {
    for (const env of [exampleDoc(), sinkDoc()]) {
      const text = canonicalText(env as JsonEnvelope);
      expect(text).toBe(canonicalize(canonicalEnvelope(env as JsonEnvelope)));
      // RFC 8785: sorted members, no whitespace, JSON.stringify's escapes.
      expect(text).toBe(
        JSON.stringify(JSON.parse(text), (_k, v: unknown) =>
          v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : v,
        ),
      );
      expect(await documentHash(env as JsonEnvelope)).toBe(sha(text));
    }
  });

  it('omits an attribute equal to its default, ext {} and a null id included, so writing it out changes nothing', () => {
    const plain = exampleDoc();
    const explicit = exampleDoc();
    Object.assign(bodyOf(explicit)[2]!.attrs, {
      ext: {},
      numbering: null,
      align: null,
      indentLeft: null,
    });
    Object.assign(explicit['doc'].content[0].content[0].attrs, {
      dir: 'ltr',
      defaultTabStop: 720,
      hyphenation: false,
      trackChanges: 'off',
      citationStyle: 'authorYear',
    });
    explicit['doc'].attrs = { ext: {} };
    expect(canonicalText(explicit as JsonEnvelope)).toBe(canonicalText(plain as JsonEnvelope));
    const p: JsonNode = { type: 'paragraph', attrs: { id: null, style: null } };
    expect(canonicalNode(p)).toEqual({ type: 'paragraph' });
  });

  it('orders marks by the schema list and then by their attributes, two insertions of two users included', () => {
    const a = { type: 'ins', attrs: { id: 'sAliceInsert0001', user: 'alice' } };
    const b = { type: 'ins', attrs: { id: 'sBobInsert000001', user: 'bob' } };
    const run = (marks: Json[]): JsonNode => ({
      type: 'paragraph',
      attrs: { id: 'pPara00000000001' },
      content: [{ type: 'text', text: 'x', marks } as JsonNode],
    });
    const one = canonicalNode(
      run([b, { type: 'bold' }, a, { type: 'link', attrs: { href: 'https://example.org' } }]),
    );
    const two = canonicalNode(
      run([a, { type: 'link', attrs: { href: 'https://example.org' } }, b, { type: 'bold' }]),
    );
    expect(canonicalize(one)).toBe(canonicalize(two));
    expect(one.content![0]!.marks!.map((m) => m.attrs?.['user'] ?? m.type)).toEqual([
      'link',
      'bold',
      'alice',
      'bob',
    ]);
  });

  it('merges adjacent text with equal marks and keeps text with unequal marks apart', () => {
    const n = canonicalNode({
      type: 'paragraph',
      attrs: { id: 'pPara00000000001' },
      content: [
        { type: 'text', text: 'a', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'b', marks: [{ type: 'bold', attrs: { value: true } }] },
        { type: 'text', text: 'c', marks: [{ type: 'bold', attrs: { value: false } }] },
        { type: 'text', text: 'd' },
        { type: 'text', text: 'e' },
      ],
    });
    expect(n.content!.map((t) => t.text)).toEqual(['ab', 'c', 'de']);
  });

  it('refuses a number that is not an integer in the interoperable range, wherever it is, with a typed error', () => {
    const cases: Array<[string, (d: Json) => void, string]> = [
      [
        'attribute',
        (d) => (d['doc'].content[0].content[1].attrs.fontSize = 220.5),
        '/doc/content/0/content/1/attrs/fontSize',
      ],
      [
        'ext',
        (d) => (bodyOf(d)[2]!.attrs.ext = { 'vendor.example:ratio': 0.5 }),
        '/doc/content/1/content/2/attrs/ext/vendor.example:ratio',
      ],
      [
        'payload',
        (d) =>
          bodyOf(d).push({
            type: 'extension_block',
            attrs: {
              id: 'xBlock0000000001',
              extension: 'com.example.x',
              payload: { n: [1, 2 ** 53] },
              fallbackText: 'x',
            },
          }),
        '/doc/content/1/content/3/attrs/payload/n/1',
      ],
      [
        'mark',
        (d) =>
          (bodyOf(d)[0]!.content[0].marks = [
            { type: 'fontSize', attrs: { value: Number.POSITIVE_INFINITY } },
          ]),
        '/doc/content/1/content/0/content/0/marks/0/attrs/value',
      ],
    ];
    for (const [name, change, path] of cases) {
      const d = exampleDoc();
      change(d);
      let error: unknown;
      try {
        canonicalText(d as JsonEnvelope);
      } catch (e) {
        error = e;
      }
      expect(error, name).toBeInstanceOf(CanonicalizationError);
      expect((error as CanonicalizationError).path, name).toBe(path);
    }
  });

  it('keeps a hostile key such as __proto__ as data and changes no prototype (CDM-015)', () => {
    const attrs = JSON.parse('{"id":"pPara00000000001","__proto__":{"polluted":true}}') as Record<
      string,
      Json
    >;
    const n = canonicalNode({ type: 'paragraph', attrs } as JsonNode);
    expect(Object.getPrototypeOf(n.attrs)).toBe(Object.prototype);
    expect(Object.keys(n.attrs!)).toEqual(['id', '__proto__']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(canonicalize(n)).toBe(
      '{"attrs":{"__proto__":{"polluted":true},"id":"pPara00000000001"},"type":"paragraph"}',
    );
  });
});

// -------------------------------------------------------------------------------------------------
// Property: equal documents reached through different histories hash equally.

const MARKS = ['bold', 'italic', 'strike'] as const;
const runArb = fc.record({
  text: fc.string({ minLength: 1, maxLength: 6, unit: fc.constantFrom('a', 'b', 'é', ' ', '😀') }),
  marks: fc.subarray([...MARKS]),
});

/** A paragraph of runs, as JSON with marks in a given order. */
function paragraph(
  runs: Array<{ text: string; marks: string[] }>,
  order: (m: string[]) => string[],
): JsonNode {
  return {
    type: 'paragraph',
    attrs: { id: 'pPara00000000001' },
    content: runs.map((r) => ({
      type: 'text',
      text: r.text,
      ...(r.marks.length ? { marks: order(r.marks).map((type) => ({ type })) } : {}),
    })),
  };
}

function envelopeWith(p: JsonNode): JsonEnvelope {
  const d = exampleDoc();
  bodyOf(d)[2] = p;
  return d as JsonEnvelope;
}

describe('equal documents through different histories (CDM-010)', () => {
  it('hash equally after random splits, joins, mark orders and edits that cancel out', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(runArb, { minLength: 1, maxLength: 6 }),
        fc.array(fc.nat(), { maxLength: 6 }),
        fc.nat(),
        async (runs, cuts, seed) => {
          // History A: the runs as written, marks in schema order.
          const a = envelopeWith(paragraph(runs, (m) => [...m]));
          // History B: every run split at random points, marks in reverse order.
          const split = runs.flatMap((r, i) => {
            const at = r.text.length > 1 ? 1 + ((cuts[i] ?? 0) % (r.text.length - 1)) : 0;
            return at
              ? [
                  { ...r, text: r.text.slice(0, at) },
                  { ...r, text: r.text.slice(at) },
                ]
              : [r];
          });
          const b = envelopeWith(paragraph(split, (m) => [...m].reverse()));
          // History C: ProseMirror steps that add and remove a mark and insert and delete text.
          let doc = cdmSchema().nodeFromJSON(a.doc);
          const start =
            doc.child(0).nodeSize +
            doc.child(1).child(0).nodeSize +
            doc.child(1).child(1).nodeSize +
            2;
          const end = start + doc.child(1).child(2).content.size;
          // A mark no run has (underline is not among MARKS): adding and removing it is no change.
          const extra = schema.marks['underline']!.create({
            style: seed % 2 ? 'double' : 'single',
          });
          const steps = [
            new ReplaceStep(start, start, new Slice(Fragment.from(schema.text('zz')), 0, 0)),
            new ReplaceStep(start, start + 2, Slice.empty),
            new AddMarkStep(start, end, extra),
            new RemoveMarkStep(start, end, extra),
          ];
          for (const s of steps) doc = s.apply(doc).doc!;
          const c: JsonEnvelope = { cdm: 1, requires: [], doc: doc.toJSON() as JsonNode };
          const [ha, hb, hc] = await Promise.all([
            documentHash(a),
            documentHash(b),
            documentHash(c),
          ]);
          expect(hb).toBe(ha);
          expect(hc).toBe(ha);
        },
      ),
      { numRuns: 200, seed: 20261106 },
    );
  });
});
