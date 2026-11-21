// FRW-015 criterion 4: one rules package, imported by the editor, by the Node.js authority and by
// the authority service, passes the same tests in each, and it exposes the call the service lists
// as `evaluateRules`.
//
// - One package. The editing core, the authority and the authority service each name
//   `@docedit/rules` as a workspace dependency, and each resolves it to the same file: there is no
//   copy and no second build (the package has no build step: its `exports` are its sources). In
//   the service's container image the files of the package are the files here, byte for byte (the
//   container target, below).
// - The same tests. The published fixtures are the tests: `runFixtures` of the package judges an
//   answer in the whole shape of a case, and `packages/rules/src/fixtures/fixtures.universal.test.ts`
//   asserts that every case passes, in Node.js and in the three browser engines. In the container
//   target the same runner goes over the same set inside the image, in the Node.js of the image.
//   Here the `rules` cases are also put to the authority service over its HTTP interface (05 §10
//   `evaluateRules`), and every answer is the one the package gives in process. The editor's part
//   is `packages/engine/src/frw-015-rules-fixtures.universal.test.ts` (Node.js and the three
//   browser engines), the authority's is `packages/authority/test/frw-020.fixtures.test.ts`.
// - The call. The package exports `evaluateRules`, and `evaluateDocument` for a whole document;
//   the service lists `evaluateRules` among its calls and answers it with the package's result.
//
// Targets: the service in this process behind its own HTTP binding, always; and, with
// DOCEDIT_AUTHORITY_CONTAINER=1, a container built from the service's Containerfile and started
// with the options of its compose file (Podman; a container name and an image tag ending in w4;
// the container is removed afterwards, the image is kept for the next run).
// Scope as for FRW-020 (ADR 0340, accepted): the service takes a document, so over HTTP the `rules`
// cases are the ones it can be asked; the other cases run in the image through the runner. Test
// values only.
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  type FixtureSet,
  RULES_VERSION,
  compileDocument,
  evaluateDocument,
  evaluateRules,
  runCase,
  runFixtures,
} from '@docedit/rules';
import { FIXTURES } from '@docedit/rules/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMPLEMENTED_CALLS } from '../src/capabilities.ts';
import {
  type RulesCase,
  type Target,
  answerOf,
  localPackageHashes,
  rulesDocument,
  targets,
} from './rules-wire.ts';

const root = resolve(import.meta.dirname, '../../..');
const set = JSON.parse(
  readFileSync(resolve(root, 'spec/rules/rules-1.fixtures.json'), 'utf8'),
) as FixtureSet;
const rulesCases = set.cases.filter((c): c is RulesCase => c.kind === 'rules');
const positive = rulesCases.filter((c) => 'fields' in c.expect);
const negative = rulesCases.filter((c) => 'problems' in c.expect);

describe('one rules package for the editor, the authority and the authority service (FRW-015 criterion 4)', () => {
  const consumers = ['packages/engine', 'packages/authority', 'services/authority-service'];

  it('is a workspace dependency of each, resolved to the same file', () => {
    const resolved = consumers.map((dir) => {
      const manifest = resolve(root, dir, 'package.json');
      const deps = (
        JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies: Record<string, string> }
      ).dependencies;
      expect(deps['@docedit/rules'], `${dir} depends on the workspace package`).toBe('workspace:*');
      return realpathSync(createRequire(manifest).resolve('@docedit/rules'));
    });
    const source = realpathSync(resolve(root, 'packages/rules/src/index.ts'));
    for (const [i, file] of resolved.entries()) expect(file, consumers[i]).toBe(source);
  });

  it('exposes evaluateRules, and the service lists the call by that name', () => {
    expect(typeof evaluateRules).toBe('function');
    expect(typeof evaluateDocument).toBe('function');
    expect(IMPLEMENTED_CALLS).toContain('evaluateRules');
    // 05 section 10 names the call.
    const spec = readFileSync(resolve(root, 'docs/spec/05-protocol.md'), 'utf8');
    expect(spec).toContain('`evaluateRules`');
  });
});

for (const target of targets('frw-015-w4')) {
  describe(`the rules fixtures through ${target.name} over HTTP (FRW-015 criterion 4)`, () => {
    let t: Target;
    beforeAll(async () => {
      t = await target.start();
    }, 900_000);
    afterAll(async () => {
      await t?.close();
    }, 120_000);

    it('lists evaluateRules among the calls it serves', async () => {
      expect(await t.wire.calls()).toContain('evaluateRules');
    });

    it('gives every case with field states the result of the fixture, and of the package in process', async () => {
      const answers = new Map<string, unknown>();
      for (const c of positive) {
        const opened = await t.wire.open(rulesDocument(c));
        expect(opened.ok, `${c.id}: ${JSON.stringify(opened)}`).toBe(true);
        if (!opened.ok) continue;
        const answer = await t.wire.evaluate(opened.stateId, {
          roles: c.given?.roles ?? [],
          ...(c.given?.now ? { now: c.given.now } : {}),
        });
        expect(answer.ok, `${c.id}: ${JSON.stringify(answer)}`).toBe(true);
        if (answer.ok) answers.set(c.id, answerOf(answer.evaluation));
      }
      // The same judge as everywhere else: the package's runner over the published cases.
      const report = runFixtures({ rules: set.rules, cases: positive }, (c) => answers.get(c.id));
      expect(report.failed.map((f) => f.id)).toEqual([]);
      expect(report.passed.length).toBe(positive.length);
      expect(report.rules).toBe(RULES_VERSION);
      // And the answer over the wire is the package's answer in this process, member for member.
      for (const c of positive)
        expect(JSON.parse(JSON.stringify(answers.get(c.id))), c.id).toEqual(
          JSON.parse(JSON.stringify(runCase(c))),
        );
      expect(positive.length).toBe(31);
    }, 300_000);

    it('refuses every case with problems, with the codes of the fixture', async () => {
      let atOpen = 0;
      let atEvaluate = 0;
      for (const c of negative) {
        const opened = await t.wire.open(rulesDocument(c));
        if (!opened.ok) {
          expect([opened.status, opened.code], c.id).toEqual([422, 'validation_failed']);
          atOpen++;
          continue;
        }
        const answer = await t.wire.evaluate(opened.stateId, { roles: c.given?.roles ?? [] });
        expect(answer.ok, c.id).toBe(false);
        if (answer.ok) continue;
        expect([answer.status, answer.code], c.id).toEqual([422, 'invalid_rules']);
        const codes = (list: Array<{ code: string }>) => list.map((p) => p.code).sort();
        expect(
          codes((answer.info as { problems: Array<{ code: string }> }).problems),
          c.id,
        ).toEqual(codes((c.expect as { problems: Array<{ code: string }> }).problems));
        atEvaluate++;
      }
      expect(atOpen + atEvaluate).toBe(negative.length);
      expect(negative.length).toBe(37);
      expect(atEvaluate).toBeGreaterThan(25);
    }, 300_000);

    it('passes the options of the call through to the package: values, keys and the instant', async () => {
      // One case with fields and rules is enough to show that the service adds nothing of its own.
      const c = positive.find((x) => (x.given?.fields?.length ?? 0) >= 2 && !x.given?.now)!;
      const envelope = rulesDocument(c);
      const opened = await t.wire.open(envelope);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const key = c.given!.fields![0]!.key;
      const request = { roles: c.given?.roles ?? [], keys: [key] };
      const answer = await t.wire.evaluate(opened.stateId, request);
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      const local = evaluateDocument(envelope, { roles: request.roles }, { keys: request.keys });
      expect(JSON.parse(JSON.stringify(answer.evaluation))).toEqual(
        JSON.parse(JSON.stringify(local)),
      );
      expect(answer.evaluation.fields.map((f) => f.key)).toEqual([key]);
      // The call the service lists is the package's `evaluateRules`: on the rules and the values of
      // the same document it gives the answer of the wire, member for member.
      const compiled = compileDocument(envelope);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      const direct = evaluateRules(
        compiled.ruleSet,
        compiled.document.values,
        { roles: request.roles },
        { keys: request.keys },
      );
      expect(JSON.parse(JSON.stringify(answer.evaluation))).toEqual(
        JSON.parse(JSON.stringify(direct)),
      );
    });

    it.skipIf(target.name !== 'the service in a container')(
      'passes, in the image, every published case with the runner of the package (the same tests)',
      async () => {
        // What `packages/rules/src/fixtures/fixtures.universal.test.ts` asserts in Node.js and in
        // the three browser engines, asserted of the package as the image holds it, in the Node.js
        // of the image, found from the service's own directory.
        const inImage = await t.fixturesInImage!();
        expect(inImage.failed).toEqual([]);
        expect(inImage.passed).toBe(inImage.cases);
        // The set in the image is the published one, of this rules version.
        expect(inImage.cases).toBe(set.cases.length);
        expect(inImage.cases).toBe(FIXTURES.cases.length);
        expect(inImage.rules).toBe(RULES_VERSION);
        expect(inImage.resolved).toBe('file:///app/packages/rules/src/index.ts');
        expect(inImage.node).toMatch(/^v22\.18\./);
        // The same runner over the same set in this process: the same counts.
        const here = runFixtures(FIXTURES, runCase);
        expect(here.failed.map((f) => f.id)).toEqual([]);
        expect(here.passed.length).toBe(inImage.passed);
      },
      120_000,
    );

    it.skipIf(target.name !== 'the service in a container')(
      'holds, in the image, the files of the package as they are here',
      async () => {
        const inImage = await t.packageHashes!();
        const here = localPackageHashes();
        expect(inImage.size).toBeGreaterThan(10);
        // Every file of the package in the image is the file here; the image holds no other.
        for (const [path, hash] of inImage) expect(here.get(path), path).toBe(hash);
        // And what the image leaves out is not source the service runs.
        for (const path of here.keys())
          if (!inImage.has(path)) expect(path, 'left out of the image').toMatch(/\.test\.ts$/);
      },
      120_000,
    );
  });
}
