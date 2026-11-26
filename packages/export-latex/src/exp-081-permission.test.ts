/**
 * A whole-block deletion under `accept` passes the permission rules (EXP-081 criterion 3; 09 §10;
 * owner decision 111). Node.js only. The payload carries the owner of each suggestion identifier
 * and the scopes where the requester holds `edit`; the deletion is honoured only when the owner
 * is the mark's author and the requester may edit the block's scope.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, run, type J } from '../test/docs.ts';
import { delMark, markedPara, printed, tableOf } from '../test/suggestions.ts';
import type { Diagnostic, SuggestionAccess } from './bundle.ts';
import { settleSuggestions } from './suggestions.ts';

const mark = delMark(1);
const id = (mark.attrs as { id: string }).id;
const owned: SuggestionAccess = { owners: { [id]: 'alice' }, edit: ['body'] };

const body = (): J[] => [para('Keep'), markedPara('Gone', [structuredClone(mark)]), para('End')];

describe('EXP-081 criterion 3: a block deletion passes the permission rules', () => {
  it('honours a deletion whose owner is known and whose scope the requester may edit', async () => {
    const b = await run(doc(body()), { suggestions: 'accept', suggestionAccess: owned });
    expect(printed(b)).toBe('KeepEnd');
    expect(b.diagnostics.some((d) => d.code === 'suggestion_not_permitted')).toBe(false);
  });

  it('keeps the block and names it when the requester may not edit the scope', async () => {
    const access: SuggestionAccess = { owners: { [id]: 'alice' }, edit: [] };
    const b = await run(doc(body()), { suggestions: 'accept', suggestionAccess: access });
    expect(printed(b)).toBe('KeepGoneEnd');
    expect(b.diagnostics.filter((d) => d.code === 'suggestion_not_permitted')).toHaveLength(1);
  });

  it('keeps the block when the owner of the identifier is another user or unknown', async () => {
    for (const owners of [{ [id]: 'mallory' }, {}]) {
      const b = await run(doc(body()), {
        suggestions: 'accept',
        suggestionAccess: { owners, edit: 'all' },
      });
      expect(printed(b)).toBe('KeepGoneEnd');
    }
  });

  it('honours every deletion for a service credential (`all`)', async () => {
    const b = await run(doc(body()), {
      suggestions: 'accept',
      suggestionAccess: { owners: { [id]: 'alice' }, edit: 'all' },
    });
    expect(printed(b)).toBe('KeepEnd');
  });

  it('applies to a whole row and a whole table', () => {
    const rowDel = tableOf([{ cells: ['a'], marks: [structuredClone(mark)] }, { cells: ['b'] }]);
    const tableDel = tableOf([{ cells: ['c'] }], [structuredClone(delMark(2))]);
    const marksOf = (n: J): string[] => {
      const out: string[] = [];
      const walk = (x: J) => {
        for (const m of (x.marks as J[] | undefined) ?? []) out.push(m.type as string);
        for (const c of (x.content as J[] | undefined) ?? []) walk(c);
      };
      walk(n);
      return out;
    };
    const none: Diagnostic[] = [];
    const denied = settleSuggestions(
      { type: 'doc', content: [rowDel, tableDel] } as J,
      'accept',
      none,
      { owners: {}, edit: [] },
    );
    expect(marksOf(denied)).toEqual([]);
    expect(none.filter((d) => d.code === 'suggestion_not_permitted')).toHaveLength(2);
    const allowed = settleSuggestions(
      { type: 'doc', content: [rowDel, tableDel] } as J,
      'accept',
      [],
      {
        owners: { [id]: 'alice', [(delMark(2).attrs as { id: string }).id]: 'alice' },
        edit: ['body'],
      },
    );
    expect(marksOf(allowed)).toEqual(['del', 'del']);
  });

  it('checks the region of the block, not the body', () => {
    const inRegion: J = {
      type: 'region',
      attrs: { id: 'rRRRRRRRRRRRRRRR', title: 'Clause', policy: 'inherit' },
      content: [markedPara('Gone', [structuredClone(mark)])],
    };
    const root = { type: 'doc', content: [inRegion] } as J;
    const bodyOnly: Diagnostic[] = [];
    settleSuggestions(root, 'accept', bodyOnly, { owners: { [id]: 'alice' }, edit: ['body'] });
    expect(bodyOnly.map((d) => d.code)).toEqual(['suggestion_not_permitted']);
    const both: Diagnostic[] = [];
    settleSuggestions(root, 'accept', both, {
      owners: { [id]: 'alice' },
      edit: ['body', 'region:rRRRRRRRRRRRRRRR'],
    });
    expect(both).toEqual([]);
  });

  it('does not apply under reject or markup, or without the payload', async () => {
    const denied: SuggestionAccess = { owners: {}, edit: [] };
    expect(
      printed(await run(doc(body()), { suggestions: 'reject', suggestionAccess: denied })),
    ).toBe('KeepGoneEnd');
    expect(printed(await run(doc(body()), { suggestions: 'accept' }))).toBe('KeepEnd');
  });

  it('does not change its argument', () => {
    const root = { type: 'doc', content: body() } as J;
    const before = JSON.stringify(root);
    settleSuggestions(root, 'accept', [], { owners: {}, edit: [] });
    expect(JSON.stringify(root)).toBe(before);
  });
});
