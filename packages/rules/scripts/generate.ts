/**
 * Writes the published artifacts of the rules package (FRW-020), run with `pnpm generate`:
 *   spec/rules/rules-1.schema.json, rules-1.fixtures.json, rules-1.manifest.json
 *
 * The fixtures are golden. Before writing, the script checks that every case runs as expected,
 * and it refuses to change the expected result of a published case, or to drop one, under the
 * same rules version: such a change needs a new version identifier (src/version.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedUnderSameVersion, generateArtifacts } from '../src/artifacts.ts';
import { runFixtures } from '../src/conformance.ts';
import { FIXTURES } from '../src/fixtures/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const problems: string[] = [];

const report = runFixtures(FIXTURES);
for (const f of report.failed)
  problems.push(`${f.id}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);

const files = await generateArtifacts();
const fixtures = files.find((f) => f.path.endsWith('.fixtures.json'))!;
const target = resolve(root, fixtures.path);
if (existsSync(target)) {
  const published = JSON.parse(readFileSync(target, 'utf8')) as Parameters<
    typeof changedUnderSameVersion
  >[0];
  problems.push(
    ...changedUnderSameVersion(published, JSON.parse(fixtures.text) as typeof published),
  );
}

if (problems.length) {
  console.error(`Not written (${problems.length} problems):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
for (const a of files) {
  const file = resolve(root, a.path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, a.text, 'utf8');
  console.log(`wrote ${a.path}`);
}
