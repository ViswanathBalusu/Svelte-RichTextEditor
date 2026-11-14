/**
 * Inserting a citation at the caret (FE-140 criteria 1 and 4; CDM-052).
 * The command registry and keyboard parts of criterion 1 are not tested here: they are not built.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  insertCitation,
  MAX_CITATION_ITEMS,
  type CitationItemInput,
  type CitationMode,
} from '../src/citation-insert.ts';
import { AUTH_IDS, authoringState, caretIn, inside, selectIn } from './authoring-doc.ts';

const SOURCES = ['smith2026', 'jones2024'] as const;
const always = () => true;

describe('inserting a citation (FE-140)', () => {
  it('inserts one citation node at the caret that names the chosen sources, with their options', () => {
    const state = caretIn(authoringState(), AUTH_IDS.p1, 5);
    const items: CitationItemInput[] = [
      { source: 'smith2026', prefix: 'see', suffix: 'and below', locator: '12', label: 'page' },
      { source: 'jones2024' },
    ];
    const applied: { state: typeof state | null } = { state: null };
    const result = insertCitation(state, items, { writable: always }, (tr) => {
      applied.state = state.apply(tr);
    });
    expect(result).toEqual({ ok: true });
    const out = applied.state!;
    const found: Array<Record<string, unknown>> = [];
    out.doc.descendants((n) => {
      if (n.type.name === 'citation') found.push(n.attrs);
      return true;
    });
    expect(found).toHaveLength(1);
    expect(found[0]!['items']).toEqual([
      { source: 'smith2026', prefix: 'see', suffix: 'and below', locator: '12', label: 'page' },
      { source: 'jones2024' },
    ]);
    expect(found[0]!['mode']).toBe('normal');
  });

  it('property: any non-empty set of known sources, with random optional parts, is stored as given', () => {
    const itemArb = fc.record(
      {
        source: fc.constantFrom(...SOURCES),
        prefix: fc.string({ maxLength: 20 }),
        suffix: fc.string({ maxLength: 20 }),
        locator: fc.string({ minLength: 1, maxLength: 12 }),
      },
      { requiredKeys: ['source'] },
    );
    fc.assert(
      fc.property(
        fc.array(itemArb, { minLength: 1, maxLength: 6 }),
        fc.constantFrom<CitationMode>('normal', 'narrative', 'suppressAuthor'),
        (items, mode) => {
          const state = caretIn(authoringState(), AUTH_IDS.p2, 0);
          let stored: unknown = null;
          const result = insertCitation(state, items, { writable: always, mode }, (tr) => {
            const out = state.apply(tr);
            out.doc.descendants((n) => {
              if (n.type.name === 'citation') stored = n.attrs;
              return stored === null;
            });
          });
          expect(result).toEqual({ ok: true });
          const attrs = stored as { items: unknown[]; mode: string };
          expect(attrs.mode).toBe(mode);
          expect(attrs.items).toEqual(
            items.map((i) => {
              const out: Record<string, string> = { source: i.source };
              if (i.prefix !== undefined) out['prefix'] = i.prefix;
              if (i.suffix !== undefined) out['suffix'] = i.suffix;
              if (i.locator !== undefined) out['locator'] = i.locator;
              return out;
            }),
          );
        },
      ),
    );
  });

  it('refuses a source the document does not define, and changes nothing', () => {
    const state = caretIn(authoringState(), AUTH_IDS.p1, 0);
    let dispatched = false;
    const result = insertCitation(state, [{ source: 'nobody1999' }], { writable: always }, () => {
      dispatched = true;
    });
    expect(result).toEqual({ ok: false, reason: 'unknown-source' });
    expect(dispatched).toBe(false);
  });

  it('refuses an empty list and a list longer than the CDM allows', () => {
    const state = caretIn(authoringState(), AUTH_IDS.p1, 0);
    expect(insertCitation(state, [], { writable: always })).toEqual({
      ok: false,
      reason: 'no-items',
    });
    const many = Array.from({ length: MAX_CITATION_ITEMS + 1 }, () => ({ source: 'smith2026' }));
    expect(insertCitation(state, many, { writable: always })).toEqual({
      ok: false,
      reason: 'no-items',
    });
  });

  it('refuses a selection that is not a caret, rather than replacing text silently', () => {
    const state = selectIn(authoringState(), AUTH_IDS.p1, 0, 4);
    expect(insertCitation(state, [{ source: 'smith2026' }], { writable: always })).toEqual({
      ok: false,
      reason: 'not-a-caret',
    });
  });

  it('is unavailable inside a region the user cannot change (FE-140 criterion 4; 07 §7)', () => {
    const state = authoringState();
    const protectedFrom = inside(state.doc, AUTH_IDS.region);
    const writable = (pos: number) => pos < protectedFrom;
    const inRegion = caretIn(state, AUTH_IDS.inRegion, 2);
    let dispatched = false;
    const result = insertCitation(inRegion, [{ source: 'smith2026' }], { writable }, () => {
      dispatched = true;
    });
    expect(result).toEqual({ ok: false, reason: 'read-only' });
    expect(dispatched).toBe(false);
    // The same command in the editable paragraph works.
    const outside = caretIn(state, AUTH_IDS.p2, 2);
    expect(insertCitation(outside, [{ source: 'smith2026' }], { writable })).toEqual({ ok: true });
  });
});
