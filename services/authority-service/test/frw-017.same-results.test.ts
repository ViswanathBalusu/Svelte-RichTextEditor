// FRW-017 criterion 4: division by zero and a null operand give the one result ADR 0030 §3 defines,
// and the same one in the three places that evaluate a formula: the rules package as the editor
// runs it (the same code in Chromium, Firefox and WebKit: `semantics.universal.test.ts`), the
// authority (`completionWrites`, which stores the formula results when a workflow completes) and
// the authority service (`evaluateRules`). Test values only.
import { type JsonEnvelope, documentHash } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { completionWrites } from '@docedit/authority';
import { evaluateDocument } from '@docedit/rules';
import { describe, expect, it } from 'vitest';
import { AuthorityService } from '../src/service.ts';
import { baseEnvelope } from './log.ts';

type J = Record<string, unknown>;

const STALE = '9';

/** A document with the fields `a`, `b` and the formula `r` = `rule`, whose stored value is stale. */
function documentOf(values: Record<string, unknown>, expr: unknown): JsonEnvelope {
  const env = baseEnvelope(['fields']);
  const root = env.doc as unknown as { content: Array<{ content: J[] }> };
  root.content[0]!.content.push({
    type: 'rule_def',
    attrs: { id: 'r1', when: true, then: [{ set: { field: 'r', value: expr } }] },
  });
  const intro = root.content[1]!.content[0]!;
  const field = (i: number, key: string, kind: string, value: unknown) => ({
    type: 'form_field',
    attrs: {
      id: `fFx${String(i).padStart(13, '0')}`,
      key,
      kind,
      label: key,
      assignee: null,
      value,
    },
  });
  const fields = [
    field(0, 'a', 'number', values['a'] ?? null),
    field(1, 'b', 'number', values['b'] ?? null),
    field(2, 'r', 'formula', STALE),
  ];
  intro['content'] = [
    ...((intro['content'] as J[] | undefined) ?? []),
    ...fields.flatMap((f) => [{ type: 'text', text: ' ' }, f]),
  ];
  return env;
}

const A = { field: 'a' };
const B = { field: 'b' };

const CASES: Array<{
  name: string;
  values: Record<string, unknown>;
  expr: unknown;
  value: string | null;
  error?: string;
}> = [
  { name: 'a quotient', values: { a: '10', b: '4' }, expr: { '/': [A, B] }, value: '2.5' },
  {
    name: 'division by zero',
    values: { a: '10', b: '0' },
    expr: { '/': [A, B] },
    value: null,
    error: 'division_by_zero',
  },
  {
    name: 'zero over zero',
    values: { a: '0', b: '0' },
    expr: { '/': [A, B] },
    value: null,
    error: 'division_by_zero',
  },
  { name: 'a null divisor', values: { a: '10' }, expr: { '/': [A, B] }, value: null },
  { name: 'a null dividend', values: { b: '4' }, expr: { '/': [A, B] }, value: null },
  { name: 'a null operand of +', values: { a: '1' }, expr: { '+': [A, B] }, value: null },
  { name: 'a null operand of *', values: { b: '2' }, expr: { '*': [A, B] }, value: null },
  { name: 'a null operand of round', values: {}, expr: { round: [A, 2] }, value: null },
  { name: 'sum ignores a null operand', values: { a: '1' }, expr: { sum: [A, B] }, value: '1' },
];

describe('division by zero and null operands, in the editor, the authority and the service', () => {
  for (const c of CASES) {
    it(`gives one result for ${c.name}`, async () => {
      const env = documentOf(c.values, c.expr);
      const context = { roles: [] as string[] };

      // The rules package on the document, as the editor runs it.
      const editor = evaluateDocument(env, context);
      expect(editor.ok).toBe(true);
      if (!editor.ok) return;
      const state = editor.fields.find((f) => f.key === 'r')!;
      expect(state.value ?? null).toBe(c.value);
      expect(state.error).toBe(c.error);

      // The authority: the value its completion commit stores for the formula field.
      const node = cdmSchema().nodeFromJSON(env.doc);
      const writes = completionWrites(node, []);
      expect(writes.ok).toBe(true);
      if (writes.ok) {
        const w = writes.writes.find((x) => x.key === 'r');
        // The stored value is stale, so a write is made unless the result is the stale value.
        expect(w ? w.value : STALE).toBe(c.value);
        if (w) expect(w.reason).toBe('formula');
      }

      // The authority service, over a state it opened.
      const service = new AuthorityService();
      const hash = await documentHash(env);
      const opened = await service.open({
        doc: 'doc-frw-017',
        checkpointRef: { seq: 0, chainHead: null, contentHash: hash, content: env },
        commits: [],
        stateId: hash,
      });
      expect(opened.ok).toBe(true);
      const answer = await service.evaluateRules(hash, context);
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      // Identical to the package's own answer, field by field.
      expect(JSON.parse(JSON.stringify(answer.evaluation))).toEqual(
        JSON.parse(JSON.stringify(editor)),
      );
      const served = answer.evaluation.fields.find((f) => f.key === 'r')!;
      expect(served.value ?? null).toBe(c.value);
      expect(served.error).toBe(c.error);
    });
  }
});
