// Invariants of the cascade (CDM-041; 03 §6; ADR 0032), as property tests: for any assignment of
// values to the layers, the resolved value is the one of the last layer that sets it, a style
// counts once (at the first layer that reaches it), and toggles follow the last layer too.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BASE_PARAGRAPH, BASE_RUN, resolveParagraph, resolveRun } from './resolve.ts';
import { type TreeNode, styleTable } from './styles.ts';

type J = Record<string, unknown>;
const value = fc.option(fc.integer({ min: 0, max: 1000 }), { freq: 2 });
const toggle = fc.option(fc.boolean(), { freq: 2 });

function docOf(styles: J[], levels: J[] = []): TreeNode {
  return {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          { type: 'settings', attrs: {} },
          ...styles.map((attrs) => ({ type: 'style_def', attrs })),
          { type: 'numbering_def', attrs: { id: 'n', levels } },
          { type: 'page_setup', attrs: { id: 'ps1' } },
        ],
      },
    ],
  } as unknown as TreeNode;
}

const set = (k: string, v: number | boolean | null): J => (v === null ? {} : { [k]: v });

describe('cascade invariants (CDM-041)', () => {
  it('resolves every property to the last layer that sets it; a style counts once', () => {
    fc.assert(
      fc.property(
        fc.record({
          normal: value,
          table: value,
          chain: fc.array(value, { minLength: 1, maxLength: 4 }),
          rootIsNormal: fc.boolean(),
          direct: value,
          inTable: fc.boolean(),
        }),
        (c) => {
          const chainIds = c.chain.map((_, i) => `S${i}`);
          const styles: J[] = [
            {
              id: 'Normal',
              kind: 'paragraph',
              name: 'Normal',
              builtIn: true,
              ...set('spaceBefore', c.normal),
            },
            { id: 'Grid', kind: 'table', name: 'Grid', ...set('spaceBefore', c.table) },
            ...c.chain.map((v, i) => ({
              id: chainIds[i],
              kind: 'paragraph',
              name: chainIds[i],
              ...(i > 0
                ? { basedOn: chainIds[i - 1] }
                : c.rootIsNormal
                  ? { basedOn: 'Normal' }
                  : {}),
              ...set('spaceBefore', v),
            })),
          ];
          const table = styleTable(docOf(styles));
          const leaf = chainIds[chainIds.length - 1]!;
          const r = resolveParagraph(
            table,
            { style: leaf, ...set('spaceBefore', c.direct) },
            { tableStyle: c.inTable ? 'Grid' : null },
          );
          if (!r.ok) throw new Error(r.error.message);
          // Normal is layer 1, whether or not the chain reaches it again (it does not count twice).
          const layers = [
            BASE_PARAGRAPH.spaceBefore,
            c.normal,
            c.inTable ? c.table : null,
            ...c.chain,
            c.direct,
          ];
          const expected = layers.filter((v): v is number => v !== null).at(-1);
          expect(r.value.properties.spaceBefore).toBe(expected);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('puts the numbering level between the table style and the paragraph style (03 §6, 3 and 4)', () => {
    fc.assert(
      fc.property(
        value,
        value,
        fc.integer({ min: 0, max: 2000 }),
        value,
        (table, style, level, direct) => {
          const styles: J[] = [
            { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            { id: 'Grid', kind: 'table', name: 'Grid', ...set('indentLeft', table) },
            {
              id: 'Item',
              kind: 'paragraph',
              name: 'Item',
              basedOn: 'Normal',
              ...set('indentLeft', style),
            },
          ];
          const t = styleTable(
            docOf(styles, [{ format: 'decimal', text: '%1', start: 1, indentLeft: level }]),
          );
          const r = resolveParagraph(
            t,
            {
              style: 'Item',
              numbering: { numberingId: 'n', level: 0, listId: 'listAxxxxxxxxxxx' },
              ...set('indentLeft', direct),
            },
            { tableStyle: 'Grid' },
          );
          if (!r.ok) throw new Error(r.error.message);
          const expected = [table, level, style, direct]
            .filter((v): v is number => v !== null)
            .at(-1);
          expect(r.value.properties.indentLeft).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('resolves toggles to the last layer that sets them; a mark without a value switches on', () => {
    fc.assert(
      fc.property(
        toggle,
        toggle,
        fc.array(toggle, { minLength: 0, maxLength: 3 }),
        fc.option(fc.option(fc.boolean(), { nil: undefined }), { nil: null }),
        (normal, para, charChain, mark) => {
          const charIds = charChain.map((_, i) => `C${i}`);
          const styles: J[] = [
            {
              id: 'Normal',
              kind: 'paragraph',
              name: 'Normal',
              builtIn: true,
              ...set('bold', normal),
            },
            {
              id: 'Body',
              kind: 'paragraph',
              name: 'Body',
              basedOn: 'Normal',
              ...set('bold', para),
            },
            ...charChain.map((v, i) => ({
              id: charIds[i],
              kind: 'character',
              name: charIds[i],
              ...(i ? { basedOn: charIds[i - 1] } : {}),
              ...set('bold', v),
            })),
          ];
          const table = styleTable(docOf(styles));
          const p = resolveParagraph(table, { style: 'Body' });
          if (!p.ok) throw new Error(p.error.message);
          const marks = [
            ...(charIds.length
              ? [{ type: 'charStyle', attrs: { style: charIds[charIds.length - 1] } }]
              : []),
            ...(mark === null
              ? []
              : [mark === undefined ? { type: 'bold' } : { type: 'bold', attrs: { value: mark } }]),
          ];
          const run = resolveRun(table, p.value, marks);
          if (!run.ok) throw new Error(run.error.message);
          const markValue = mark === null ? null : mark === undefined ? true : mark;
          const expected = [BASE_RUN.bold, normal, para, ...charChain, markValue]
            .filter((v): v is boolean => v !== null)
            .at(-1);
          expect(run.value.bold).toBe(expected);
        },
      ),
      { numRuns: 500 },
    );
  });
});
