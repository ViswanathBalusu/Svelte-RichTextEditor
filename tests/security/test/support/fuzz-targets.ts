/**
 * The registered fuzz targets of SEC-059: every target of 10 §5, each with seeds drawn from fixtures
 * in the repository, a generator and an oracle. Each oracle calls the real code.
 *
 * Seeds: the DEP message fixtures of the conformance kit (packages/tck/fixtures/messages), its
 * canonical documents (packages/tck/fixtures/canonical/inputs), the rules fixtures
 * (spec/rules/rules-1.fixtures.json) and, for the importer, files of the DOCX import corpus
 * (packages/export-docx/corpus), which is the only set of real DOCX files here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { expect } from 'vitest';
import {
  applySteps,
  DEFAULT_LIMITS,
  mapsOf,
  parseSteps,
  rebaseOver,
  type RejectCode,
} from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import { depCodec } from '@docedit/protocol';
import { importDocx, ImportError } from '../../../../packages/export-docx/src/index.ts';
import { kvValue, pdfString, text, url } from '../../../../packages/export-latex/src/emit.ts';
import { mathGate, scanMath } from '../../../../packages/export-latex/src/math/gate.ts';
import { evaluateExpression } from '../../../../packages/rules/src/index.ts';
import { walkJson, type FuzzTarget } from './fuzz-harness.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

const MESSAGES = 'packages/tck/fixtures/messages';
const CANONICAL = 'packages/tck/fixtures/canonical/inputs';
const RULES = 'spec/rules/rules-1.fixtures.json';
const DOCX = 'packages/export-docx/corpus';

const codec = depCodec();
const schema = cdmSchema();

const REJECT_CODES: ReadonlySet<string> = new Set<RejectCode>([
  'permission_denied',
  'read_only',
  'busy',
  'invalid_op',
  'stale_base',
  'rebase_failed',
  'too_large',
  'rate_limited',
  'unavailable',
  'conflict',
  'field_invalid',
]);

// ---- seeds -----------------------------------------------------------------------------------

function messageFixtures(): unknown[] {
  return readdirSync(join(ROOT, MESSAGES))
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => readJson(`${MESSAGES}/${n}`));
}

/** Every frame of the message fixtures, valid and invalid, as the text a peer would send. */
function frameSeeds(): string[] {
  const out = new Set<string>();
  for (const f of messageFixtures())
    walkJson(f, (v) => {
      if (v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string')
        out.add(JSON.stringify(v));
    });
  return [...out];
}

/** Every `steps` array of the message fixtures. */
function stepSeeds(): unknown[][] {
  const out = new Map<string, unknown[]>();
  for (const f of messageFixtures())
    walkJson(f, (v) => {
      const steps = v && typeof v === 'object' ? (v as { steps?: unknown }).steps : undefined;
      if (Array.isArray(steps)) out.set(JSON.stringify(steps), steps);
    });
  return [...out.values()];
}

function canonicalDocuments(): unknown[] {
  return readdirSync(join(ROOT, CANONICAL))
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => readJson(`${CANONICAL}/${n}`));
}

function stringsOf(pick: (o: Record<string, unknown>) => unknown): string[] {
  const out = new Set<string>();
  for (const d of canonicalDocuments())
    walkJson(d, (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return;
      const s = pick(v as Record<string, unknown>);
      if (typeof s === 'string') out.add(s);
    });
  return [...out];
}

interface RuleInput {
  expression: unknown;
  fields: unknown[];
  values: Record<string, unknown>;
}

function ruleSeeds(): RuleInput[] {
  const fixtures = readJson(RULES) as {
    cases: {
      kind: string;
      expression?: unknown;
      given?: { fields?: unknown[]; values?: object };
    }[];
  };
  return fixtures.cases
    .filter((c) => c.kind === 'expression' && c.expression !== undefined)
    .map((c) => ({
      expression: c.expression,
      fields: c.given?.fields ?? [],
      values: { ...c.given?.values },
    }));
}

/** The three smallest files of each folder of the import corpus. */
function docxSeeds(): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const folder of readdirSync(join(ROOT, DOCX)).sort()) {
    const dir = join(ROOT, DOCX, folder);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir)
      .filter((n) => n.endsWith('.docx'))
      .map((n) => ({ n, size: statSync(join(dir, n)).size }))
      .sort((a, b) => a.size - b.size || a.n.localeCompare(b.n))
      .slice(0, 3);
    for (const f of files) out.push(new Uint8Array(readFileSync(join(dir, f.n))));
  }
  return out;
}

// ---- generators ------------------------------------------------------------------------------

const pos = fc.oneof(
  fc.integer({ min: -5, max: 400 }),
  fc.constantFrom(0, 1, 2, 1e9, -1, 3.5, Number.NaN),
);
const stepJson: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({
    stepType: fc.constantFrom(
      'replace',
      'replaceAround',
      'addMark',
      'removeMark',
      'attr',
      'docAttr',
      'frob',
    ),
    from: pos,
    to: pos,
  }),
  fc.record({ stepType: fc.constant('replace'), from: pos, to: pos, slice: fc.jsonValue() }),
  fc.record({ stepType: fc.constant('attr'), pos, attr: fc.string(), value: fc.jsonValue() }),
  fc.jsonValue(),
);
const stepsArb: fc.Arbitrary<unknown[]> = fc.array(stepJson, { maxLength: 6 });

const TEX_PIECES = ['\\', '{', '}', '%', '#', '&', '$', '^', '~', '[', ']', '_', ' ', 'a'];
const CONTROL_WORDS = ['write18', 'directlua', 'input', 'def', 'immediate', 'special', 'csname'];
const hostileText = fc.oneof(
  fc.string({ maxLength: 60 }),
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc
    .array(fc.constantFrom(...TEX_PIECES, ...CONTROL_WORDS.map((w) => `\\${w}`)), { maxLength: 40 })
    .map((cs) => cs.join('')),
);

/** Cuts a seed, or overwrites some of its bytes: what a damaged or crafted upload looks like. */
function mutated(seeds: () => Uint8Array[]): fc.Arbitrary<Uint8Array> {
  return fc
    .record({
      seed: fc.nat(),
      cut: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
      writes: fc.array(fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.nat(255)), {
        maxLength: 8,
      }),
    })
    .map(({ seed, cut, writes }) => {
      const all = seeds();
      const bytes = new Uint8Array(all[seed % all.length] ?? new Uint8Array());
      for (const [at, value] of writes)
        if (bytes.length) bytes[Math.min(bytes.length - 1, Math.floor(at * bytes.length))] = value;
      return cut === null ? bytes : bytes.slice(0, Math.floor(cut * bytes.length));
    });
}

// ---- the step targets' base document -----------------------------------------------------------

const baseDoc = schema.nodeFromJSON({
  type: 'doc',
  content: [
    {
      type: 'defs',
      content: [
        {
          type: 'settings',
          attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
        },
        {
          type: 'style_def',
          attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
        },
        {
          type: 'page_setup',
          attrs: {
            id: 'ps1',
            width: 11906,
            height: 16838,
            marginTop: 1440,
            marginRight: 1440,
            marginBottom: 1440,
            marginLeft: 1440,
          },
        },
      ],
    },
    {
      type: 'body',
      attrs: { pageSetup: 'ps1' },
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'pIntro0000000001', style: 'Normal' },
          content: [{ type: 'text', text: 'Hello world' }],
        },
      ],
    },
  ],
});

// ---- the targets -----------------------------------------------------------------------------

const envelopeParser: FuzzTarget<string> = {
  id: 'envelope-parser',
  phase: '1a',
  seedSource: MESSAGES,
  seeds: frameSeeds,
  arbitrary: fc.oneof(fc.string(), fc.json()),
  // Decoding never throws and always classifies; a decoded message passes the codec's own check.
  oracle(textIn) {
    const r = codec.decode(textIn, { receiver: 'server', maxMessageBytes: 131_072 });
    expect(['message', 'unknown', 'invalid']).toContain(r.kind);
    if (r.kind === 'message') expect(codec.check(r.message, 'server')).toEqual([]);
    if (r.kind === 'invalid') expect(r.reply.t).toBe('error');
  },
};

const stepValidation: FuzzTarget<unknown[]> = {
  id: 'step-validation',
  phase: '1a',
  seedSource: MESSAGES,
  seeds: stepSeeds,
  arbitrary: stepsArb,
  // Parsing never throws and refuses only with a code of the registry.
  oracle(steps) {
    const r = parseSteps(schema, steps, DEFAULT_LIMITS);
    if (!r.ok) expect(REJECT_CODES.has(r.code)).toBe(true);
  },
};

const rebase: FuzzTarget<unknown[]> = {
  id: 'rebase',
  phase: '1a',
  seedSource: MESSAGES,
  seeds: stepSeeds,
  arbitrary: stepsArb,
  // Applying and rebasing never throw; an accepted apply yields a document that still checks.
  oracle(steps) {
    const parsed = parseSteps(schema, steps, DEFAULT_LIMITS);
    if (!parsed.ok) return;
    const applied = applySteps(baseDoc, parsed.value);
    if (!applied.ok) {
      expect(REJECT_CODES.has(applied.code)).toBe(true);
      return;
    }
    applied.value.doc.check();
    const re = rebaseOver(parsed.value, mapsOf(parsed.value), applied.value.doc, 'reject');
    if (!re.ok) expect(REJECT_CODES.has(re.code)).toBe(true);
  },
};

const HOSTILE_WORD = /\\(?:write|directlua|input|def|immediate|special|csname)\b/;
const typedEmitters: FuzzTarget<string> = {
  id: 'typed-emitters',
  phase: '1b',
  seedSource: CANONICAL,
  seeds: () => stringsOf((o) => o['text']),
  arbitrary: hostileText,
  // No emitter throws, and none lets a control word of the input through as a control word, in
  // the text context at the start of a block and after a character.
  oracle(value) {
    for (const afterSpace of [true, false])
      expect(text(value, { afterSpace }) as string).not.toMatch(HOSTILE_WORD);
    expect(pdfString(value) as string).not.toMatch(HOSTILE_WORD);
    expect(kvValue(value) as string).not.toMatch(HOSTILE_WORD);
    const link = url(value);
    if (link.kind === 'external') expect(link.tex as string).not.toMatch(HOSTILE_WORD);
  },
};

const PRIMITIVE =
  /\\(?:def|let|csname|catcode|input|include|openin|write|directlua|special|immediate|newcommand)(?![A-Za-z])/;
const mathGateTarget: FuzzTarget<{ latex: string; display: boolean }> = {
  id: 'math-gate',
  phase: '1b',
  seedSource: CANONICAL,
  seeds: () =>
    stringsOf((o) => (o['attrs'] as { latex?: unknown } | undefined)?.latex).flatMap((latex) => [
      { latex, display: true },
      { latex, display: false },
    ]),
  arbitrary: fc.record({ latex: hostileText, display: fc.boolean() }),
  // The gate never throws; what it accepts passes the scan and holds no definition or primitive.
  oracle({ latex, display }) {
    const verdict = mathGate(latex, display);
    expect(typeof verdict.ok).toBe('boolean');
    if (!verdict.ok) return;
    expect(scanMath(latex).ok).toBe(true);
    expect(latex).not.toMatch(PRIMITIVE);
    expect(latex).not.toContain('^^');
  },
};

const OPERATORS = (): string[] => {
  const out = new Set<string>();
  for (const s of ruleSeeds())
    walkJson(s.expression, (v) => {
      if (v && typeof v === 'object' && !Array.isArray(v))
        for (const k of Object.keys(v)) out.add(k);
    });
  return [...out];
};
const expressionArb: fc.Arbitrary<unknown> = fc.letrec<{ e: unknown }>((tie) => ({
  e: fc.oneof(
    { depthSize: 'small' },
    fc.jsonValue(),
    fc
      .tuple(fc.constantFrom(...OPERATORS()), fc.array(tie('e'), { maxLength: 3 }))
      .map(([op, args]) => ({ [op]: args })),
    fc.string().map((key) => ({ field: key })),
  ),
})).e;
const rulesEvaluator: FuzzTarget<RuleInput> = {
  id: 'rules-evaluator',
  phase: '2',
  seedSource: RULES,
  seeds: ruleSeeds,
  arbitrary: fc.record({
    expression: expressionArb,
    fields: fc.constant([
      { key: 't', kind: 'text' },
      { key: 'n', kind: 'number' },
    ] as unknown[]),
    values: fc.dictionary(fc.constantFrom('t', 'n', 'x'), fc.jsonValue(), { maxKeys: 3 }),
  }),
  // The evaluator never throws: it gives a result, a list of problems, or a spent budget.
  oracle(input) {
    const r = evaluateExpression(input.expression, {
      fields: input.fields,
      values: input.values,
    } as Parameters<typeof evaluateExpression>[1]);
    if (r.ok) expect(r.result).toBeDefined();
    else if ('code' in r) expect(r.code).toBe('budget_exceeded');
    else expect(r.problems.length).toBeGreaterThan(0);
  },
};

const docxImporter: FuzzTarget<Uint8Array> = {
  id: 'docx-importer',
  phase: '2',
  seedSource: DOCX,
  seeds: docxSeeds,
  arbitrary: mutated(docxSeeds),
  cost: 8,
  // The importer returns a document or refuses with ImportError, and with nothing else.
  async oracle(bytes) {
    try {
      const result = await importDocx(bytes);
      expect(result.envelope).toBeDefined();
    } catch (e) {
      if (!(e instanceof ImportError)) throw e;
    }
  },
};

/** Every registered target. The phase check compares it with the list of 10 §5. */
export const TARGETS: readonly FuzzTarget[] = [
  envelopeParser,
  stepValidation,
  rebase,
  typedEmitters,
  mathGateTarget,
  rulesEvaluator,
  docxImporter,
];
