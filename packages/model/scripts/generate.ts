/**
 * Writes the generated artifacts of the model (CDM-006 to CDM-008, CDM-046, CDM-053):
 *   spec/cdm/cdm-1.schema.json, cdm-1.prosemirror.json, cdm-1.projection.json,
 *   cdm-1.attributes.md, cdm-1.writer-support.md, cdm-1.writer-support.json, cdm-1.violations.json,
 *   cdm-1.manifest.json, packages/model/src/generated/types.ts, and the canonical-form fixtures
 *   under packages/model/fixtures/canonical (CDM-011)
 * Run with `pnpm generate` (Node.js 22.18 or later runs this TypeScript file directly).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDM1 } from '../src/definition/cdm1.ts';
import { writerSupportProblems } from '../src/definition/writer-support.ts';
import { checkDefinition } from '../src/schema/check-definition.ts';
import { generateArtifacts } from '../src/schema/artifacts.ts';
import { writeCanonicalFixtures } from './canonical-fixtures.ts';
import { writeInvariantFixtures } from './invariant-fixtures.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const problems = [...checkDefinition(CDM1), ...writerSupportProblems(CDM1)];
if (problems.length) {
  console.error(`The definition is incomplete (${problems.length} problems):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

for (const a of await generateArtifacts(CDM1)) {
  const file = resolve(root, a.path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, a.text, 'utf8');
  console.log(`wrote ${a.path}`);
}

// The canonical-form fixtures (CDM-011); refuses a changed output under the same version.
const fixtures = resolve(root, 'packages/model/fixtures/canonical');
const written = await writeCanonicalFixtures(fixtures);
console.log(`wrote ${written.length} files under packages/model/fixtures/canonical`);

// The invariant fixtures (CDM-014).
const cases = await writeInvariantFixtures(resolve(root, 'packages/model/fixtures/invariants'));
console.log(`wrote ${cases} fixtures under packages/model/fixtures/invariants`);
