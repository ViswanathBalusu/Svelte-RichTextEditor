/**
 * SEC-027 criterion 4 — a commit that crosses a numeric limit of the document invariants is refused
 * (10 §3.3; 03 §8 I7 and I15). The limits are not re-specified here: the invariant fixtures of
 * CDM-014 (`packages/model/fixtures/invariants/cases`) already hold, for each limit, a base
 * document and the commit steps that cross it. This suite replays every "past the limit" fixture
 * through the real service as a commit from an owner, over the wire, and checks that the commit is
 * refused and the stored document does not change. A commit above the frame size is sent as chunks
 * (05 §4), as the component would send it.
 *
 * Two fixtures cannot be sent exactly as they are written, so they are adapted, and the adaptation
 * keeps the limit they test:
 *
 * - `i7-canonical-size-past` inserts 16 MiB of text in one commit. The room's commit-size limit
 *   (`maxCommitBytes`, 1 MiB, SEC-017) closes such a message with 4413 before the invariant check
 *   runs. Here the document is grown to exactly 16 MiB by commits under that limit (the length of
 *   `i7-canonical-size-at`), the size is measured, and then the one more character of the past
 *   fixture is sent. That commit crosses the limit and must be refused.
 * - `i7-depth-13` has no steps: it is a stored document 13 deep through regions inside regions,
 *   which the control plane refuses at creation. Here the base is that document without its deep
 *   region, and the commit inserts the deep region. No valid document is deeper than 12 (regions
 *   and tables do not nest, footnotes do not nest), so this commit also breaks I3; the model's own
 *   fixture test shows that the depth walk stops with I7.
 *
 * The "at the limit" fixtures are not replayed as acceptances, except the canonical size, which the
 * growth above reaches. The model's fixture tests cover both sides of each limit.
 *
 * The corpus has no fixture for two limits of I15 (500 rules, 4 KiB per value). This suite builds
 * those two commits itself, by the same rules as the corpus, at the limit and one past it (ADR 0121
 * item 7; the corpus itself is the model's, `packages/model`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReplaceStep } from 'prosemirror-transform';
import { canonicalText, uuid7, type JsonEnvelope } from '@docedit/model';
import { Fragment, Slice, at, loadDoc, schema, stepsJson } from './support/cdm.ts';
import {
  insertText,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import {
  allCases,
  asCommit,
  baseOf,
  contentOf,
  openAsOwner,
  readCase,
  submitCommit,
  type Json,
} from './support/invariant-corpus.ts';

const CANONICAL_LIMIT = 16 * 1024 * 1024; // I7 (03 §8)
/** Characters of text per growth commit: its JSON stays under maxCommitBytes (1 MiB, SEC-017). */
const GROWTH_CHARS = 1_000_000;

/** The limits of I7 and I15 that SEC-027 criterion 4 names, by the fixture corpus's names. */
const CORPUS_LIMITS = ['canonicalBytes', 'regions', 'tableColumns', 'depth', 'latex', 'fields'];

interface LimitCase {
  name: string;
  limit: { name: string; side: 'at' | 'past' };
  base: Json;
  steps: Json[];
  expected: string[];
}

/** The past-the-limit fixtures: each one crosses a numeric limit and expects an invariant to break. */
function pastLimitCases(): LimitCase[] {
  return allCases()
    .filter((c) => c.limit?.side === 'past' && c.expected.length > 0)
    .map((c) => {
      const commit = asCommit(baseOf(c.base), c.steps);
      return { name: c.name, limit: c.limit!, expected: c.expected, ...commit };
    });
}

/** A base with `count` rule definitions in its `defs` (I15: 500 is the limit). */
function withRules(base: Json, count: number): Json {
  const out = structuredClone(base);
  const defs = (out['doc']['content'] as Json[]).find((n) => n['type'] === 'defs')!;
  for (let i = 0; i < count; i++)
    (defs['content'] as Json[]).push({
      type: 'rule_def',
      attrs: {
        id: `rule${i}`,
        when: { '==': [{ field: 'tenant.name' }, `v${i}`] },
        then: [{ show: ['tenant.income'] }],
        else: null,
      },
    });
  return out;
}

/** The step that appends one more rule definition to the end of `defs` (crosses I15's 500). */
function appendRuleStep(base: Json): Record<string, unknown>[] {
  const d = loadDoc(base['doc']);
  let end = -1;
  d.descendants((n, p) => {
    if (n.type.name === 'defs') end = p + n.nodeSize - 1;
    return end < 0;
  });
  if (end < 0) throw new Error('no defs');
  const rule = schema.nodes['rule_def']!.create({
    id: 'ruleOver500',
    when: { '==': [{ field: 'tenant.name' }, 'over'] },
    then: [{ show: ['tenant.income'] }],
  });
  return stepsJson([new ReplaceStep(end, end, new Slice(Fragment.from(rule), 0, 0))]);
}

/**
 * The step that replaces the income field with a text field whose value is `bytes` long (I15's
 * 4 KiB limit). The field keeps its identifier, so I2 holds.
 */
function valueStep(base: Json, bytes: number): Record<string, unknown>[] {
  const d = loadDoc(base['doc']);
  const from = at(d, 'ffIncome00000001');
  const field = schema.nodes['form_field']!.create({
    id: 'ffIncome00000001',
    key: 'tenant.income',
    kind: 'text',
    label: 'Income',
    assignee: 'role_tenant',
    value: 'x'.repeat(bytes),
  });
  return stepsJson([new ReplaceStep(from, from + 1, new Slice(Fragment.from(field), 0, 0))]);
}

const cases = pastLimitCases();

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-027 commits past a numeric limit are refused (${storage})`, () => {
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    it('replays a past-the-limit fixture for every limit of I7 and I15 in the corpus', () => {
      const names = new Set(cases.map((c) => c.limit.name));
      for (const limit of CORPUS_LIMITS)
        expect(names, `a past-the-limit fixture for ${limit}`).toContain(limit);
    });

    // The corpus of CDM-014 has no fixture for these two limits of I15 (ADR 0121 item 7); the
    // commits are built here. The base is the document at the limit, so it must be accepted.
    t()(
      'accepts a document with exactly 500 rules and refuses the commit that adds a 501st (I15)',
      async () => {
        const base = withRules(baseOf(readCase('i15-fields-2000')['base']), 500);
        const doc = await h.createDocument(h.a, base);
        const before = await contentOf(h, doc);
        const owner = await openAsOwner(h, doc, base['requires']);
        try {
          const r = await submitCommit(owner, {
            id: uuid7(),
            base: before['seq'] as number,
            steps: appendRuleStep(base),
          });
          expect(r.t, `501 rules are rejected: ${JSON.stringify(r.d)}`).toBe('sync.reject');
          expect(['invalid_op', 'field_invalid']).toContain(r.d?.['code']);
          expect(String(r.d?.['message'] ?? '')).toMatch(/\bI15\b/);
          const after = await contentOf(h, doc);
          expect(after['seq']).toBe(before['seq']);
          expect(after['doc']).toEqual(before['doc']);
        } finally {
          owner.terminate();
        }
      },
      120_000,
    );

    t()(
      'accepts a field value of exactly 4 KiB and refuses one byte more (I15)',
      async () => {
        const base = baseOf(readCase('i15-fields-2000')['base']);
        const doc = await h.createDocument(h.a, base);
        const owner = await openAsOwner(h, doc, base['requires']);
        try {
          const at4k = await submitCommit(owner, {
            id: uuid7(),
            base: (await contentOf(h, doc))['seq'] as number,
            steps: valueStep(base, 4096),
          });
          expect(at4k.t, `4096 bytes is accepted: ${JSON.stringify(at4k.d)}`).toBe('sync.ack');

          const before = await contentOf(h, doc);
          const over = await submitCommit(owner, {
            id: uuid7(),
            base: before['seq'] as number,
            steps: valueStep(base, 4097),
          });
          expect(over.t, `4097 bytes is rejected: ${JSON.stringify(over.d)}`).toBe('sync.reject');
          expect(['invalid_op', 'field_invalid']).toContain(over.d?.['code']);
          expect(String(over.d?.['message'] ?? '')).toMatch(/\bI15\b/);
          const after = await contentOf(h, doc);
          expect(after['seq']).toBe(before['seq']);
          expect(after['doc']).toEqual(before['doc']);
        } finally {
          owner.terminate();
        }
      },
      120_000,
    );

    for (const c of cases.filter((x) => x.limit.name !== 'canonicalBytes')) {
      t()(
        `refuses a commit past ${c.limit.name} (${c.name}) and leaves the document unchanged`,
        async () => {
          const doc = await h.createDocument(h.a, c.base);
          const before = await contentOf(h, doc);
          const owner = await openAsOwner(h, doc, c.base['requires']);
          try {
            const r = await submitCommit(owner, {
              id: uuid7(),
              base: before['seq'] as number,
              steps: c.steps,
            });
            expect(r.t, `${c.name} is rejected: ${JSON.stringify(r.d)}`).toBe('sync.reject');
            // invalid_op for an invariant break (field_invalid when only a field value is wrong).
            expect(['invalid_op', 'field_invalid']).toContain(r.d?.['code']);
            // The refusal names an invariant the fixture expects, so it is not some other failure.
            const message = String(r.d?.['message'] ?? '');
            expect(
              c.expected.some((i) => new RegExp(`\\b${i}\\b`).test(message)),
              `${message} names one of ${c.expected.join(', ')}`,
            ).toBe(true);

            const after = await contentOf(h, doc);
            expect(after['seq']).toBe(before['seq']);
            expect(after['doc']).toEqual(before['doc']);
          } finally {
            owner.terminate();
          }
        },
        120_000,
      );
    }

    t()(
      'grows a document to exactly 16 MiB by accepted commits and refuses the commit that passes it (i7-canonical-size-past)',
      async () => {
        const atCase = readCase('i7-canonical-size-at');
        const pastCase = readCase('i7-canonical-size-past');
        const at = atCase['steps'][0]['slice']['content'][0]['text']['count'] as number;
        const past = pastCase['steps'][0]['slice']['content'][0]['text']['count'] as number;
        const from = pastCase['steps'][0]['from'] as number;
        expect(atCase['steps'][0]['from']).toBe(from);
        expect(past).toBeGreaterThan(at);

        const base = baseOf(pastCase['base']);
        const doc = await h.createDocument(h.a, base);
        const start = await contentOf(h, doc);
        const owner = await openAsOwner(h, doc, base['requires']);
        try {
          let seq = start['seq'] as number;
          for (let done = 0; done < at;) {
            const n = Math.min(GROWTH_CHARS, at - done);
            const r = await submitCommit(owner, {
              id: uuid7(),
              base: seq,
              steps: [insertText(from, 'x'.repeat(n))],
            });
            expect(r.t, `growth commit at ${done} characters: ${JSON.stringify(r.d)}`).toBe(
              'sync.ack',
            );
            seq += 1;
            done += n;
          }

          // The document at the limit was accepted; measure it rather than assume the fixture's count.
          const atLimit = await contentOf(h, doc);
          expect(atLimit['seq']).toBe(seq);
          const envelope = {
            cdm: atLimit['cdm'],
            requires: atLimit['requires'],
            doc: atLimit['doc'],
          } as JsonEnvelope;
          const size = Buffer.byteLength(canonicalText(envelope), 'utf8');
          expect(size).toBe(CANONICAL_LIMIT);

          const r = await submitCommit(owner, {
            id: uuid7(),
            base: seq,
            steps: [insertText(from, 'x'.repeat(past - at))],
          });
          expect(r.t, `the commit past 16 MiB is rejected: ${JSON.stringify(r.d)}`).toBe(
            'sync.reject',
          );
          expect(r.d?.['code']).toBe('invalid_op');
          expect(String(r.d?.['message'] ?? '')).toMatch(/\bI7\b/);

          const after = await contentOf(h, doc);
          expect(after['seq']).toBe(seq);
          expect(after['doc']).toEqual(atLimit['doc']);
        } finally {
          owner.terminate();
        }
      },
      300_000,
    );
  });
}
