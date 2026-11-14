/**
 * Writes the generated artifacts of DEP (SPK-019; PRO-001 to PRO-003): spec/dep/* and
 * packages/protocol/src/generated/types.ts. Run with `pnpm --filter @docedit/protocol generate`
 * (Node.js 22.18 or later runs this TypeScript file directly).
 *
 * The CDM schema is read from spec/cdm, never copied: the DEP artifacts reference it and the
 * manifest records its hash (PRO-003).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEP1, checkDefinition } from '../src/definition/index.ts';
import { generateArtifacts } from '../src/generate/artifacts.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cdmPath = `spec/cdm/cdm-${DEP1.cdm.max}.schema.json`;

const problems = checkDefinition(DEP1);
if (problems.length) {
  console.error(`The DEP definition is inconsistent (${problems.length} problems):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const cdm = { path: cdmPath, text: await readFile(resolve(root, cdmPath), 'utf8') };
for (const a of await generateArtifacts(DEP1, cdm)) {
  const file = resolve(root, a.path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, a.text, 'utf8');
  console.log(`wrote ${a.path}`);
}
