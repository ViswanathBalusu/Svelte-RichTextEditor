/** The fixture files as they are written: the generated JSON in the repository's Prettier format. */
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { fixtureFiles, type FixtureFile } from '../src/golden.ts';

export async function formatted(): Promise<FixtureFile[]> {
  const out: FixtureFile[] = [];
  for (const f of fixtureFiles()) {
    const options = (await resolveConfig(join(import.meta.dirname, '..', f.path))) ?? {};
    out.push({ path: f.path, text: await format(f.text, { ...options, parser: 'json' }) });
  }
  return out;
}
