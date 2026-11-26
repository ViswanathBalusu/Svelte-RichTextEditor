/**
 * SEC-060 criteria 3 to 5: the build fails when an authorisation row has no negative test, or an
 * error code has no test that provokes it (10 §5; 07 §12; 05 §5.8).
 *
 * Where the evidence comes from:
 *
 * - A row has a negative test when the `authz` profile of the kit has a scenario for it that
 *   declares what it exercises (a scenario with an empty `covers` is the placeholder of a row
 *   whose routes are not served), or when a test in the repository carries the tag
 *   `[neg:row <id>]` in its title.
 * - A code is provoked when a scenario of any profile declares it in `covers.errors` and is not the
 *   registry profile's skipped entry. The registry profile checks the code, the surface, the retry
 *   hint and the `sync.reject` action against the registry for each such provocation. A code the
 *   kit cannot provoke from outside carries a reason in `PROVOKED` (criterion 4) and a test in the
 *   repository tagged `[neg:code <code>]`: a fault hook or a unit test.
 * - Criterion 5: a code of a profile that has landed (`fields`, `workflow`) must be provoked by the
 *   kit; the tagged fallback is accepted only while the profile has no scenario.
 *
 * Tags sit in the title of an `it` or `describe`, so the test that carries one is the test the
 * check names.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATRIX } from '@docedit/authority';
import { DEP1 } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/profiles/index.ts';
import { PROVOKED } from '../src/profiles/registry.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SELF = 'packages/tck/test/sec-060-negative-coverage.test.ts';
const SKIP = new Set(['node_modules', 'dist', 'out', '.git', '.worktrees', 'coverage']);

/** The profiles whose codes the kit must provoke as soon as the profile has scenarios. */
const LATER_PROFILE: Readonly<Record<string, string>> = {
  field_invalid: 'fields',
  conflict: 'fields',
  workflow_active: 'workflow',
};

interface Tag {
  kind: 'row' | 'code';
  id: string;
  file: string;
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) testFiles(path, out);
    else if (name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const TAG = /\[neg:(row|code) ([A-Za-z0-9_.]+)\]/g;

export function scanTags(texts: ReadonlyArray<{ file: string; text: string }>): Tag[] {
  const tags: Tag[] = [];
  for (const { file, text } of texts)
    for (const m of text.matchAll(TAG)) tags.push({ kind: m[1] as Tag['kind'], id: m[2]!, file });
  return tags;
}

interface Evidence {
  rowIds: readonly string[];
  codes: readonly string[];
  /** Rows with a declared scenario in the authz profile. */
  rowScenarios: ReadonlySet<string>;
  /** Codes some scenario provokes. */
  provokedCodes: ReadonlySet<string>;
  /** Codes the kit names as unprovokable, with the reason. */
  unprovokable: ReadonlyMap<string, string>;
  /** Profiles that have scenarios. */
  landedProfiles: ReadonlySet<string>;
  tags: readonly Tag[];
}

/** What is missing: one line for each failure. Empty when the build may pass. */
export function negativeCoverageFailures(e: Evidence): string[] {
  const out: string[] = [];
  const has = (kind: Tag['kind'], id: string) => e.tags.some((t) => t.kind === kind && t.id === id);
  for (const t of e.tags) {
    if (t.kind === 'row' && !e.rowIds.includes(t.id))
      out.push(`${t.file}: the tag names a row that is not in the matrix: ${t.id}`);
    if (t.kind === 'code' && !e.codes.includes(t.id))
      out.push(`${t.file}: the tag names a code that is not in the registry: ${t.id}`);
  }
  for (const id of e.rowIds)
    if (!e.rowScenarios.has(id) && !has('row', id))
      out.push(`row ${id} has no negative test: add a scenario or a test titled [neg:row ${id}]`);
  for (const code of e.codes) {
    if (e.provokedCodes.has(code)) continue;
    const later = LATER_PROFILE[code];
    if (later && e.landedProfiles.has(later)) {
      out.push(`code ${code} belongs to the ${later} profile, which has landed: provoke it there`);
      continue;
    }
    if (!e.unprovokable.has(code)) {
      out.push(`code ${code} is not provoked by any scenario and has no reason in PROVOKED`);
      continue;
    }
    if (!has('code', code))
      out.push(
        `code ${code} cannot be provoked from outside (${e.unprovokable.get(code)}) and has no test titled [neg:code ${code}]`,
      );
  }
  return out;
}

function evidence(): Evidence {
  const texts = [...['packages', 'services', 'tests', 'apps']]
    .flatMap((d) => {
      try {
        return testFiles(join(ROOT, d));
      } catch {
        return [];
      }
    })
    .map((p) => ({
      file: relative(ROOT, p).split(sep).join('/'),
      text: readFileSync(p, 'utf8'),
    }))
    .filter((t) => t.file !== SELF);

  const authz = PROFILES.find((p) => p.id === 'authz')!;
  const rowScenarios = new Set(
    authz.scenarios
      .filter((s) => Object.values(s.covers).some((v) => (v?.length ?? 0) > 0))
      .map((s) => s.id.replace(/^authz\./, '')),
  );
  const provokedCodes = new Set<string>();
  for (const p of PROFILES)
    for (const s of p.scenarios) for (const c of s.covers.errors ?? []) provokedCodes.add(c);
  const reachable = new Set(PROVOKED.filter((p) => !p.unreachable).map((p) => p.code));
  for (const c of reachable) provokedCodes.add(c);

  const unprovokable = new Map<string, string>();
  for (const p of PROVOKED)
    if (p.unreachable && !unprovokable.has(p.code)) unprovokable.set(p.code, p.unreachable);

  return {
    rowIds: MATRIX.map((r) => r.id),
    codes: DEP1.errors.map((e) => e.code),
    rowScenarios,
    provokedCodes,
    unprovokable,
    landedProfiles: new Set(PROFILES.filter((p) => p.scenarios.length > 0).map((p) => p.id)),
    tags: scanTags(texts),
  };
}

describe('SEC-060 every authorisation row and every error code has a negative test', () => {
  const e = evidence();

  it('passes for the repository as it is (criteria 3 to 5)', () => {
    expect(negativeCoverageFailures(e)).toEqual([]);
  });

  it('knows the matrix and the registry it checks', () => {
    expect(e.rowIds.length).toBe(13);
    expect(e.codes.length).toBeGreaterThanOrEqual(32);
  });

  it('fails a row that has no negative test', () => {
    const mutated: Evidence = {
      ...e,
      rowIds: [...e.rowIds, 'new.operation'],
    };
    expect(negativeCoverageFailures(mutated)).toEqual([
      'row new.operation has no negative test: add a scenario or a test titled [neg:row new.operation]',
    ]);
    // A tag in a test title is enough.
    const tag = (kind: 'row' | 'code', id: string) => `[neg:${kind} ${id}]`;
    const tagged = scanTags([
      { file: 'x.test.ts', text: `it('refuses ${tag('row', 'new.operation')}')` },
    ]);
    expect(negativeCoverageFailures({ ...mutated, tags: [...e.tags, ...tagged] })).toEqual([]);
  });

  it('fails a code that no scenario provokes and that has no reason', () => {
    const mutated: Evidence = { ...e, codes: [...e.codes, 'new_code'] };
    expect(negativeCoverageFailures(mutated)).toEqual([
      'code new_code is not provoked by any scenario and has no reason in PROVOKED',
    ]);
  });

  it('fails a code that cannot be provoked from outside and has no unit or fault-hook test', () => {
    const untagged = e.tags.filter((t) => !(t.kind === 'code' && t.id === 'internal'));
    const failures = negativeCoverageFailures({ ...e, tags: untagged });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(
      /^code internal cannot be provoked from outside \(.+\) and has no test titled /,
    );
  });

  it('fails a tag that names a row or a code that does not exist', () => {
    const tag = (kind: 'row' | 'code', id: string) => `[neg:${kind} ${id}]`;
    const stray = scanTags([
      { file: 'a.test.ts', text: tag('row', 'no.such.row') },
      { file: 'b.test.ts', text: tag('code', 'no_such_code') },
    ]);
    expect(negativeCoverageFailures({ ...e, tags: [...e.tags, ...stray] })).toEqual([
      'a.test.ts: the tag names a row that is not in the matrix: no.such.row',
      'b.test.ts: the tag names a code that is not in the registry: no_such_code',
    ]);
  });

  it('keeps the codes of a profile that has landed out of the tagged fallback (criterion 5)', () => {
    // No workflow profile has scenarios, but the registry profile provokes workflow_active itself
    // (PRO-115 criterion 3), so the code counts as provoked and the tag is not needed.
    expect(e.landedProfiles.has('workflow')).toBe(false);
    expect(e.provokedCodes.has('workflow_active')).toBe(true);
    // When the profile lands, the code is still provoked, so nothing is missing.
    expect(
      negativeCoverageFailures({
        ...e,
        landedProfiles: new Set([...e.landedProfiles, 'workflow']),
      }),
    ).toEqual([]);
    // field_invalid and conflict belong to the fields profile, which has landed, and the kit
    // provokes both.
    expect(e.landedProfiles.has('fields')).toBe(true);
    expect(e.provokedCodes.has('field_invalid')).toBe(true);
    expect(e.provokedCodes.has('conflict')).toBe(true);
  });
});
