// The rules fixtures the kit ships (PRO-123): the copy is complete, matches its manifest, is in the
// documented format, and equals a fresh copy of the published set (`spec/rules/`) made by the kit's
// generate script. The rule that a published case may not change under the same rules version
// (criterion 3; FRW-020) is enforced and tested in the rules package, not here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rulesCopies } from '../scripts/rules-copy.ts';
import { kitFile } from '../src/fixtures.ts';
import {
  RULES_FILES,
  publishedRulesPresent,
  rulesFixtures,
  rulesManifest,
  sha256Hex,
} from '../src/rules-fixtures.ts';

const pkg = join(import.meta.dirname, '..');
const kitText = (name: string) => readFileSync(fileURLToPath(kitFile(`rules/${name}`)), 'utf8');
const CATEGORIES = ['operators', 'decimal', 'dates', 'patterns', 'rules', 'invalid', 'values'];
const KINDS = ['expression', 'rules', 'pattern', 'value'];

describe('the rules fixtures in the kit (PRO-123 criterion 1)', () => {
  it('ship every published file, and the manifest names the SHA-256 of each', () => {
    const manifest = rulesManifest();
    // The manifest names the files it describes, not itself.
    for (const name of RULES_FILES.filter((n) => !n.endsWith('.manifest.json')))
      expect(sha256Hex(kitText(name)), name).toBe(manifest.files[`spec/rules/${name}`]);
  });

  it('describe every case in the documented format (rules/README.md)', () => {
    const fx = rulesFixtures();
    const manifest = rulesManifest();
    expect(fx.rules).toBe(manifest.rules);
    expect(fx.cases.length).toBe(manifest.cases);
    expect(new Set(fx.cases.map((c) => c.id)).size).toBe(fx.cases.length);
    for (const c of fx.cases) {
      expect(CATEGORIES, c.id).toContain(c.category);
      expect(KINDS, c.id).toContain(c.kind);
      expect(Array.isArray(c['covers']), c.id).toBe(true);
      expect(c.expect, c.id).toBeDefined();
    }
    const readme = readFileSync(fileURLToPath(kitFile('rules/README.md')), 'utf8');
    for (const member of ['`expect`', '`covers`', '`given`', '`kind`', '`category`'])
      expect(readme, member).toContain(member);
  });

  it.skipIf(!publishedRulesPresent())(
    'equal a fresh copy of spec/rules/ by the kit generate script, byte for byte',
    () => {
      const copies = rulesCopies();
      expect(copies.map((f) => f.path)).toEqual(RULES_FILES.map((n) => `fixtures/rules/${n}`));
      for (const f of copies)
        expect(
          readFileSync(join(pkg, f.path), 'utf8'),
          `${f.path} is stale; run pnpm --filter @docedit/tck generate`,
        ).toBe(f.text);
    },
  );
});
