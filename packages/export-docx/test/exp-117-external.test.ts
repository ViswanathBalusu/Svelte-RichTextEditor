/**
 * EXP-117, criterion 4, the part that can be tested here: the relationships of a preserved fragment
 * to external targets (hyperlinks, linked images, linked objects) are kept as data and never
 * followed. Every corpus file is imported with fetch, XMLHttpRequest and WebSocket replaced by
 * stubs that record their calls, and the test requires that no call is made, that every external
 * relationship of a fragment is listed in the fragment with its target, and that no part is written
 * for it. Pure Node.js; no network.
 *
 * Not covered, so criterion 4 stays open: that a fragment is never parsed beyond the package
 * structure. The importer parses the XML of an atom to read its kind and its fallback text, which
 * this test does not change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importDocx, readFragment } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const CALLS: string[] = [];

beforeEach(() => {
  CALLS.length = 0;
  const record =
    (name: string) =>
    (..._args: unknown[]): never => {
      CALLS.push(name);
      throw new Error(`${name} must not be called during import`);
    };
  vi.stubGlobal('fetch', record('fetch'));
  vi.stubGlobal('XMLHttpRequest', record('XMLHttpRequest'));
  vi.stubGlobal('WebSocket', record('WebSocket'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EXP-117 criterion 4: external relationships of fragments are data, never followed', () => {
  it('imports every corpus file without a network call, and keeps each external relationship as data', async () => {
    let external = 0;
    for (const file of corpusFiles()) {
      const result = await importDocx(readFile(file));
      for (const id of result.sourceMap.fragments) {
        const asset = result.assets.get(id);
        if (!asset || asset.role !== 'fragment') continue;
        const f = readFragment(asset.bytes);
        for (const rel of f.meta.rels) {
          if (!rel.external) continue;
          external++;
          // Kept as written: the target is not resolved, and no part is copied for it.
          expect(rel.target.length, `${file.name} ${id} keeps its target`).toBeGreaterThan(0);
          expect(
            f.meta.parts.some((p) => p.name === rel.target),
            `${file.name} ${id} takes no part for ${rel.target}`,
          ).toBe(false);
        }
      }
    }
    expect(CALLS).toEqual([]);
    expect(external).toBeGreaterThan(0);
  });
});
