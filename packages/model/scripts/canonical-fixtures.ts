/**
 * The canonical-form hash fixtures (CDM-011; 03 §2: "The conformance kit carries hash fixtures"):
 * inputs, the canonical bytes each must give, and their SHA-256, as files that need no TypeScript
 * to read (packages/model/fixtures/canonical). Written by `pnpm generate`.
 *
 * An expected output that already exists is never changed under the same CANONICAL_FORM_VERSION:
 * a change of the canonical rules must be declared by raising the version (CDM-003), which starts
 * a new set of expected outputs.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import example from '../fixtures/example-03-12.json' with { type: 'json' };
import kitchenSink from '../fixtures/kitchen-sink.json' with { type: 'json' };
import {
  CANONICAL_FORM_VERSION,
  canonicalNodeText,
  canonicalText,
  type JsonEnvelope,
  type JsonNode,
} from '../src/canonical/canonical-form.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The canonical rules of 03 §2 and CDM-003, as fixture tags. */
export const RULES = {
  defaults:
    'An attribute equal to its default is omitted, `ext: {}` and null identifiers included.',
  markOrder:
    'Marks are ordered by the schema mark list, then by the RFC 8785 text of their attributes.',
  textMerge: 'Adjacent text nodes with equal marks are merged; empty text nodes are dropped.',
  ext: 'A non-empty `ext` is kept and hashed; an empty one is omitted.',
  emptyMembers: 'Empty `attrs`, `content` and `marks` are omitted.',
  requires: '`requires` is sorted by UTF-16 code units without duplicates.',
  objectAttributes:
    'Object-valued attributes are compared and kept whole; defaults inside them stay.',
  subtree: 'A subtree is canonicalised alone, without the envelope (07 §11).',
  bytes: 'The bytes are the UTF-8 encoding of the RFC 8785 text.',
} as const;
export type Rule = keyof typeof RULES;

export interface CaseInput {
  name: string;
  kind: 'envelope' | 'node';
  rules: Rule[];
  input: unknown;
  /** Asset identifiers attached to the document, for validating the input. */
  assets?: string[];
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const SINK_ASSETS = [
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a11',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a12',
  '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a13',
];

/** The kitchen sink plus what it lacks, so that one document uses every node, mark and field kind. */
function allConstructs(): Json {
  const d = clone(kitchenSink) as Json;
  d['doc'].content[0].content[0].attrs.citationStyle = 'numeric';
  d['doc'].content[0].content.push({
    type: 'source_def',
    attrs: {
      id: 'srcKnuth1984',
      kind: 'book',
      title: 'The TeXbook',
      authors: [{ family: 'Knuth', given: 'Donald E.' }],
      issued: '1984',
      publisher: 'Addison-Wesley',
      isbn: '0-201-13447-0',
      extra: { 'number-of-pages': '483' },
    },
  });
  // A shared preserved tree (spike S11), referred to by the last paragraph.
  d['doc'].content[0].content.push({
    type: 'preserved_def',
    attrs: { id: 'pdKeepLines01', tree: { children: [{ name: 'w:keepLines' }] } },
  });
  const body = d['doc'].content.find((n: Json) => n.type === 'body').content as Json[];
  body[body.length - 1]!.attrs.preserved = { ref: 'pdKeepLines01' };
  // An inline atom with marks and an origin (spike S11).
  const inline = body.find((n: Json) => n.attrs?.id === 'pInline000000001')!;
  inline.content[0].marks = [{ type: 'bold' }];
  inline.content[0].attrs.origin = {
    fragment: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a12',
    hash: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
  };
  body.push(
    {
      type: 'paragraph',
      attrs: { id: 'pCitation0000001', style: 'Heading1' },
      content: [
        { type: 'text', text: 'As shown', marks: [{ type: 'strike' }, { type: 'smallCaps' }] },
        {
          type: 'text',
          text: ' in',
          marks: [{ type: 'allCaps' }, { type: 'fontFamily', attrs: { value: 'Noto Sans' } }],
        },
        { type: 'text', text: ' secret', marks: [{ type: 'hidden' }] },
        {
          type: 'citation',
          attrs: {
            items: [{ source: 'srcKnuth1984', locator: '12', label: 'page', prefix: 'see' }],
          },
        },
        { type: 'field', attrs: { kind: 'date', format: 'dd/MM/yyyy' } },
        { type: 'field', attrs: { kind: 'title', cached: 'Lease' } },
        { type: 'field', attrs: { kind: 'styleRef', target: 'style:Heading1' } },
      ],
    },
    { type: 'bibliography', attrs: { id: 'bibMain000000001' } },
  );
  return d;
}

/** Every fixture case, built from the example of 03 §12 and the kitchen sink. */
export function canonicalCases(): CaseInput[] {
  const ex = () => clone(example) as Json;
  const paragraph = (content: Json[]): Json => {
    const d = ex();
    d['doc'].content[1].content[2].content = content;
    return d;
  };
  const defaults = ex();
  Object.assign(defaults['doc'].content[0].content[0].attrs, {
    dir: 'ltr',
    defaultTabStop: 720,
    hyphenation: false,
    footnoteFormat: 'decimal',
    trackChanges: 'off',
    citationStyle: 'authorYear',
    ext: {},
  });
  Object.assign(defaults['doc'].content[1].content[2].attrs, {
    numbering: null,
    align: null,
    ext: {},
    preserved: null,
  });
  defaults['doc'].content[0].content[3].attrs.columns = 1;
  const emptyMembers = ex();
  emptyMembers['doc'].content[1].content[2].content = [];
  emptyMembers['doc'].content[1].content[2].marks = [];
  emptyMembers['doc'].content[0].attrs = {};
  const ext = ex();
  ext['doc'].content[1].content[0].attrs.ext = {
    'vendor.example:tag': 'intro',
    'vendor.example:rank': 2,
  };
  ext['doc'].content[1].content[2].attrs.ext = {};
  const objects = ex();
  objects['doc'].content[1].content.push({
    type: 'table',
    attrs: {
      id: 'tTable0000000001',
      grid: [4513, 4513],
      width: { type: 'auto', value: 0 },
      borders: { top: { style: 'single', width: 4, space: 0 } },
      headerRows: 0,
    },
    content: [
      {
        type: 'table_row',
        attrs: { id: 'rRow000000000001' },
        content: ['A', 'B'].map((c) => ({
          type: 'table_cell',
          attrs: { id: `cCell000000000${c}`, colspan: 1 },
          content: [{ type: 'paragraph', attrs: { id: `pCell00000000${c}01` } }],
        })),
      },
    ],
  });
  const requires = ex();
  requires['requires'] = ['preserve', 'extensions', 'fields'];
  return [
    {
      name: 'example-03-12',
      kind: 'envelope',
      rules: ['bytes', 'defaults', 'emptyMembers'],
      input: ex(),
    },
    {
      name: 'all-constructs',
      kind: 'envelope',
      rules: ['bytes', 'markOrder', 'textMerge'],
      input: allConstructs(),
      assets: SINK_ASSETS,
    },
    { name: 'defaults-written-out', kind: 'envelope', rules: ['defaults', 'ext'], input: defaults },
    {
      name: 'mark-order',
      kind: 'envelope',
      rules: ['markOrder'],
      input: paragraph([
        {
          type: 'text',
          text: 'one',
          marks: [
            { type: 'ins', attrs: { id: 'sBobInsert000001', user: 'bob' } },
            { type: 'italic' },
            { type: 'ins', attrs: { id: 'sAliceInsert0001', user: 'alice' } },
            { type: 'link', attrs: { href: 'https://example.org' } },
            { type: 'bold', attrs: { value: true } },
          ],
        },
      ]),
    },
    {
      name: 'text-merge',
      kind: 'envelope',
      rules: ['textMerge'],
      input: paragraph([
        { type: 'text', text: 'Li' },
        { type: 'text', text: 'ability ' },
        { type: 'text', text: 'is', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' ', marks: [{ type: 'bold', attrs: { value: true } }] },
        { type: 'text', text: 'limited', marks: [{ type: 'bold', attrs: { value: false } }] },
        { type: 'text', text: '' },
        { type: 'text', text: ' 😀 é' },
      ]),
    },
    { name: 'ext', kind: 'envelope', rules: ['ext'], input: ext },
    { name: 'empty-members', kind: 'envelope', rules: ['emptyMembers'], input: emptyMembers },
    {
      name: 'object-attributes',
      kind: 'envelope',
      rules: ['objectAttributes', 'defaults'],
      input: objects,
    },
    { name: 'requires-order', kind: 'envelope', rules: ['requires'], input: requires },
    {
      name: 'region-subtree',
      kind: 'node',
      rules: ['subtree', 'defaults'],
      input: ex()['doc'].content[1].content[1],
    },
  ];
}

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/** Writes the fixtures under `dir`; refuses to change an expected output of the same version. */
export async function writeCanonicalFixtures(dir: string): Promise<string[]> {
  const indexFile = resolve(dir, 'index.json');
  const previous = existsSync(indexFile)
    ? (JSON.parse(readFileSync(indexFile, 'utf8')) as {
        canonicalFormVersion: number;
        cases: Array<{ name: string; inputSha256?: string }>;
      })
    : null;
  const written: string[] = [];
  const cases = [];
  for (const c of canonicalCases()) {
    const text =
      c.kind === 'envelope'
        ? canonicalText(c.input as JsonEnvelope)
        : canonicalNodeText(c.input as JsonNode);
    const input = `inputs/${c.name}.json`;
    // `.jcs` (JSON Canonicalization Scheme): exact bytes that no formatter may touch.
    const expected = `expected/${c.name}.jcs`;
    const expectedFile = resolve(dir, expected);
    const inputText = await formatJson(c.input);
    const inputSha256 = sha(inputText);
    const before = previous?.cases.find((p) => p.name === c.name);
    // The same input under the same version must give the same bytes; a new input may not.
    if (
      previous?.canonicalFormVersion === CANONICAL_FORM_VERSION &&
      before?.inputSha256 === inputSha256 &&
      existsSync(expectedFile) &&
      readFileSync(expectedFile, 'utf8') !== text
    )
      throw new Error(
        `the canonical form of ${c.name} changed under CANONICAL_FORM_VERSION ${CANONICAL_FORM_VERSION}; declare the change by raising the version (CDM-003)`,
      );
    for (const [file, body] of [
      [input, inputText],
      [expected, text],
    ] as const) {
      await mkdir(dirname(resolve(dir, file)), { recursive: true });
      await writeFile(resolve(dir, file), body, 'utf8');
      written.push(file);
    }
    cases.push({
      name: c.name,
      kind: c.kind,
      rules: c.rules,
      input,
      inputSha256,
      expected,
      sha256: sha(text),
      ...(c.assets ? { assets: c.assets } : {}),
    });
  }
  const index = {
    description:
      'Canonical-form fixtures of the CDM (03 §2; CDM-011). For each case, the canonical form of `input` (an envelope, or a node alone for kind `node`) is exactly the bytes of `expected` (UTF-8, no trailing newline), whose SHA-256 is `sha256`. Defaults and the mark order are those of spec/cdm/cdm-1.prosemirror.json.',
    canonicalFormVersion: CANONICAL_FORM_VERSION,
    rules: RULES,
    cases,
  };
  await writeFile(indexFile, await formatJson(index), 'utf8');
  written.push('index.json');
  return written;
}

/** JSON in the layout the repository's Prettier configuration gives it. */
async function formatJson(value: unknown): Promise<string> {
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(resolve(import.meta.dirname, 'x.json'))) ?? {};
  return prettier.format(JSON.stringify(value), { ...config, parser: 'json' });
}
