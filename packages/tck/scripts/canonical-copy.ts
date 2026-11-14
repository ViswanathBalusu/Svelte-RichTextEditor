/**
 * The canonical-hash fixtures the kit ships (CDM-011; 03 §2; 05 §11): `packages/model/fixtures/canonical/`
 * becomes `packages/tck/fixtures/canonical/`, byte for byte, with the same layout (`index.json`,
 * `inputs/` and `expected/`). A backend in any language can run the cases from the kit alone, reading
 * JSON and bytes, as the rules fixtures allow (PRO-123). The model package generates the set; this
 * copy only carries it into the kit, so it is not formatted or changed in any way. The copy is written
 * by the kit's `generate` script, never by hand; its format is described in
 * `packages/tck/fixtures/canonical/README.md`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FixtureFile } from '../src/golden.ts';
import { modelFile } from '../src/fixtures.ts';

const SOURCE_DIR = fileURLToPath(modelFile('canonical/index.json'));
const SOURCE_ROOT = join(SOURCE_DIR, '..');

/** Every file of the model's canonical set, as paths relative to its root, sorted. */
export function canonicalSourceFiles(): string[] {
  const out: string[] = ['index.json'];
  for (const dir of ['inputs', 'expected']) {
    const abs = join(SOURCE_ROOT, dir);
    for (const name of readdirSync(abs).sort()) {
      if (statSync(join(abs, name)).isFile()) out.push(`${dir}/${name}`);
    }
  }
  return out;
}

/** Whether the model's canonical set is present in this checkout. */
export function canonicalSourcePresent(): boolean {
  return existsSync(SOURCE_DIR);
}

/** The kit's copies of the canonical fixtures, one file each, written byte for byte. */
export function canonicalCopies(): FixtureFile[] {
  if (!canonicalSourcePresent())
    throw new Error(
      'packages/model/fixtures/canonical is missing; run pnpm --filter @docedit/model generate',
    );
  return canonicalSourceFiles().map((rel) => {
    const source = join(SOURCE_ROOT, rel);
    const path = `fixtures/canonical/${rel}`;
    return { path, text: readFileSync(source, 'utf8') };
  });
}
