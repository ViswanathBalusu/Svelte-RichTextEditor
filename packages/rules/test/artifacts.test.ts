// Published artifacts (FRW-015, FRW-020): spec/rules/ holds a fresh generation byte for byte; a
// published case never changes its expected result, or disappears, under the same rules version;
// and the JSON Schema of the language gives the shape verdicts of compileRules, in Ajv and, when
// it is installed, in Python's jsonschema.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { artifactBase, changedUnderSameVersion, generateArtifacts } from '../src/artifacts.ts';
import type { FixtureCase } from '../src/conformance.ts';
import { FIXTURES } from '../src/fixtures/index.ts';
import { generateRulesSchema } from '../src/schema.ts';
import { RULES_VERSION } from '../src/version.ts';

const root = resolve(import.meta.dirname, '../../..');
type Published = Parameters<typeof changedUnderSameVersion>[0];

/** Problem codes that are about shape alone, which the JSON Schema can see. */
const SHAPE = new Set([
  'bad_shape',
  'unknown_operator',
  'unknown_effect',
  'routing_effect',
  'wrong_arity',
  'number_literal',
  'duplicate_key',
]);

/** Every rule a fixture holds, as a rule_def's attributes, with the verdict expected on its shape. */
function shapes(): Array<{ id: string; rule: unknown; shapeOk: boolean }> {
  const out: Array<{ id: string; rule: unknown; shapeOk: boolean }> = [];
  const codes = (c: FixtureCase) =>
    'problems' in c.expect && c.kind !== 'value'
      ? (c.expect.problems as Array<{ code: string; path: string }>)
      : [];
  for (const c of FIXTURES.cases) {
    if (c.kind === 'expression')
      out.push({
        id: c.id,
        rule: { id: 'x', when: c.expression, then: [] },
        shapeOk: !codes(c).some((p) => SHAPE.has(p.code)),
      });
    if (c.kind === 'rules')
      c.rules.forEach((rule, i) =>
        out.push({
          id: `${c.id}#${i}`,
          rule,
          shapeOk: !codes(c).some(
            (p) => SHAPE.has(p.code) && (p.path === `/${i}` || p.path.startsWith(`/${i}/`)),
          ),
        }),
      );
  }
  return out;
}

describe('published artifacts', () => {
  it('match a fresh generation byte for byte', async () => {
    const files = await generateArtifacts();
    expect(files.map((f) => f.path)).toEqual([
      `${artifactBase()}.schema.json`,
      `${artifactBase()}.fixtures.json`,
      `${artifactBase()}.manifest.json`,
    ]);
    for (const a of files) {
      const file = resolve(root, a.path);
      expect(existsSync(file), `${a.path} is missing; run pnpm generate`).toBe(true);
      expect(readFileSync(file, 'utf8'), `${a.path} is stale; run pnpm generate`).toBe(a.text);
    }
  });

  it('name the rules version, and no published case changed under it', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, `${artifactBase()}.manifest.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest['rules']).toBe(RULES_VERSION);
    expect([manifest['profile'], manifest['feature']]).toEqual(['rules', 'rules']);
    const published = JSON.parse(
      readFileSync(resolve(root, `${artifactBase()}.fixtures.json`), 'utf8'),
    ) as Published;
    expect(published.rules).toBe(RULES_VERSION);
    expect(
      changedUnderSameVersion(published, JSON.parse(JSON.stringify(FIXTURES)) as Published),
    ).toEqual([]);
  });

  it('refuse a changed expectation or a dropped case unless the version changes', () => {
    const published = JSON.parse(JSON.stringify(FIXTURES)) as Published;
    const changed = structuredClone(published) as {
      rules: string;
      cases: Array<{ id: string; expect: unknown }>;
    };
    changed.cases[0]!.expect = { type: 'boolean', value: false };
    changed.cases.pop();
    const problems = changedUnderSameVersion(published, changed);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/expected result changed under rules\/1/);
    expect(problems[1]).toMatch(/removed under rules\/1/);
    // A new version may change anything; new cases may be added under the same version.
    expect(changedUnderSameVersion(published, { ...changed, rules: 'rules/2' })).toEqual([]);
    expect(
      changedUnderSameVersion(published, {
        ...published,
        cases: [...published.cases, { id: 'new', expect: {} }],
      }),
    ).toEqual([]);
  });

  it('publish the preset definitions with the fixtures (FRW-004)', () => {
    const published = JSON.parse(
      readFileSync(resolve(root, `${artifactBase()}.fixtures.json`), 'utf8'),
    ) as {
      presets: Record<string, string>;
    };
    expect(Object.keys(published.presets).sort()).toEqual(['email', 'phone', 'postcode']);
  });

  it('JSON Schema gives the shape verdicts of compileRules (Ajv)', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: false, unicodeRegExp: true });
    const check = ajv.compile(generateRulesSchema());
    const list = shapes();
    expect(list.length).toBeGreaterThan(250);
    for (const s of list)
      expect(check(s.rule), `${s.id}: ${JSON.stringify(check.errors?.[0])}`).toBe(s.shapeOk);
  });

  it('gives the same verdicts in Python jsonschema', (ctx) => {
    let python = '';
    for (const cmd of ['python', 'python3']) {
      try {
        execFileSync(cmd, ['-c', 'import jsonschema'], { stdio: 'ignore' });
        python = cmd;
        break;
      } catch {
        /* try the next one */
      }
    }
    if (!python) return ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), 'rules-schema-'));
    const schemaFile = join(dir, 'schema.json');
    const casesFile = join(dir, 'cases.json');
    writeFileSync(schemaFile, JSON.stringify(generateRulesSchema()));
    const list = shapes();
    writeFileSync(casesFile, JSON.stringify(list.map((s) => [s.id, s.rule])));
    const script = [
      'import json, sys',
      'from jsonschema import Draft202012Validator',
      'schema = json.load(open(sys.argv[1], encoding="utf-8"))',
      'cases = json.load(open(sys.argv[2], encoding="utf-8"))',
      'v = Draft202012Validator(schema)',
      'print(json.dumps({name: v.is_valid(doc) for name, doc in cases}))',
    ].join('\n');
    const out = JSON.parse(
      execFileSync(python, ['-I', '-c', script, schemaFile, casesFile], {
        encoding: 'utf8',
        maxBuffer: 1 << 24,
      }),
    ) as Record<string, boolean>;
    for (const s of list) expect(out[s.id], s.id).toBe(s.shapeOk);
    // Interpreter start-up alone can take tens of seconds on a loaded machine (`import jsonschema`
    // measured 16 s on a busy Windows host, 55 s for this test alone), and the test runs the
    // interpreter twice (probe and check). The budget covers both; the assertions are unchanged.
  }, 600_000);
});
