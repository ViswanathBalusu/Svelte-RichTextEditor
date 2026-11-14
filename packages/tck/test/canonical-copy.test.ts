// The canonical-hash fixtures the kit ships (CDM-011 criterion 5): the copy is complete, equals a fresh
// copy of the model's set made by the kit's generate script, byte for byte, and every SHA-256 in its
// index matches the bytes of the file the index names. The rule that a case may not change under the
// same canonical-form version is enforced where the fixtures are generated (packages/model), not here.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalCopies,
  canonicalSourceFiles,
  canonicalSourcePresent,
} from '../scripts/canonical-copy.ts';
import { kitFile } from '../src/fixtures.ts';

const pkg = join(import.meta.dirname, '..');
const kitText = (rel: string) => readFileSync(fileURLToPath(kitFile(`canonical/${rel}`)), 'utf8');
const kitBytes = (rel: string) => readFileSync(fileURLToPath(kitFile(`canonical/${rel}`)));
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Index {
  canonicalFormVersion: number;
  cases: Array<{
    name: string;
    kind: string;
    input: string;
    inputSha256: string;
    expected: string;
    sha256: string;
  }>;
}

const index = (): Index => JSON.parse(kitText('index.json')) as Index;

describe('the canonical-hash fixtures in the kit (CDM-011 criterion 5)', () => {
  it('ship the index, every input and every expected file the model publishes', () => {
    const fx = index();
    expect(fx.cases.length).toBeGreaterThan(0);
    for (const c of fx.cases) {
      expect(existsSync(fileURLToPath(kitFile(`canonical/${c.input}`))), c.input).toBe(true);
      expect(existsSync(fileURLToPath(kitFile(`canonical/${c.expected}`))), c.expected).toBe(true);
    }
    expect(existsSync(fileURLToPath(kitFile('canonical/README.md')))).toBe(true);
  });

  it('name the SHA-256 of every input and expected file, over the bytes on disk', () => {
    for (const c of index().cases) {
      expect(sha256(kitBytes(c.input)), c.input).toBe(c.inputSha256);
      expect(sha256(kitBytes(c.expected)), c.expected).toBe(c.sha256);
    }
  });

  it('describe every case in the documented format (canonical/README.md)', () => {
    const fx = index();
    expect(fx.canonicalFormVersion).toBe(1);
    expect(new Set(fx.cases.map((c) => c.name)).size).toBe(fx.cases.length);
    for (const c of fx.cases) expect(['envelope', 'node'], c.name).toContain(c.kind);
    const readme = kitText('README.md');
    for (const member of ['`inputSha256`', '`expected`', '`kind`', '`canonicalFormVersion`'])
      expect(readme, member).toContain(member);
  });

  it.skipIf(!canonicalSourcePresent())(
    'equal a fresh copy of the model fixtures by the kit generate script, byte for byte',
    () => {
      const copies = canonicalCopies();
      expect(copies.map((f) => f.path)).toEqual(
        canonicalSourceFiles().map((rel) => `fixtures/canonical/${rel}`),
      );
      for (const f of copies)
        expect(
          readFileSync(join(pkg, f.path), 'utf8'),
          `${f.path} is stale; run pnpm --filter @docedit/tck generate`,
        ).toBe(f.text);
    },
  );
});
