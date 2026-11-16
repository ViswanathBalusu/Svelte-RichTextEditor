/**
 * SEC-006 criterion 4, the editor's part only (lane w3): the editing schema never draws a picture
 * as live SVG, nor through an element that loads a document (10 §3.1, hostile images). Today an
 * `image` is a labelled placeholder and a `figure` shows its alternative text, so no asset is
 * fetched at all. This test reads what each node and mark of the schema renders to (`toDOM`) and
 * fails when one of them starts to emit `svg`, `object`, `embed`, `iframe` or `use`, or an `img`
 * outside the reviewed list. It does not upload an SVG and shows none: that half of the criterion
 * needs picture display in the editor and an assets port, which are not built.
 */
import type { DOMOutputSpec, Mark, Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { editingSchema } from '../src/schema.ts';

const FORBIDDEN = new Set(['svg', 'object', 'embed', 'iframe', 'frame', 'use', 'foreignobject']);
/** Node types that may render an `img`, each reviewed for how its address is formed. None today. */
const IMG_REVIEWED: ReadonlySet<string> = new Set();

/** The element names of a `toDOM` result that is an array spec; a DOM node result is not expected. */
function tags(spec: DOMOutputSpec, out: string[] = []): string[] {
  if (!Array.isArray(spec)) {
    expect(typeof spec, 'toDOM gives an array spec or text, not a DOM node').toBe('string');
    return out;
  }
  const [name, ...rest] = spec as [string, ...unknown[]];
  out.push(String(name).toLowerCase().replace(/^.*\s/, ''));
  for (const part of rest) if (Array.isArray(part)) tags(part as unknown as DOMOutputSpec, out);
  return out;
}

describe('SEC-006: the editing schema draws no live SVG', () => {
  const schema = editingSchema();
  const asset = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10';

  it('an image and a figure render as text and placeholders, without an address', () => {
    const image = schema.nodes['image']!.create({ asset, alt: '<svg onload=alert(1)>' });
    const spec = schema.nodes['image']!.spec.toDOM!(image);
    expect(tags(spec)).toEqual(['span']);
    expect(JSON.stringify(spec)).not.toContain(asset);
    const figure = schema.nodes['figure']!.createAndFill({ asset, alt: 'A chart' });
    expect(figure).not.toBeNull();
    const figureSpec = schema.nodes['figure']!.spec.toDOM!(figure!);
    expect(tags(figureSpec)).toEqual(['figure', 'div', 'div']);
    expect(JSON.stringify(figureSpec)).not.toContain(asset);
  });

  it('no node or mark of the schema renders svg, object, embed, iframe or use', () => {
    let checked = 0;
    for (const type of Object.values(schema.nodes)) {
      if (!type.spec.toDOM) continue;
      let node: Node | null;
      try {
        node = type.isText ? schema.text('x') : type.createAndFill();
      } catch {
        node = null;
      }
      if (!node) continue;
      const found = tags(type.spec.toDOM(node));
      checked += 1;
      expect(
        found.filter((t) => FORBIDDEN.has(t)),
        type.name,
      ).toEqual([]);
      if (found.includes('img')) expect(IMG_REVIEWED.has(type.name), type.name).toBe(true);
    }
    for (const type of Object.values(schema.marks)) {
      if (!type.spec.toDOM) continue;
      let mark: Mark;
      try {
        mark = type.create();
      } catch {
        continue;
      }
      const found = tags(type.spec.toDOM(mark, true));
      checked += 1;
      expect(
        found.filter((t) => FORBIDDEN.has(t) || t === 'img'),
        type.name,
      ).toEqual([]);
    }
    expect(checked).toBeGreaterThan(20);
  });
});
