// Rules over CDM documents (FRW-015, FRW-019; 12 §3.6): reading fields, roles and rules from the
// JSON form, the rule halves of I14 and I15 with paths into the document, evaluateRules on a
// document, and evaluation time at the limits of 2,000 fields and 500 rules (targets).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JsonValue } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import {
  checkRuleInvariants,
  compileDocument,
  evaluateDocument,
  readDocument,
} from '../src/document.ts';
import { evaluateRules } from '../src/evaluate.ts';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string): J => JSON.parse(readFileSync(resolve(root, path), 'utf8')) as J;
const example = read('packages/model/fixtures/example-03-12.json');

/** The example of 03 §12 with fields, roles and rules added. */
function document(fields: J[], rules: J[], roles = ['role_tenant']): J {
  const d = structuredClone(example);
  d['requires'] = ['fields'];
  const defs = d['doc'].content[0].content as J[];
  for (const id of roles)
    defs.push({ type: 'role_def', attrs: { id, name: id, color: '#1F77B4' } });
  for (const r of rules) defs.push({ type: 'rule_def', attrs: r });
  d['doc'].content[1].content[2].content = fields.map((attrs, i) => ({
    type: 'form_field',
    attrs: { id: `fField${String(i).padStart(10, '0')}`, label: attrs['key'], ...attrs },
  }));
  return d;
}

describe('documents', () => {
  it('reads the corpus form and evaluates its rule (12 §5.1 shape)', () => {
    const form = read('packages/corpus/out/form-fields.cdm.json');
    const d = readDocument(form);
    expect(d.fields.length).toBe(13);
    expect(d.roles.length).toBe(2);
    expect(d.rules.length).toBe(1);
    expect(d.rules[0]!.path).toMatch(/^\/doc\/content\/0\/content\/\d+\/attrs$/);
    const c = compileDocument(form);
    expect(c.ok, JSON.stringify(!c.ok && c.problems)).toBe(true);
    const state = (agent: boolean) => {
      const ev = evaluateDocument(
        form,
        { roles: [] },
        { values: { 'order.agentInvolved': agent }, keys: ['agent.name'] },
      );
      if (!ev.ok) throw new Error(JSON.stringify(ev));
      return ev.fields[0]!;
    };
    expect(state(true)).toMatchObject({ key: 'agent.name', visible: true, required: true });
    expect(state(false)).toMatchObject({ key: 'agent.name', visible: false, required: false });
    expect(state(true).id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('gives the rule halves of I14 and I15 with paths into the document', () => {
    const fields = [
      { key: 'a', kind: 'number' },
      { key: 'A', kind: 'formula' },
      { key: 'B', kind: 'formula' },
    ];
    const valid = document(fields, [
      {
        id: 'r1',
        when: true,
        then: [{ set: { field: 'A', value: { '+': [{ field: 'a' }, '1'] } } }],
      },
    ]);
    expect(validate(valid).valid).toBe(true);
    expect(checkRuleInvariants(valid)).toEqual([]);

    const missing = document(fields, [
      { id: 'r1', when: { '==': [{ field: 'nope' }, '1'] }, then: [] },
    ]);
    expect(checkRuleInvariants(missing)).toEqual([
      expect.objectContaining({
        invariant: 'I14',
        path: '/doc/content/0/content/5/attrs/when/==/0',
        keys: ['nope'],
      }),
    ]);

    const cycle = document(fields, [
      { id: 'r1', when: true, then: [{ set: { field: 'A', value: { field: 'B' } } }] },
      { id: 'r2', when: true, then: [{ set: { field: 'B', value: { field: 'A' } } }] },
    ]);
    expect(checkRuleInvariants(cycle)).toEqual([
      expect.objectContaining({
        invariant: 'I14',
        path: '/doc/content/0/content/5/attrs',
        keys: ['A', 'B'],
      }),
    ]);

    const many = Array.from({ length: 501 }, (_, i) => ({ id: `r${i}`, when: true, then: [] }));
    expect(checkRuleInvariants(document(fields, many.slice(0, 500)))).toEqual([]);
    expect(checkRuleInvariants(document(fields, many))).toEqual([
      expect.objectContaining({ invariant: 'I15' }),
    ]);

    // A shape or type problem is not an invariant: the send checklist refuses it (FRW-027).
    expect(checkRuleInvariants(document(fields, [{ id: 'r1', when: 'yes', then: [] }]))).toEqual(
      [],
    );
    expect(compileDocument(document(fields, [{ id: 'r1', when: 'yes', then: [] }])).ok).toBe(false);
  });

  it('refuses to evaluate a document whose rules are invalid, naming the problems', () => {
    const d = document(
      [{ key: 'x', kind: 'text' }],
      [{ id: 'r1', when: true, then: [{ addParticipant: { role: 'x' } }] }],
    );
    const ev = evaluateDocument(d, { roles: [] });
    expect(ev).toMatchObject({
      ok: false,
      code: 'invalid_rules',
      problems: [{ code: 'routing_effect' }],
    });
  });

  it('evaluates 500 rules over 2,000 fields well inside a commit (measured)', () => {
    // 1,000 choice and text pairs, 400 number fields and 200 formulas, 100 dates and 300 more text
    // fields; 250 visibility rules, 150 formula rules, 50 validate rules with patterns on text,
    // 50 require rules over dates.
    const fields: J[] = [];
    const rules: J[] = [];
    for (let i = 0; i < 500; i++) {
      fields.push({
        key: `s${i}`,
        kind: 'choice',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      });
      fields.push({ key: `t${i}`, kind: 'text' });
    }
    for (let i = 0; i < 400; i++) fields.push({ key: `n${i}`, kind: 'number' });
    for (let i = 0; i < 200; i++) fields.push({ key: `f${i}`, kind: 'formula' });
    for (let i = 0; i < 100; i++) fields.push({ key: `d${i}`, kind: 'date' });
    for (let i = 500; i < 800; i++) fields.push({ key: `t${i}`, kind: 'text' });
    expect(fields.length).toBe(2000);
    for (let i = 0; i < 250; i++)
      rules.push({
        id: `v${i}`,
        when: {
          and: [
            { '==': [{ field: `s${i}` }, 'yes'] },
            { not: [{ empty: [{ field: `t${i + 250}` }] }] },
          ],
        },
        then: [{ show: [`t${i}`] }, { require: [`t${i}`] }],
        else: [{ hide: [`t${i}`] }],
      });
    for (let i = 0; i < 150; i++)
      rules.push({
        id: `m${i}`,
        when: { '>': [{ field: `n${i}` }, '0'] },
        then: [
          {
            set: {
              field: `f${i}`,
              value: {
                round: [
                  {
                    '*': [
                      {
                        sum: [
                          { field: `n${i}` },
                          { field: `n${i + 150}` },
                          i > 0 ? { field: `f${i - 1}` } : '0',
                        ],
                      },
                      '1.19',
                    ],
                  },
                  2,
                ],
              },
            },
          },
        ],
      });
    for (let i = 0; i < 50; i++)
      rules.push({
        id: `p${i}`,
        when: { matches: [{ field: `t${500 + i}` }, '[A-Z]{2}[0-9]{2}(?:[ -]?[0-9A-Z]{4}){3,7}'] },
        then: [],
        else: [{ validate: { fields: [`t${500 + i}`], message: 'Enter an account number.' } }],
      });
    for (let i = 0; i < 50; i++)
      rules.push({
        id: `q${i}`,
        when: { '>': [{ now: 'date' }, { field: `d${i}` }] },
        then: [{ require: [`t${600 + i}`] }],
      });
    expect(rules.length).toBe(500);
    const d = document(fields, rules, []);
    const values: Record<string, JsonValue> = {};
    for (let i = 0; i < 500; i++) values[`s${i}`] = i % 2 ? 'yes' : 'no';
    for (let i = 0; i < 800; i++)
      values[`t${i}`] =
        i >= 500 && i < 550
          ? 'DE44 5001 0517 5407 3249 31'.repeat(100).slice(0, 4000)
          : `text ${i}`;
    for (let i = 0; i < 400; i++) values[`n${i}`] = `${i}.25`;
    for (let i = 0; i < 100; i++) values[`d${i}`] = '2026-01-01';
    const context = {
      roles: [],
      now: { instant: '2026-11-06T09:00:00.000Z', timeZone: 'Europe/Berlin' },
    };

    const time = (f: () => void, runs = 7) => {
      const t: number[] = [];
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        f();
        t.push(performance.now() - t0);
      }
      return t.sort((a, b) => a - b)[runs >> 1]!;
    };
    let compiled = compileDocument(d);
    const compileMs = time(() => (compiled = compileDocument(d)));
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.problems.slice(0, 3))).toBe(true);
    if (!compiled.ok) return;
    const rs = compiled.ruleSet;
    let full = evaluateRules(rs, values, context);
    const fullMs = time(() => (full = evaluateRules(rs, values, context)));
    const oneMs = time(() => evaluateRules(rs, values, context, { keys: ['t1'] }), 25);
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    console.log(
      `2,000 fields, 500 rules (Node.js ${process.version}, ${process.platform}; median of 7 runs): ` +
        `read and compile ${compileMs.toFixed(1)} ms, evaluate all ${fullMs.toFixed(1)} ms in ${full.steps} steps ` +
        `(bound ${rs.maxSteps}), evaluate for one field ${oneMs.toFixed(2)} ms`,
    );
    // Generous bounds: the measurement is what counts; these only catch a change of growth.
    expect(fullMs).toBeLessThan(1000);
    expect(oneMs).toBeLessThan(50);
    const visible = full.fields.filter(
      (s) => s.key.startsWith('t') && Number(s.key.slice(1)) < 250 && s.visible,
    );
    expect(visible.length).toBe(125);
    expect(full.fields.find((s) => s.key === 'f149')!.value).toMatch(/^\d+(?:\.\d{1,2})?$/);
  });
});
