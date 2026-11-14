// Paragraph styles (CDM-016; 03 §4.1, §4.3, §6): the default style for a null `style`, inheritance
// through `basedOn`, and headings as paragraphs whose style chain has an outline level.
import { describe, expect, it } from 'vitest';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
import type { JsonNode } from '../canonical/canonical-form.ts';
import { outlineLevelOf, paragraphStyleOf, styleProperty, styleTable } from './styles.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function withStyles(extra: Json[], settings: Json = {}): JsonNode {
  const env = structuredClone(example) as Json;
  const defs = env['doc'].content[0].content as Json[];
  Object.assign(defs[0]!.attrs, settings);
  defs.splice(3, 0, ...extra);
  return env['doc'] as JsonNode;
}

describe('paragraph styles', () => {
  it('treats a paragraph with style null as having the default paragraph style', () => {
    const table = styleTable(withStyles([]));
    expect(paragraphStyleOf(table, { style: null })).toBe('Normal');
    expect(paragraphStyleOf(table, {})).toBe('Normal');
    expect(paragraphStyleOf(table, { style: 'Heading1' })).toBe('Heading1');
    const other = styleTable(
      withStyles([{ type: 'style_def', attrs: { id: 'Body', name: 'Body' } }], {
        defaultParagraphStyle: 'Body',
      }),
    );
    expect(paragraphStyleOf(other, { style: null })).toBe('Body');
  });

  it('makes a paragraph a heading when its style, through basedOn, has an outline level', () => {
    const table = styleTable(
      withStyles([
        // null means inherit: a style based on Heading1 is a level-1 heading.
        { type: 'style_def', attrs: { id: 'Clause', name: 'Clause', basedOn: 'Heading1' } },
        {
          type: 'style_def',
          attrs: { id: 'SubClause', name: 'Sub-clause', basedOn: 'Clause', outlineLevel: 2 },
        },
      ]),
    );
    expect(outlineLevelOf(table, { style: 'Heading1' })).toBe(1);
    expect(outlineLevelOf(table, { style: 'Clause' })).toBe(1);
    expect(outlineLevelOf(table, { style: 'SubClause' })).toBe(2);
    expect(outlineLevelOf(table, { style: null })).toBeNull(); // Normal has none
    expect(styleProperty(table, 'Clause', 'fontSize')).toBe(320);
  });

  it('stops at ten styles and never loops on an invalid document', () => {
    const chain = Array.from({ length: 11 }, (_, i) => ({
      type: 'style_def',
      attrs: { id: `s${i}`, name: `S${i}`, basedOn: i === 0 ? 'Heading1' : `s${i - 1}` },
    }));
    const table = styleTable(withStyles(chain));
    expect(outlineLevelOf(table, { style: 's8' })).toBe(1); // ten styles: s8 … s0, Heading1
    expect(outlineLevelOf(table, { style: 's9' })).toBeNull(); // the eleventh is out of reach
    const loop = styleTable(
      withStyles([
        { type: 'style_def', attrs: { id: 'A', name: 'A', basedOn: 'B' } },
        { type: 'style_def', attrs: { id: 'B', name: 'B', basedOn: 'A' } },
      ]),
    );
    expect(outlineLevelOf(loop, { style: 'A' })).toBeNull();
  });
});
