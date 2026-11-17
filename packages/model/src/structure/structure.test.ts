// Reading and building the structure of documents: pasted definitions (CDM-023), a new document
// (CDM-016), and the digests of preserved payloads (CDM-051, kept enforceable for SR-C2).
import { describe, expect, it } from 'vitest';
import {
  bodyOf,
  ctx,
  exampleDoc,
  para,
  sinkDoc,
  style,
  text,
  type Json,
} from '../../test/support.ts';
import { nodeId } from '../conventions/ids.ts';
import { BUILT_IN_STYLES } from '../definition/cdm1.ts';
import { validate } from '../validate/validate.ts';
import { builtInStyleName, newDocument } from './new-document.ts';
import type { JsonNode } from '../canonical/canonical-form.ts';
import { mapPastedDefinitions as mapJson, type PasteOptions } from './paste.ts';

/** The mapping with the loosely typed builders of the tests. */
const mapPastedDefinitions = (
  target: Json,
  pasted: { definitions: Json[]; content: Json[] },
  opts?: PasteOptions,
) =>
  mapJson(
    target as JsonNode,
    { definitions: pasted.definitions as JsonNode[], content: pasted.content as JsonNode[] },
    opts,
  );
import { preservedDigests, preservedPayloads } from './preserved.ts';

/** Inserts the result of a paste into the example: definitions into defs, blocks at the end. */
function insert(target: Json, r: ReturnType<typeof mapPastedDefinitions>): Json {
  const defs = target['doc'].content[0].content as Json[];
  const at = defs.findIndex((d) => d.type === 'page_setup');
  defs.splice(at, 0, ...r.definitions.filter((d) => d.type === 'style_def'));
  bodyOf(target).push(...r.content);
  return target;
}

describe('pasted definitions (CDM-023)', () => {
  it('maps a brought definition with an identifier the target has onto the target one', () => {
    const target = exampleDoc();
    const r = mapPastedDefinitions(
      target['doc'],
      {
        definitions: [
          style('Normal', { builtIn: true, fontSize: 480 }),
          style('sQuote0000000001', { basedOn: 'Normal', italic: true }),
        ],
        content: [
          para('pPasted000000001', 'pasted', { style: 'Normal' }),
          para('pPasted000000002', 'quoted', { style: 'sQuote0000000001' }),
        ],
      },
      { newId: nodeId },
    );
    expect(r.mapped).toEqual(['Normal']);
    expect(r.definitions.map((d) => d.attrs!['id'])).toEqual(['sQuote0000000001']);
    expect(r.content.map((p) => p.attrs!['style'])).toEqual(['Normal', 'sQuote0000000001']);
    const merged = insert(target, r);
    expect(
      merged['doc'].content[0].content.filter((d: Json) => d.attrs?.id === 'Normal'),
    ).toHaveLength(1);
  });

  it('keeps the target definition of a built-in identifier, so pasted paragraphs take its look', () => {
    const target = exampleDoc();
    const r = mapPastedDefinitions(target['doc'], {
      definitions: [
        style('Heading1', { builtIn: true, basedOn: 'Normal', fontSize: 640, color: '#FF0000' }),
      ],
      content: [para('pPasted000000001', 'title', { style: 'Heading1' })],
    });
    expect(r.definitions).toEqual([]);
    const heading = target['doc'].content[0].content.find((d: Json) => d.attrs?.id === 'Heading1');
    expect(heading.attrs.fontSize).toBe(320);
    expect(r.content[0]!.attrs!['style']).toBe('Heading1');
  });

  it('drops a brought numbering definition the target has, and adds a new one once', () => {
    const target = exampleDoc();
    const defs = target['doc'].content[0].content as Json[];
    const levels = [{ format: 'decimal', text: '%1.', start: 1 }];
    const at = defs.findIndex((d) => d.type === 'page_setup');
    defs.splice(at, 0, { type: 'numbering_def', attrs: { id: 'numHave', levels } });
    const numbered = (id: string, numberingId: string) =>
      para(id, 'item', {
        numbering: { numberingId, level: 0, listId: 'lList00000000001' },
      });
    const r = mapPastedDefinitions(target['doc'], {
      definitions: [
        { type: 'numbering_def', attrs: { id: 'numHave', levels: [{ format: 'upperRoman' }] } },
        { type: 'numbering_def', attrs: { id: 'numNew', levels } },
        { type: 'numbering_def', attrs: { id: 'numNew', levels: [{ format: 'bullet' }] } },
      ],
      content: [numbered('pPasted000000001', 'numHave'), numbered('pPasted000000002', 'numNew')],
    });
    expect(r.mapped).toEqual(['numHave']);
    expect(r.definitions).toEqual([{ type: 'numbering_def', attrs: { id: 'numNew', levels } }]);
    expect(r.dropped).toEqual([]);
    expect(
      r.content.map((p) => (p.attrs!['numbering'] as { numberingId: string }).numberingId),
    ).toEqual(['numHave', 'numNew']);
  });

  it('leaves no unresolved style, basedOn, next or numbering reference and no duplicate identifier', () => {
    const target = exampleDoc();
    const r = mapPastedDefinitions(
      target['doc'],
      {
        definitions: [style('sChild0000000001', { basedOn: 'sGone', next: 'sGone' })],
        content: [
          para(
            'pZ9y8X7w6V5u4T3s',
            [text('x', [{ type: 'charStyle', attrs: { style: 'cGone' } }])],
            {
              style: 'sGone',
              numbering: { numberingId: 'numGone', level: 0, listId: 'lList00000000001' },
            },
          ),
          para('pPasted000000002', 'y', { style: 'sChild0000000001' }),
        ],
      },
      { newId: nodeId },
    );
    expect(r.dropped.sort()).toEqual(
      ['basedOn:sGone', 'charStyle:cGone', 'next:sGone', 'numbering:numGone', 'style:sGone'].sort(),
    );
    const merged = insert(target, r);
    expect(validate(merged, ctx).violations).toEqual([]);
  });
});

describe('a new document (CDM-016)', () => {
  it('holds every built-in style under its reserved identifier, and random identifiers elsewhere', () => {
    const d = newDocument({ lang: 'en-GB' });
    expect(validate(d, ctx).violations).toEqual([]);
    const defs = d.doc.content![0]!.content!;
    const styles = defs.filter((n) => n.type === 'style_def').map((n) => n.attrs!['id']);
    expect(styles.sort()).toEqual(Object.keys(BUILT_IN_STYLES).sort());
    const pageSetup = defs.find((n) => n.type === 'page_setup')!;
    expect(pageSetup.attrs!['id']).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newDocument().doc.content![1]!.attrs!['pageSetup']).not.toBe(
      d.doc.content![1]!.attrs!['pageSetup'],
    );
    expect(builtInStyleName('Heading1')).toBe('Heading 1');
    expect(builtInStyleName('TOCHeading')).toBe('TOC Heading');
    expect(builtInStyleName('DefaultParagraphFont')).toBe('Default Paragraph Font');
  });
});

describe('preserved payloads (CDM-051; SR-C2)', () => {
  it('lists every preserved attribute, mark and atom with a digest, so a later rule can require that only import creates them', async () => {
    const d = sinkDoc();
    const list = preservedPayloads(d['doc'], '/doc');
    expect(list.map((p) => p.kind).sort()).toEqual(['attribute', 'mark', 'node', 'node']);
    const digests = await preservedDigests(d['doc']);
    expect(digests).toHaveLength(4);
    for (const h of digests) expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Moving a preserved paragraph keeps its digest; changing its tree does not.
    const changed = sinkDoc();
    bodyOf(changed).at(-1)!.attrs.preserved.children[0].attrs[
      '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}val'
    ] = 'top';
    expect(await preservedDigests(changed['doc'])).not.toEqual(digests);
  });
});
