/**
 * CDM-041 criterion 7, DOCX side (Node.js only, lane V-CDM-028-053): the resolver that the DOCX
 * writer uses, `resolveParagraph` and `resolveRun` from `@docedit/model`, gives the values that
 * `packages/model/fixtures/semantics/cascade.json` expects for every case.
 *
 * The writer calls the same functions (`writer.ts`), so a case that fails here means the DOCX side
 * would write a different value from the one the fixture fixes. This test does not run the writer
 * itself; the layout engine side is still open (CDM-041 Notes).
 */
import { describe, expect, it } from 'vitest';
import cascadeFile from '../../model/fixtures/semantics/cascade.json' with { type: 'json' };
import {
  resolveLabelRun,
  resolveParagraph,
  resolveRun,
  styleTable,
  type TreeNode,
} from '@docedit/model';

type J = Record<string, unknown>;

interface CascadeCase {
  id: string;
  description: string;
  settings?: J;
  styles?: J[];
  numberings?: J[];
  paragraph: J;
  context?: { tableStyle?: string };
  marks?: J[];
  expected: {
    error?: string;
    styleId?: string;
    numbering?: J;
    paragraph?: J;
    run?: J;
    labelRun?: J;
    layers?: Record<string, string>;
  };
}

interface CascadeFile {
  settings: J;
  styles: J[];
  numberings: J[];
  cases: CascadeCase[];
}

const file = cascadeFile as unknown as CascadeFile;

/** Fixture definitions, overridden by the case's own definitions with the same `id`. */
function mergeById(base: readonly J[], extra: readonly J[] = []): J[] {
  const out = [...base];
  for (const n of extra) {
    const id = (n['attrs'] as J | undefined)?.['id'];
    const i = out.findIndex((m) => (m['attrs'] as J | undefined)?.['id'] === id);
    if (i >= 0) out[i] = n;
    else out.push(n);
  }
  return out;
}

/** The document of one case, assembled as the fixture's `format` says (no validation here). */
function documentOf(c: CascadeCase, body: readonly J[]): TreeNode {
  const defs = {
    type: 'defs',
    content: [
      { type: 'settings', attrs: { ...file.settings, ...c.settings } },
      ...mergeById(file.styles, c.styles),
      ...mergeById(file.numberings, c.numberings),
      { type: 'page_setup', attrs: { id: 'ps1' } },
    ],
  };
  return {
    type: 'doc',
    content: [defs, { type: 'body', attrs: { pageSetup: 'ps1' }, content: body }],
  } as unknown as TreeNode;
}

describe('cascade fixtures through the LaTeX converter resolver (CDM-041)', () => {
  for (const c of file.cases)
    it(`${c.id}: ${c.description}`, () => {
      const paragraph = {
        type: 'paragraph',
        attrs: { id: 'p00xxxxxxxxxxxxx', ...c.paragraph },
        content: [{ type: 'text', text: 'Text', ...(c.marks ? { marks: c.marks } : {}) }],
      };
      const tableStyle = c.context?.tableStyle ?? null;
      const block = tableStyle
        ? {
            type: 'table',
            attrs: { id: 'tablexxxxxxxxxxx', style: tableStyle, grid: [9000] },
            content: [
              {
                type: 'table_row',
                attrs: { id: 'rowxxxxxxxxxxxxx' },
                content: [
                  { type: 'table_cell', attrs: { id: 'cellxxxxxxxxxxxx' }, content: [paragraph] },
                ],
              },
            ],
          }
        : paragraph;
      const table = styleTable(documentOf(c, [block]));
      const resolved = resolveParagraph(table, c.paragraph, { tableStyle, trace: true });
      if (c.expected.error) {
        expect(resolved.ok).toBe(false);
        if (!resolved.ok) expect(resolved.error.code).toBe(c.expected.error);
        return;
      }
      if (!resolved.ok) throw new Error(resolved.error.message);
      const p = resolved.value;
      if (c.expected.styleId) expect(p.styleId).toBe(c.expected.styleId);
      if (c.expected.numbering) expect(p.numbering).toEqual(c.expected.numbering);
      for (const [k, v] of Object.entries(c.expected.paragraph ?? {}))
        expect((p.properties as unknown as J)[k], k).toEqual(v);
      const run = resolveRun(table, p, c.marks as never, { trace: true });
      if (!run.ok) throw new Error(run.error.message);
      for (const [k, v] of Object.entries(c.expected.run ?? {}))
        expect((run.value as unknown as J)[k], k).toEqual(v);
      for (const [k, v] of Object.entries(c.expected.labelRun ?? {}))
        expect((resolveLabelRun(p) as unknown as J)[k], k).toEqual(v);
      for (const [k, layer] of Object.entries(c.expected.layers ?? {})) {
        const fromRun = c.marks !== undefined && k in (run.value.trace ?? {});
        expect(fromRun ? run.value.trace?.[k] : p.trace?.[k], k).toBe(layer);
      }
    });
});
