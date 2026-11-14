/**
 * The kit's copy of the published rules fixtures (PRO-123): `spec/rules/<name>` becomes
 * `fixtures/rules/<name>`, byte for byte. The rules package generates and guards the published set
 * (`packages/rules/scripts/generate.ts`); this copy only carries it into the kit, so it is not
 * formatted or changed in any way.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FixtureFile } from '../src/golden.ts';
import { RULES_FILES, publishedRulesFile } from '../src/rules-fixtures.ts';

export function rulesCopies(): FixtureFile[] {
  return RULES_FILES.map((name) => {
    const source = fileURLToPath(publishedRulesFile(name));
    if (!existsSync(source))
      throw new Error(`spec/rules/${name} is missing; run pnpm --filter @docedit/rules generate`);
    return { path: `fixtures/rules/${name}`, text: readFileSync(source, 'utf8') };
  });
}
