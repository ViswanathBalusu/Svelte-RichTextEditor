/**
 * Writes the authority's fixtures (run with `pnpm --filter @docedit/authority generate`):
 *   fixtures/engine/pm-steps-1.json and fixtures/engine/golden/*.json (SYN-002)
 *   fixtures/capabilities.json (PRM-004)
 *   spec/permissions/permissions-1.json (PRM-001, PRM-056)
 *
 * The engine fixtures are golden: once written for `pm-steps/1`, their outputs may change only
 * with the schema they were made against. If the installed releases differ from the pin, or an
 * output changes while the schema stays the same, this script refuses to write: a release that
 * changes any fixture is a new engine identifier (04 §4).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildCapabilityFixture } from './capability-fixtures.ts';
import { PERMISSIONS_ARTIFACT, buildPermissionsArtifact } from './permissions-artifact.ts';
import {
  buildEngineFiles,
  ENGINE_ID,
  installedVersion,
  PINNED,
  pretty,
  ROOT,
} from './engine-fixtures.ts';

const problems: string[] = [];
for (const name of Object.keys(PINNED) as Array<keyof typeof PINNED>) {
  const installed = installedVersion(name);
  if (installed !== PINNED[name])
    problems.push(
      `${ENGINE_ID} is pinned to ${name} ${PINNED[name]}, but ${installed} is installed. A release that changes step semantics needs a new engine identifier (04 §4).`,
    );
}

interface Golden {
  schema: { sha256: string };
  docs: unknown;
  cases: Array<{ id: string; expected: unknown }>;
}

const files = problems.length ? [] : await buildEngineFiles();
for (const f of files) {
  const file = resolve(ROOT, f.path);
  if (!f.path.includes('/golden/') || !existsSync(file)) continue;
  const before = JSON.parse(readFileSync(file, 'utf8')) as Golden;
  const after = JSON.parse(f.text) as Golden;
  if (before.schema.sha256 !== after.schema.sha256) continue; // a new schema: outputs may change
  if (JSON.stringify(before.docs) !== JSON.stringify(after.docs)) continue; // new input documents
  // The same inputs must give the same outputs; a case whose inputs changed is a new case.
  const split = (c: { expected: unknown }) => {
    const { expected, ...input } = c;
    return { input: JSON.stringify(input), expected: JSON.stringify(expected) };
  };
  const old = new Map(before.cases.map((c) => [c.id, split(c)]));
  for (const c of after.cases) {
    const was = old.get(c.id);
    const now = split(c);
    if (was && was.input === now.input && was.expected !== now.expected)
      problems.push(
        `${f.path}: the output of ${c.id} changed under ${ENGINE_ID} and the same schema`,
      );
  }
}
if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}

files.push({
  path: 'packages/authority/fixtures/capabilities.json',
  text: await pretty(buildCapabilityFixture()),
});
files.push({ path: PERMISSIONS_ARTIFACT, text: await pretty(buildPermissionsArtifact()) });
for (const f of files) {
  const file = resolve(ROOT, f.path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, f.text, 'utf8');
  console.log(`wrote ${f.path}`);
}
