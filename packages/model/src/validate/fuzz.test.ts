// Fuzzing the reader and the validator (CDM-015): documents generated from the definition, hostile
// strings in every grammar, prototype keys, all within a time bound. The run is bounded and uses
// fixed seeds, recorded on the test; a failing input is saved as a regression fixture in the
// format of CDM-014 (fixtures/invariants/regressions), which invariant-fixtures.test.ts replays.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
import kitchenSink from '../../fixtures/kitchen-sink.json' with { type: 'json' };
import { CDM1, LINK_HREF_PATTERN } from '../definition/cdm1.ts';
import { SOURCE_URL_PATTERN } from '../definition/citations.ts';
import type { Grammar, JsonValue } from '../definition/grammar.ts';
import { grammarProblems } from './grammar-check.ts';
import { readDocument } from './read.ts';
import { validate } from './validate.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

declare module 'vitest' {
  interface TaskMeta {
    /** The fast-check seed a fuzz run covered (CDM-015: the run records its seeds). */
    fuzzSeed?: number;
  }
}

const SEEDS = [20261106, 1, 42, 4711, 65535];
const TIME_LIMIT_MS = 2000;
const regressions = resolve(import.meta.dirname, '../../fixtures/invariants/regressions');
const seeds = [example, kitchenSink] as Json[];

/** Hostile strings for every grammar context (CDM-015 criterion 2). */
export const HOSTILE = [
  '\\input{/etc/passwd}',
  '$\\x$ & % # ^ _ ~ { }',
  '}\\end{document}',
  'red; background: url(javascript:alert(1))',
  '</style><script>alert(1)</script>',
  'expression(alert(1))',
  'a\u0000b',
  'a\u0007b',
  'line\u000Bbreak',
  'x\u0085y',
  '\u202Etxt.exe',
  '\u2066isolate\u2069',
  'javascript:alert(1)',
  ' javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'java\tscript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',
  '//evil.example',
  'https://user@evil.example',
  'https://example.org/\u0000',
  '../../etc/passwd',
  '%00',
  '\uD800',
  'x'.repeat(70000),
];

/** Every string, reference or enumeration grammar of the definition, with where it is. */
function stringGrammars(): Array<[string, Grammar]> {
  const out: Array<[string, Grammar]> = [];
  const walk = (g: Grammar, where: string) => {
    if (g.kind === 'string' || g.kind === 'ref' || g.kind === 'enum') out.push([where, g]);
    else if (g.kind === 'object')
      for (const [k, s] of Object.entries(g.properties)) walk(s, `${where}/${k}`);
    else if (g.kind === 'array') walk(g.items, `${where}/*`);
  };
  for (const owner of [...CDM1.nodes, ...CDM1.marks])
    for (const [name, a] of Object.entries(owner.attrs)) walk(a.grammar, `${owner.name}.${name}`);
  return out;
}

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/; // eslint-disable-line no-control-regex

/** URL grammars: they accept URLs, so only their disallowed schemes and tricks must fail. */
const isUrlGrammar = (g: Grammar) =>
  g.kind === 'string' && (g.pattern === LINK_HREF_PATTERN || g.pattern === SOURCE_URL_PATTERN);
const URL_TRICKS = HOSTILE.filter(
  (s) => /script:|^data:|^\/\/|^ |\t/i.test(s) || s.includes('\u0000'),
);
/** Grammars whose values the editor writes into style declarations (02 §3; FE's mark views). */
const CSS_GRAMMARS = new Set([
  'fontFamily.value',
  'color.value',
  'highlight.value',
  'lang.value',
  'style_def.fontFamily',
  'style_def.color',
  'style_def.highlight',
  'style_def.lang',
  'paragraph.shading/fill',
]);

describe('hostile strings in every grammar (CDM-015)', () => {
  it('are refused wherever the grammar does not allow them', () => {
    const grammars = stringGrammars();
    expect(grammars.length).toBeGreaterThan(100);
    for (const [where, g] of grammars)
      for (const s of HOSTILE) {
        const refused = grammarProblems(g, s, '').length > 0;
        const label = `${where} ${JSON.stringify(s).slice(0, 40)}`;
        const patterned = g.kind !== 'string' || g.pattern !== undefined;
        // Control characters and over-long strings fail every grammar.
        if (CONTROL.test(s) || [...s].length > 2048) expect(refused, label).toBe(true);
        // TeX specials (backslash, braces) and bidirectional overrides fail every patterned grammar:
        // identifiers, names, colours, lengths, references, enumerations, URLs.
        else if (patterned && /[\\{}‪-‮⁦-⁩]/.test(s)) expect(refused, label).toBe(true);
        // What reaches a style declaration refuses characters that break one (CSS context).
        else if (CSS_GRAMMARS.has(where) && /[;:()<>]/.test(s)) expect(refused, label).toBe(true);
        // URL grammars refuse other schemes and their obfuscated forms.
        else if (isUrlGrammar(g) && URL_TRICKS.includes(s)) expect(refused, label).toBe(true);
        // Everything else is accepted only as its grammar allows: free text keeps TeX and CSS
        // specials as text, which the emitters escape (09 §4).
      }
  });

  it('reach validate() as violations at the attribute, never as an exception', () => {
    for (const s of HOSTILE) {
      const d = structuredClone(example) as Json;
      d['doc'].content[1].content[1].attrs.title = s;
      d['doc'].content[0].content[1].attrs.fontFamily = s;
      d['doc'].content[1].content[0].content[0].marks = [{ type: 'link', attrs: { href: s } }];
      const r = validate(d);
      expect(r.valid, JSON.stringify(s).slice(0, 40)).toBe(false);
      for (const v of r.violations) expect(v.code).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('prototype keys (CDM-015)', () => {
  it('are kept as data in a payload and refused as ext keys, and change no prototype', () => {
    const text = JSON.stringify(example).replace(
      '"style":"Heading1"},',
      '"style":"Heading1","ext":{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}},',
    );
    const withExt = JSON.parse(text) as Json;
    const r = validate(withExt);
    expect(r.violations.map((v) => v.code)).toEqual(['attribute_invalid', 'attribute_invalid']);
    const payload = JSON.parse(
      JSON.stringify({ ...structuredClone(example), requires: ['extensions'] }).replace(
        '{"type":"paragraph","attrs":{"id":"pZ9y8X7w6V5u4T3s","style":"Normal"}}',
        '{"type":"extension_block","attrs":{"id":"xBlock0000000001","extension":"com.example.x","fallbackText":"x","payload":{"__proto__":{"polluted":1},"constructor":1}}}',
      ),
    ) as Json;
    const read = readDocument(payload);
    expect(read.ok).toBe(true);
    if (read.ok) {
      const p = read.doc.child(1).lastChild!.attrs['payload'] as Record<string, unknown>;
      expect(Object.keys(p)).toEqual(['__proto__', 'constructor']);
    }
    // Unknown attributes named after Object.prototype members are refused, not matched.
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const d = JSON.parse(
        JSON.stringify(example).replace('"style":"Normal"}}]}', `"style":"Normal","${key}":1}}]}`),
      ) as Json;
      expect(
        validate(d).violations.map((v) => v.code),
        key,
      ).toContain('unknown_attribute');
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

// -------------------------------------------------------------------------------------------------
// Documents generated from the definition.

const valueArb: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -40000, max: 40000 }),
  fc.double({ noNaN: false }),
  fc.constantFrom(...HOSTILE.slice(0, 22)),
  fc.string({ maxLength: 40 }),
  fc.array(fc.integer(), { maxLength: 4 }),
  fc.dictionary(fc.constantFrom('a', 'type', '__proto__', 'vendor.example:k'), fc.integer(), {
    maxKeys: 3,
  }),
);
const nodeNames = CDM1.nodes.map((n) => n.name);
const markNames = CDM1.marks.map((m) => m.name);

/** A random node of the definition, with random attributes, marks and children. */
const nodeArb: fc.Arbitrary<Json> = fc.letrec<{ node: Json }>((tie) => ({
  node: fc.record(
    {
      type: fc.constantFrom(...nodeNames, 'hidden_region', 'comment'),
      attrs: fc.dictionary(
        fc.constantFrom(
          'id',
          'style',
          'kind',
          'latex',
          'value',
          'ext',
          'grid',
          'colspan',
          'payload',
          'target',
        ),
        valueArb,
        { maxKeys: 4 },
      ),
      marks: fc.array(
        fc.record({
          type: fc.constantFrom(...markNames),
          attrs: fc.dictionary(fc.constantFrom('value', 'id', 'user', 'href', 'before'), valueArb, {
            maxKeys: 3,
          }),
        }),
        { maxLength: 4 },
      ),
      text: fc.string({ maxLength: 20 }),
      content: fc.array(tie('node'), { maxLength: 3, depthIdentifier: 'tree' }),
    },
    { requiredKeys: ['type'] },
  ),
})).node;

/** A seed document with random nodes inserted, random nesting, or random attribute values. */
const documentArb = fc.record({
  seed: fc.constantFrom(0, 1),
  inserts: fc.array(nodeArb, { maxLength: 4 }),
  depth: fc.nat({ max: 40 }),
  marks: fc.nat({ max: 60 }),
  long: fc.boolean(),
});

function build(c: {
  seed: number;
  inserts: Json[];
  depth: number;
  marks: number;
  long: boolean;
}): Json {
  const d = structuredClone(seeds[c.seed]!) as Json;
  const body = d['doc'].content.find((n: Json) => n.type === 'body').content as Json[];
  body.push(...c.inserts);
  let deep: Json = {
    type: 'paragraph',
    attrs: { id: 'pDeep00000000001' },
    content: [{ type: 'text', text: 'x' }],
  };
  for (let i = 0; i < c.depth; i++)
    deep = { type: 'region', attrs: { id: 'rDeep00000000001' }, content: [deep] };
  body.push(deep);
  body.push({
    type: 'paragraph',
    attrs: { id: 'pMarks0000000001' },
    content: [
      {
        type: 'text',
        text: c.long ? 'y'.repeat(100000) : 'y',
        marks: Array.from({ length: c.marks }, () => ({ type: 'bold' })),
      },
    ],
  });
  return d;
}

function save(name: string, doc: Json, error: string): void {
  mkdirSync(regressions, { recursive: true });
  writeFileSync(
    resolve(regressions, `${name}.json`),
    `${JSON.stringify({ name, doc: `fuzz failure: ${error}`, base: doc, steps: [], context: {}, expected: [] })}\n`,
  );
}

describe('documents generated from the definition (CDM-015)', () => {
  it.for(SEEDS)(
    'end in a result within the time limit, never an uncaught exception (seed %i)',
    (seed, { task }) => {
      task.meta.fuzzSeed = seed;
      const run = fc.check(
        fc.property(documentArb, (c) => {
          const doc = build(c);
          const start = performance.now();
          const r = validate(doc, { mathGate: () => null });
          const read = readDocument(doc);
          expect(performance.now() - start).toBeLessThan(TIME_LIMIT_MS);
          expect(typeof r.valid).toBe('boolean');
          expect(read.ok === false ? typeof read.code : 'ok').toMatch(/^[a-z_]+$/);
          if (!r.valid) expect(read.ok).toBe(false);
        }),
        { seed, numRuns: 60, interruptAfterTimeLimit: 20_000 },
      );
      // Only the shrunk counterexample is kept, as a regression in the format of CDM-014.
      if (run.failed && run.counterexample)
        save(`fuzz-${seed}`, build(run.counterexample[0]), String(run.errorInstance));
      expect(run.failed, fc.defaultReportMessage(run) ?? '').toBe(false);
    },
  );

  it('survives values a JSON parser never makes: null prototypes, NaN, infinities, undefined', () => {
    const odd = Object.create(null) as Record<string, unknown>;
    odd['x'] = 1;
    const d = structuredClone(example) as Json;
    d['doc'].content[1].content[2].attrs = {
      id: odd,
      style: Number.NaN,
      numbering: Infinity,
      align: undefined,
    };
    d['doc'].content[0].content[1].attrs.kind = odd;
    const r = validate(d, { mathGate: () => null });
    expect(r.valid).toBe(false);
    expect(readDocument(d).ok).toBe(false);
  });
});
