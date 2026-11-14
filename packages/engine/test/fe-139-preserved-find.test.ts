/**
 * Find and replace and preserved content (FE-139 criterion 4): the search does not match inside a
 * preserved atom, and it reports how many atoms it skipped. The find panel is the view's; this tests
 * the search's own rules in the headless core.
 */
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { findMatches } from '../src/search.ts';
import { skippedPreservedAtoms } from '../src/preserved-find.ts';
import { internals } from '../src/testing.ts';
import { describe, expect, it } from 'vitest';
import { spikeDocument } from './fixtures.ts';
import { microtask } from './support.ts';

const ASSET = '0190f0a0-0000-7000-8000-000000000001';

/** The spike document with a text paragraph and a preserved chart whose fallback text is `fallback`. */
function withPreserved(fallback: string): CdmEnvelope {
  const env = spikeDocument();
  const doc = structuredClone(env.doc) as {
    content: Array<{ content?: Array<Record<string, unknown>> }>;
  };
  const body = doc.content[doc.content.length - 1]!;
  body.content!.push(
    {
      type: 'paragraph',
      attrs: { id: 'pChart00000000001' },
      content: [{ type: 'text', text: 'Sales Chart below' }],
    },
    {
      type: 'preserved_block',
      attrs: {
        id: 'bChart00000000001',
        label: 'chart',
        fragment: ASSET,
        fallbackText: fallback,
      },
    },
  );
  return { ...env, requires: [...env.requires, 'preserve'], doc: doc as CdmEnvelope['doc'] };
}

function bodyDoc(env: CdmEnvelope) {
  return internals(new DocumentCore({ doc: env, schedule: microtask })).state.doc;
}

describe('find does not match inside preserved content (FE-139 criterion 4)', () => {
  it('matches the text paragraph but not the fallback text of a preserved atom', () => {
    const doc = bodyDoc(withPreserved('Chart from Word'));
    const hits = findMatches(doc, 'Chart');
    // One match: the word in the paragraph. The atom's fallback text is never searched.
    expect(hits.map((h) => h.text)).toEqual(['Chart']);
    expect(findMatches(doc, 'from Word')).toEqual([]);
  });

  it('reports how many preserved atoms the query would have matched and the search skipped', () => {
    const doc = bodyDoc(withPreserved('Chart from Word'));
    expect(skippedPreservedAtoms(doc, 'Chart')).toBe(1);
    expect(skippedPreservedAtoms(doc, 'from Word')).toBe(1);
  });

  it('skips nothing when no preserved fallback holds the query, and nothing for an empty query', () => {
    const doc = bodyDoc(withPreserved('Chart from Word'));
    expect(skippedPreservedAtoms(doc, 'Sales')).toBe(0);
    expect(skippedPreservedAtoms(doc, '')).toBe(0);
  });

  it('counts each preserved atom once, however many times its fallback holds the query', () => {
    const doc = bodyDoc(withPreserved('chart chart chart'));
    expect(skippedPreservedAtoms(doc, 'chart')).toBe(1);
    // The paragraph's own text still matches, once.
    expect(findMatches(doc, 'chart')).toHaveLength(0);
  });

  it('a document without preserved content skips nothing', () => {
    const doc = bodyDoc(spikeDocument());
    expect(skippedPreservedAtoms(doc, 'Introduction')).toBe(0);
  });
});
