/**
 * `pnpm --filter @docedit/tck generate`: writes the kit's golden message fixtures (PRO-110) from the
 * protocol definition, formatted as the repository's Prettier settings format JSON. The files are
 * generated, never edited by hand; a test checks that they equal a fresh generation.
 *
 * It also copies the published rules fixtures from `spec/rules/` into `fixtures/rules/` (PRO-123),
 * unchanged; a test checks that the copy equals a fresh one. Run it after the rules package's own
 * `generate`, which writes `spec/rules/`.
 *
 * It also copies the canonical-hash fixtures of the model package into `fixtures/canonical/` (CDM-011),
 * unchanged; a test checks that the copy equals a fresh one. Run it after the model package's own
 * `generate`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalCopies } from './canonical-copy.ts';
import { formatted } from './format.ts';
import { rulesCopies } from './rules-copy.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const f of [...(await formatted()), ...rulesCopies(), ...canonicalCopies()]) {
  const path = join(root, f.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, f.text);
  console.log(`wrote ${f.path}`);
}
