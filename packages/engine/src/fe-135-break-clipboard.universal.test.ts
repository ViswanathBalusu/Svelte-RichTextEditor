/**
 * FE-135 in a browser (lane U-FE-129-141): a page or column break serialised by the editing schema's
 * own `toDOM` (a `span.de-break` with its label) parses back to the same break node, not to its label
 * text. This is the path ProseMirror's own clipboard takes, which the web view keeps for a drag inside
 * the surface (view/web.ts): `DOMSerializer.fromSchema` writes the HTML and `parseFromClipboard`
 * reads it. Run with `pnpm vitest run --project browser <this file>`; in the node project the suite
 * is skipped, as it needs a live document.
 */
import {
  DOMParser,
  DOMSerializer,
  Fragment,
  type Node as PMNode,
  type ResolvedPos,
  type Slice,
} from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import * as pmView from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import { editingSchema } from './schema.ts';

const inBrowser = typeof globalThis.document !== 'undefined';

/** prosemirror-view exports its paste parser for tests, without a type declaration. */
const parseFromClipboard = (
  pmView as unknown as {
    __parseFromClipboard: (
      view: pmView.EditorView,
      text: string,
      html: string | null,
      plainText: boolean,
      $context: ResolvedPos,
    ) => Slice | null;
  }
).__parseFromClipboard;

/** A paragraph `a`, a break of the given kind, then `b`. */
function paragraphWithBreak(kind: string): PMNode {
  const schema = editingSchema();
  return schema.nodes['paragraph']!.create(null, [
    schema.text('a'),
    schema.nodes['break']!.create({ kind }),
    schema.text('b'),
  ]);
}

/** The paragraph's HTML as the schema's serialiser writes it. */
function htmlOf(node: PMNode): string {
  const schema = editingSchema();
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(Fragment.from(node), {
    document: globalThis.document,
  });
  const host = globalThis.document.createElement('div');
  host.append(fragment);
  return host.innerHTML;
}

/**
 * HTML read into an inert document by the browser's parser, as the clipboard's HTML is. No HTML
 * string is assigned to the DOM (FE-067 criterion 1 scans this source too).
 */
function parsedBody(html: string): HTMLElement {
  return new globalThis.DOMParser().parseFromString(html, 'text/html').body;
}

/** The inline children of the first paragraph in a slice, by type name and text. */
function inlineOf(content: Fragment): { type: string; kind?: string; text?: string }[] {
  let paragraph: PMNode | null = null;
  content.descendants((n) => {
    if (paragraph === null && n.type.name === 'paragraph') paragraph = n;
    return paragraph === null;
  });
  const found = paragraph as PMNode | null;
  if (found === null) throw new Error('the parsed slice holds no paragraph');
  const out: { type: string; kind?: string; text?: string }[] = [];
  found.forEach((child) => {
    if (child.isText) out.push({ type: 'text', text: child.text ?? '' });
    else out.push({ type: child.type.name, kind: String(child.attrs['kind']) });
  });
  return out;
}

describe.skipIf(!inBrowser)(
  'FE-135 in a browser: a copied page or column break pastes as a break',
  () => {
    for (const kind of ['page', 'column', 'line']) {
      it(`parses a serialised ${kind} break back to the same break node (schema parser)`, () => {
        const schema = editingSchema();
        const dom = parsedBody(htmlOf(paragraphWithBreak(kind)));
        const slice = DOMParser.fromSchema(schema).parseSlice(dom);
        expect(inlineOf(slice.content)).toEqual([
          { type: 'text', text: 'a' },
          { type: 'break', kind },
          { type: 'text', text: 'b' },
        ]);
      });

      it(`parses a serialised ${kind} break back through ProseMirror's paste parser`, () => {
        const schema = editingSchema();
        const doc = schema.nodes['doc']!.create(null, [
          schema.nodes['paragraph']!.create(null, [schema.text('x')]),
        ]);
        const mount = globalThis.document.createElement('div');
        globalThis.document.body.append(mount);
        const view = new pmView.EditorView(mount, { state: EditorState.create({ doc }) });
        try {
          const html = htmlOf(paragraphWithBreak(kind));
          const slice = parseFromClipboard(view, '', html, false, view.state.doc.resolve(1));
          if (slice === null) throw new Error('the paste parser returned nothing');
          expect(inlineOf(slice.content)).toEqual([
            { type: 'text', text: 'a' },
            { type: 'break', kind },
            { type: 'text', text: 'b' },
          ]);
          expect(slice.content.textBetween(0, slice.content.size)).not.toContain('break');
        } finally {
          view.destroy();
          mount.remove();
        }
      });
    }

    it('does not take a break mark of a kind the schema does not know as a break', () => {
      const schema = editingSchema();
      const doc = globalThis.document;
      const mark = doc.createElement('span');
      mark.className = 'de-break';
      mark.dataset['kind'] = 'section';
      mark.contentEditable = 'false';
      mark.append('Other');
      const paragraph = doc.createElement('p');
      paragraph.append('a', mark, 'b');
      const dom = doc.createElement('div');
      dom.append(paragraph);
      const slice = DOMParser.fromSchema(schema).parseSlice(dom);
      let breaks = 0;
      slice.content.descendants((n) => {
        if (n.type.name === 'break') breaks += 1;
        return true;
      });
      expect(breaks).toBe(0);
      expect(slice.content.textBetween(0, slice.content.size)).toBe('aOtherb');
    });
  },
);
