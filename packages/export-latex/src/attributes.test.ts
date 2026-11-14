/**
 * EXP-045 criterion 2: every attribute of the CDM has an entry in the attribute table, and the
 * table names no attribute the CDM lacks. A new attribute cannot reach TeX without a decision in
 * `attributes.ts` (09 §4). Node.js only.
 */
import { describe, expect, it } from 'vitest';
import { CDM1 } from '@docedit/model/definition';
import { ATTRIBUTE_EMITTERS } from './attributes.ts';
import { EMITTERS } from './emit.ts';

/** The keys of the CDM: `node.attr` for nodes, `mark:mark.attr` for marks (as the table writes them). */
function cdmKeys(): string[] {
  const keys: string[] = [];
  // Projection nodes (ADR 0019) are placeholders a reader may see, so they count as CDM attributes.
  for (const n of [...CDM1.nodes, ...(CDM1.projection ?? [])] as ReadonlyArray<{
    name: string;
    attrs?: Record<string, unknown>;
  }>)
    for (const a of Object.keys(n.attrs ?? {})) keys.push(`${n.name}.${a}`);
  for (const m of CDM1.marks as ReadonlyArray<{ name: string; attrs?: Record<string, unknown> }>)
    for (const a of Object.keys(m.attrs ?? {})) keys.push(`mark:${m.name}.${a}`);
  return keys.sort();
}

describe('EXP-045 attribute table (criterion 2)', () => {
  it('has an entry for every attribute of the CDM', () => {
    const missing = cdmKeys().filter((k) => !Object.hasOwn(ATTRIBUTE_EMITTERS, k));
    expect(missing).toEqual([]);
  });

  it('names no attribute the CDM does not define', () => {
    const known = new Set(cdmKeys());
    const extra = Object.keys(ATTRIBUTE_EMITTERS).filter((k) => !known.has(k));
    expect(extra).toEqual([]);
  });

  it('names only emitters of 09 §4 or null (the value never reaches the bundle)', () => {
    const allowed = new Set<string | null>([...EMITTERS, null]);
    for (const [key, emitter] of Object.entries(ATTRIBUTE_EMITTERS))
      expect(allowed.has(emitter), key).toBe(true);
  });
});
