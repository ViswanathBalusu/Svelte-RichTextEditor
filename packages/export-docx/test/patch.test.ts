/**
 * EXP-118 and EXP-119 beyond the scripted edits (test/patch-cases.ts): copies get fresh identity
 * values and, for content that owns its part, their own part and relationships; an atom moved to
 * another part brings its relationships; deleted atoms take their parts with them; edited and new
 * pictures; header rows; and preserved data the import did not create is never written (owner
 * decision 2).
 */
import { describe, expect, it } from 'vitest';
import { exportDocx } from '../src/index.ts';
import { patchCases } from './patch-cases.ts';

const cases = await patchCases();

describe('the patching writer beyond the scripted edits', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const out = await exportDocx(c.envelope, c.bytes, c.imported.sourceMap, c.imported.assets);
    expect(c.check(out)).toEqual([]);
  });
});
