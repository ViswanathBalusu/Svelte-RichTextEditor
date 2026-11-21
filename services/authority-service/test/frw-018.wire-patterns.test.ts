// FRW-018 criterion 3, the authority service part: the same pattern and input give the same result
// in the authority service as in the package in Node.js and in a browser, pinned by the published
// fixtures. The 70 `pattern` cases of spec/rules/rules-1.fixtures.json run in the package in Node.js
// and in Chromium, Firefox and WebKit (`packages/rules/src/fixtures/fixtures.universal.test.ts`).
// Here each of them is put to the authority service over its HTTP interface (05 §10).
//
// The service takes a document, not a pattern, so a case becomes a document with one rule whose
// condition is `matches` of the case's input and pattern: the rule shows a field when it holds and
// hides it otherwise, and the answer of `evaluateRules` says which. The input is given twice: as a
// literal of the rule, and as the value of a text field that the rule reads, which is how a pattern
// meets a value a person entered. A pattern the subset refuses makes a document the service does
// not open, or rules it does not evaluate, and the refusal names the code and the construct of the
// fixture.
//
// Targets as in frw-015.wire-fixtures.test.ts: the service in this process behind its HTTP binding,
// and, with DOCEDIT_AUTHORITY_CONTAINER=1, a container of its image, inside which the 70 cases also
// run unwrapped through the package's own runner. Test values only.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type FixtureSet,
  compilePattern,
  matchPattern,
  runCase,
  runFixtures,
} from '@docedit/rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PATTERN_INPUT,
  PATTERN_PROBE,
  type PatternCase,
  type Target,
  patternDocument,
  patternFieldDocument,
  targets,
} from './rules-wire.ts';

const root = resolve(import.meta.dirname, '../../..');
const set = JSON.parse(
  readFileSync(resolve(root, 'spec/rules/rules-1.fixtures.json'), 'utf8'),
) as FixtureSet;
const patternCases = set.cases.filter((c): c is PatternCase => c.kind === 'pattern');
const matching = patternCases.filter((c) => 'matches' in c.expect);
const refused = patternCases.filter((c) => 'problems' in c.expect);

interface Problem {
  code: string;
  construct?: string;
}

/** The pattern problems named anywhere in the detail of a refusal. */
function problemsIn(info: unknown): Problem[] {
  const out: Problem[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>;
      if (typeof o['code'] === 'string' && o['code'].startsWith('pattern_'))
        out.push({
          code: o['code'],
          ...(typeof o['construct'] === 'string' ? { construct: o['construct'] } : {}),
        });
      Object.values(o).forEach(visit);
    }
  };
  visit(info);
  return out;
}

for (const target of targets('frw-018-w4')) {
  describe(`the pattern fixtures through ${target.name} over HTTP (FRW-018 criterion 3)`, () => {
    let t: Target;
    beforeAll(async () => {
      t = await target.start();
    }, 900_000);
    afterAll(async () => {
      await t?.close();
    }, 120_000);

    it('reads the published pattern cases', () => {
      expect(patternCases.length).toBe(70);
      expect([matching.length, refused.length]).toEqual([40, 30]);
    });

    it('gives every pattern and input the result of the fixture, and of the package in process', async () => {
      const answers = new Map<string, unknown>();
      for (const c of matching) {
        const opened = await t.wire.open(patternDocument(c.pattern, c.input ?? ''));
        expect(opened.ok, `${c.id}: ${JSON.stringify(opened)}`).toBe(true);
        if (!opened.ok) continue;
        const answer = await t.wire.evaluate(opened.stateId, { roles: [] });
        expect(answer.ok, `${c.id}: ${JSON.stringify(answer)}`).toBe(true);
        if (!answer.ok) continue;
        const probe = answer.evaluation.fields.find((f) => f.key === PATTERN_PROBE)!;
        // The rule shows the probe when the pattern matches and hides it otherwise.
        answers.set(c.id, { matches: probe.visible });
        const rule = answer.evaluation.rules.find((r) => r.id === 'r_pattern')!;
        expect(rule.outcome, c.id).toBe(probe.visible ? 'then' : 'else');
      }
      // The same judge as in the browser and in Node.js: the package's runner over the cases.
      const report = runFixtures({ rules: set.rules, cases: matching }, (c) => answers.get(c.id));
      expect(report.failed.map((f) => f.id)).toEqual([]);
      expect(report.passed.length).toBe(matching.length);
      for (const c of matching) {
        // In process: the fixture runner, and the matcher itself.
        expect(answers.get(c.id), c.id).toEqual(runCase(c));
        const compiled = compilePattern(c.pattern);
        expect(compiled.ok, c.id).toBe(true);
        if (compiled.ok)
          expect(matchPattern(compiled.pattern, c.input ?? '').matched, c.id).toBe(
            (answers.get(c.id) as { matches: boolean }).matches,
          );
      }
      // Both verdicts occur, so the comparison is not of one constant.
      const verdicts = new Set(
        [...answers.values()].map((a) => (a as { matches: boolean }).matches),
      );
      expect([...verdicts].sort()).toEqual([false, true]);
    }, 300_000);

    it('gives the same result when the input is the value a person entered in a field', async () => {
      // The input as the stored value of a text field, which the rule reads with `{ field }`: the
      // way a pattern meets a value in a document. Every input of the fixtures is a value a text
      // field can hold.
      const answers = new Map<string, unknown>();
      for (const c of matching) {
        const opened = await t.wire.open(patternFieldDocument(c.pattern, c.input ?? ''));
        expect(opened.ok, `${c.id}: ${JSON.stringify(opened)}`).toBe(true);
        if (!opened.ok) continue;
        const answer = await t.wire.evaluate(opened.stateId, { roles: [] });
        expect(answer.ok, `${c.id}: ${JSON.stringify(answer)}`).toBe(true);
        if (!answer.ok) continue;
        answers.set(c.id, {
          matches: answer.evaluation.fields.find((f) => f.key === PATTERN_PROBE)!.visible,
        });
        // And for a value given with the call in place of the stored one (05 §10 `values`).
        const other = matching.find((x) => x.pattern === c.pattern && x.id !== c.id);
        if (other) {
          const given = await t.wire.evaluate(opened.stateId, {
            roles: [],
            values: { [PATTERN_INPUT]: other.input ?? '' },
          });
          expect(given.ok, other.id).toBe(true);
          if (given.ok)
            expect(
              { matches: given.evaluation.fields.find((f) => f.key === PATTERN_PROBE)!.visible },
              `${other.id} through the state of ${c.id}`,
            ).toEqual(runCase(other));
        }
      }
      const report = runFixtures({ rules: set.rules, cases: matching }, (c) => answers.get(c.id));
      expect(report.failed.map((f) => f.id)).toEqual([]);
      expect(report.passed.length).toBe(matching.length);
    }, 300_000);

    it('refuses every pattern outside the subset, with the code and the construct of the fixture', async () => {
      let atOpen = 0;
      let atEvaluate = 0;
      for (const c of refused) {
        const want = (c.expect as { problems: Problem[] }).problems.map((p) => ({
          code: p.code,
          ...(p.construct !== undefined ? { construct: p.construct } : {}),
        }));
        const opened = await t.wire.open(patternDocument(c.pattern, c.input ?? ''));
        let info: unknown;
        if (!opened.ok) {
          expect([opened.status, opened.code], c.id).toEqual([422, 'validation_failed']);
          info = opened.info;
          atOpen++;
        } else {
          const answer = await t.wire.evaluate(opened.stateId, { roles: [] });
          expect(answer.ok, c.id).toBe(false);
          if (answer.ok) continue;
          expect([answer.status, answer.code], c.id).toEqual([422, 'invalid_rules']);
          info = answer.info;
          atEvaluate++;
        }
        const got = problemsIn(info);
        // The refusal names the fixture's problem; the package in process names the same one.
        for (const p of want) expect(got, `${c.id}: ${JSON.stringify(info)}`).toContainEqual(p);
        const local = runCase(c) as { problems: Problem[] };
        expect(
          local.problems.map((p) => ({
            code: p.code,
            ...(p.construct !== undefined ? { construct: p.construct } : {}),
          })),
          c.id,
        ).toEqual(want);
      }
      expect(atOpen + atEvaluate).toBe(refused.length);
    }, 300_000);

    it.skipIf(target.name !== 'the service in a container')(
      'passes, in the image, all 70 pattern cases with the matcher of the package as the image holds it',
      async () => {
        // The cases themselves, not wrapped in a rule: the runner of the package inside the image,
        // in the Node.js of the image (the whole published set; the pattern cases are counted).
        const inImage = await t.fixturesInImage!();
        expect(inImage.failed).toEqual([]);
        expect(inImage.passedByKind['pattern']).toBe(patternCases.length);
        expect(inImage.node).toMatch(/^v22\.18\./);
      },
      120_000,
    );
  });
}
