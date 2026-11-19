// FRW-020 criterion 2, the authority service part: every `rules` case of the published fixtures
// gives, through `AuthorityService.evaluateRules`, what `packages/rules` gives in process, in the
// whole shape of the fixture (the state of each field, its messages, the rule that decided it, the
// formula value or error, and the outcome of each rule), judged by `runFixtures` of the package. The
// same package runs the whole set in Node.js and in Chromium, Firefox and WebKit
// (`packages/rules/src/fixtures/fixtures.universal.test.ts`).
//
// Scope, as ADR 0340 (round 7, proposed, accepted by owner decisions 184 and 196 to 220) proposes:
// the service takes a document, so only the `rules` cases can be put to it. The 226 expression, 70
// pattern and 62 value cases have no call in 05 §10 and run in the package only. Test values only.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type JsonEnvelope, documentHash } from '@docedit/model';
import {
  type FixtureCase,
  type FixtureSet,
  type StateExpect,
  RULES_VERSION,
  runCase,
  runFixtures,
} from '@docedit/rules';
import { describe, expect, it } from 'vitest';
import { AuthorityService } from '../src/service.ts';
import { baseEnvelope } from './log.ts';

type J = Record<string, unknown>;

const FIXTURES = resolve(import.meta.dirname, '../../../spec/rules/rules-1.fixtures.json');
const set = JSON.parse(readFileSync(FIXTURES, 'utf8')) as FixtureSet;
const rulesCases = set.cases.filter((c) => c.kind === 'rules');
const positive = rulesCases.filter((c) => 'fields' in c.expect);
const negative = rulesCases.filter((c) => 'problems' in c.expect);

/** The case as a CDM document: its roles and rules in the definitions, its fields in the body. */
function documentOf(c: Extract<FixtureCase, { kind: 'rules' }>): JsonEnvelope {
  const env = baseEnvelope(['fields']);
  const root = env.doc as unknown as { content: Array<{ content: J[] }> };
  const defs = root.content[0]!.content;
  for (const role of c.given?.roleDefs ?? [])
    defs.push({ type: 'role_def', attrs: { id: role, name: role, color: '#000000' } });
  for (const rule of c.rules) defs.push({ type: 'rule_def', attrs: rule as J });
  const intro = root.content[1]!.content[0]!;
  const values = c.given?.values ?? {};
  const fields = (c.given?.fields ?? []).map((f, i) => ({
    type: 'form_field',
    attrs: {
      id: `fFx${String(i).padStart(13, '0')}`,
      key: f.key,
      kind: f.kind,
      label: f.key,
      assignee: null,
      value: values[f.key] ?? null,
      ...(f.options ? { options: f.options.map((o) => ({ id: o, label: o })) } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.readOnly ? { readOnly: true } : {}),
    },
  }));
  const content = (intro['content'] as J[] | undefined) ?? [];
  intro['content'] = [...content, ...fields.flatMap((f) => [{ type: 'text', text: ' ' }, f])];
  return env;
}

async function open(service: AuthorityService, env: JsonEnvelope) {
  const hash = await documentHash(env);
  const r = await service.open({
    doc: 'doc-frw-020',
    checkpointRef: { seq: 0, chainHead: null, contentHash: hash, content: env },
    commits: [],
    stateId: hash,
  });
  return { r, stateId: hash };
}

describe('the rules fixtures behind the authority service (FRW-020 criterion 2)', () => {
  it('splits the rules cases into the ones with field states and the ones with problems', () => {
    expect(rulesCases.length).toBe(positive.length + negative.length);
    expect(positive.length).toBe(31);
    expect(negative.length).toBe(37);
    expect(set.rules).toBe(RULES_VERSION);
  });

  it('gives, for every case with field states, the result of the fixture in its whole shape', async () => {
    const service = new AuthorityService();
    // The adapter runs a case behind the service and answers in the shape of the fixture's `expect`.
    const answers = new Map<string, unknown>();
    for (const c of positive) {
      if (c.kind !== 'rules') continue;
      const { r, stateId } = await open(service, documentOf(c));
      expect(r.ok, c.id).toBe(true);
      const answer = await service.evaluateRules(stateId, {
        roles: c.given?.roles ?? [],
        ...(c.given?.now ? { now: c.given.now } : {}),
      });
      expect(answer.ok, c.id).toBe(true);
      if (!answer.ok) continue;
      const fields: Record<string, StateExpect> = {};
      for (const s of answer.evaluation.fields) {
        const o: StateExpect = { visible: s.visible, enabled: s.enabled, required: s.required };
        if (s.messages.length) o.messages = s.messages;
        if ('value' in s) o.value = s.value ?? null;
        if (s.error !== undefined) o.error = s.error;
        const by = Object.fromEntries(Object.entries(s.by).filter(([, v]) => v !== undefined));
        if (Object.keys(by).length) o.by = by as NonNullable<StateExpect['by']>;
        fields[s.key] = o;
      }
      const rules: Record<string, string> = {};
      for (const x of answer.evaluation.rules)
        rules[x.id] = typeof x.outcome === 'string' ? x.outcome : `error:${x.outcome.error}`;
      answers.set(c.id, { fields, rules });
    }
    const report = runFixtures({ rules: set.rules, cases: positive }, (c) => answers.get(c.id));
    expect(report.failed.map((f) => f.id)).toEqual([]);
    expect(report.passed.length).toBe(positive.length);
    // The same cases in process give the same answers.
    for (const c of positive)
      expect(JSON.parse(JSON.stringify(answers.get(c.id))), c.id).toEqual(
        JSON.parse(JSON.stringify(runCase(c))),
      );
    // The case with an instant is among them: the service takes the instant of the request.
    expect(positive.some((c) => c.given?.now)).toBe(true);
  });

  it('refuses every case with problems, with the problems of the fixture when it opens', async () => {
    const service = new AuthorityService();
    let atOpen = 0;
    let atEvaluate = 0;
    for (const c of negative) {
      if (c.kind !== 'rules') continue;
      const { r, stateId } = await open(service, documentOf(c));
      if (!r.ok) {
        expect(r.error.code, c.id).toBe('validation_failed');
        atOpen++;
        continue;
      }
      const answer = await service.evaluateRules(stateId, { roles: c.given?.roles ?? [] });
      expect(answer, c.id).toMatchObject({ ok: false, error: { code: 'invalid_rules' } });
      if (answer.ok) continue;
      const got = (answer.error.detail as { problems: Array<{ code: string }> }).problems;
      // The service holds the rules in the nodes of a document, so its path is a path into the
      // document; the codes are the fixture's.
      const codes = (list: Array<{ code: string }>) => list.map((p) => p.code).sort();
      expect(codes(got), c.id).toEqual(
        codes((c.expect as { problems: Array<{ code: string }> }).problems),
      );
      atEvaluate++;
    }
    expect(atOpen + atEvaluate).toBe(negative.length);
    expect(atEvaluate).toBeGreaterThan(25);
  });
});
