// PRO-110 criterion 3 with a second language: the model's independent Python implementation of the
// canonical form (packages/model/conformance/canonical.py) run against the canonical-hash fixtures
// the kit ships (CDM-011). Skipped, with the reason, where no Python 3 is installed; the kit's CI job
// installs one (ADR 0042).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalFixtures, modelFile } from '../src/fixtures.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const python = ['python3', 'python', 'py'].find(
  (p) => spawnSync(p, ['--version'], { encoding: 'utf8' }).status === 0,
);

describe('the canonical-hash fixtures through the Python implementation (PRO-110 criterion 3)', () => {
  it.skipIf(!python)('reproduces the bytes and the SHA-256 of every case', () => {
    const script = join(root, 'packages/model/conformance/canonical.py');
    const schema = join(root, 'spec/cdm/cdm-1.prosemirror.json');
    const index = fileURLToPath(modelFile('canonical/index.json'));
    const r = spawnSync(python!, ['-I', script, schema, index], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const results = JSON.parse(r.stdout) as Record<string, { bytes: boolean; sha256: boolean }>;
    expect(Object.keys(results).sort()).toEqual(
      canonicalFixtures()
        .map((c) => c.name)
        .sort(),
    );
    for (const [name, v] of Object.entries(results))
      expect(v, name).toEqual({ bytes: true, sha256: true });
  });
});
