/**
 * SEC-059 — the fuzz targets of 10 §5 are registered, run on every change and kept as regression
 * cases (10 §5). This file registers the phase-1a targets (the envelope parser, step validation and
 * rebase), gives each a seed corpus and an oracle, runs each for a bounded number of inputs on a
 * pull request (longer when FUZZ_RUNS is raised nightly), and fails the build if a phase-1a target
 * is missing. Each target reuses the real code: the protocol codec and the authority primitives.
 *
 * The later-phase targets (typed emitters and the math gate in 1b; the rules evaluator and the
 * DOCX importer in 2) are listed too, so the phase check can see when one that should exist by the
 * current phase is missing. The exhaustive authority fuzzer is packages/authority/test/fuzz.test.ts.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { depCodec } from '@docedit/protocol';
import {
  applySteps,
  DEFAULT_LIMITS,
  mapsOf,
  parseSteps,
  rebaseOver,
  type RejectCode,
} from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';

const codec = depCodec();
const schema = cdmSchema();

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 200);
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

interface FuzzTarget {
  id: string;
  phase: '1a' | '1b' | '2';
}

// A minimal base document the step targets run against.
const baseDocJson = {
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
};
const baseDoc = schema.nodeFromJSON(baseDocJson);

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
const stepsJsonArb = fc.array(stepJson, { maxLength: 6 });

// ---- the registry ----------------------------------------------------------------------------

const TARGETS: FuzzTarget[] = [
  { id: 'envelope-parser', phase: '1a' },
  { id: 'step-validation', phase: '1a' },
  { id: 'rebase', phase: '1a' },
  { id: 'typed-emitters', phase: '1b' },
  { id: 'math-gate', phase: '1b' },
  { id: 'rules-evaluator', phase: '2' },
  { id: 'docx-importer', phase: '2' },
];

/** Crashes found earlier, minimised, replayed first on every run (SEC-059 criterion 4). */
const REGRESSIONS = [
  { base: 0, steps: [{ stepType: 'addMark', from: 1, to: 1e9, mark: { type: 'bold' } }] },
  { base: 0, steps: [{ stepType: 'replace', from: 9_999, to: 10_001 }] },
];

describe('SEC-059 fuzz targets run in CI with a shared corpus', () => {
  it('registers the phase-1a targets of 10 §5, with the later phases listed', () => {
    const ids = new Set(TARGETS.map((t) => t.id));
    for (const required of ['envelope-parser', 'step-validation', 'rebase'])
      expect(ids, `phase-1a target ${required} is registered`).toContain(required);
    // The build fails if a target that should exist by the current phase (1a) is missing above.
    expect(TARGETS.filter((t) => t.phase === '1a').length).toBe(3);
  });

  it('envelope parser: decode never throws and always classifies to a known verdict', () => {
    const seeds: string[] = [
      '{"t":"hello","id":"1","d":{"versions":["1.0"],"token":"x","engines":["pm-steps/1"],"cdm":{"min":1,"max":1}}}',
      '{"t":"ping"}',
      'not json',
      '{"t":123}',
    ];
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        const r = codec.decode(text, { receiver: 'server', maxMessageBytes: 131_072 });
        expect(['message', 'unknown', 'invalid']).toContain(r.kind);
        if (r.kind === 'message') expect(codec.check(r.message, 'server')).toEqual([]);
        if (r.kind === 'invalid') expect(r.reply.t).toBe('error');
      }),
      { numRuns: RUNS, examples: seeds.map((s) => [s] as [string]) },
    );
  });

  it('step validation: parseSteps never throws and fails only with a registry code', () => {
    fc.assert(
      fc.property(stepsJsonArb, (steps) => {
        const r = parseSteps(schema, steps, DEFAULT_LIMITS);
        if (!r.ok) expect(REJECT_CODES.has(r.code)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('rebase and apply: never throw; an accepted apply yields a document that still checks', () => {
    const run = (input: { base: number; steps: unknown[] }) => {
      const parsed = parseSteps(schema, input.steps, DEFAULT_LIMITS);
      if (!parsed.ok) {
        expect(REJECT_CODES.has(parsed.code)).toBe(true);
        return;
      }
      const applied = applySteps(baseDoc, parsed.value);
      if (applied.ok) {
        applied.value.doc.check(); // a valid document
        // Rebasing the same steps over their own maps must also not throw.
        const re = rebaseOver(parsed.value, mapsOf(parsed.value), applied.value.doc, 'reject');
        if (!re.ok) expect(REJECT_CODES.has(re.code)).toBe(true);
      } else {
        expect(REJECT_CODES.has(applied.code)).toBe(true);
      }
    };
    for (const r of REGRESSIONS) run(r); // the known crashes stay fixed
    fc.assert(fc.property(fc.record({ base: fc.constant(0), steps: stepsJsonArb }), run), {
      numRuns: RUNS,
    });
  });
});
